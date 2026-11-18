/**
 * Takes a video from storyboard to timeline (and optionally to finished
 * exports), in the order that makes timing trustworthy:
 *
 *   1. narration, stills, stock and sound effects are generated
 *   2. once the voice has landed, clips and music are sized to it
 *   3. if the storyboard changed meanwhile, whatever that needs is generated too
 *   4. the timeline is composed from the measured media
 *   5. renders are started
 *
 * Music never holds the video up: if the bed is still being composed when
 * everything else is ready, the timeline is composed without it, and composed
 * again with it once it lands.
 *
 * ElevenLabs refuses more simultaneous requests than the plan allows, so its
 * jobs are started a few at a time (ELEVENLABS_CONCURRENCY) and the rest wait
 * their turn; other media starts at once.
 */
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep, env } from "cloudflare:workers";
import { eq, inArray } from "drizzle-orm";
import { isOpenRouterModel } from "../../../shared/audio-models.ts";
import type { AspectRatio, Resolution } from "../../../shared/timeline.ts";
import { actorById } from "../auth/index.ts";
import { db, schema } from "../db/client.ts";
import type { GenerationSpec, PipelineState } from "../db/schema.ts";
import { failureMessage } from "../lib/util.ts";
import { startGeneration } from "../services/assets.ts";
import { createRender } from "../services/renders.ts";
import { type RegenerateOptions, composeAndSave, loadVideo, planMedia } from "../services/videos.ts";

export interface PipelineParams {
	videoId: string;
	userId: string;
	regenerate: RegenerateOptions;
	renders: { aspect: AspectRatio; resolution: Resolution }[];
}

/** How long a finished video waits for its music bed before composing without it (checks 8 s apart). */
const MUSIC_GRACE_CHECKS = 20;
/** How long the pipeline keeps waiting for a late music bed after composing (checks 15 s apart). */
const LATE_MUSIC_CHECKS = 60;

/** Media that goes to ElevenLabs, and so counts against its concurrency limit. */
export function usesElevenLabs(spec: GenerationSpec | null | undefined): boolean {
	if (!spec) return false;
	if (spec.type === "speech") return !isOpenRouterModel(spec.modelId);
	if (spec.type === "music") return !spec.model || spec.model === "elevenlabs";
	return spec.type === "sfx";
}

/** Updates this run's progress. Does nothing once another run (or video.cancel) has taken over the video. */
async function setPipeline(videoId: string, instanceId: string, patch: PipelineState, status?: "preparing" | "ready" | "failed") {
	const video = await db.query.videos.findFirst({ where: eq(schema.videos.id, videoId) });
	if (!video || (video.pipeline.instanceId && video.pipeline.instanceId !== instanceId)) return;
	await db
		.update(schema.videos)
		.set({ pipeline: { ...video.pipeline, ...patch }, ...(status ? { status } : {}) })
		.where(eq(schema.videos.id, videoId));
}

export class PipelineWorkflow extends WorkflowEntrypoint<Env, PipelineParams> {
	async run(event: WorkflowEvent<PipelineParams>, step: WorkflowStep) {
		const { videoId, userId, regenerate, renders } = event.payload;
		const instanceId = event.instanceId;
		const progress = (patch: PipelineState, status?: "preparing" | "ready" | "failed") => setPipeline(videoId, instanceId, patch, status);
		const limit = Math.max(1, Number(env.ELEVENLABS_CONCURRENCY) || 3);
		const problems: string[] = [];
		/** The music bed this run is waiting on, if it was still being composed when everything else was ready. */
		let lateMusic: string | undefined;

		/**
		 * Plans one phase, starts its generations (ElevenLabs ones a few at a time) and waits until none
		 * is pending. Music may be left running (see `lateMusic`). Returns how many assets it created.
		 */
		const generate = async (label: string, phase: 1 | 2, force: RegenerateOptions): Promise<number> => {
			if (phase === 2) lateMusic = undefined;
			const plan = await step.do(`plan ${label}`, () => planMedia(videoId, userId, phase, force));
			problems.push(...plan.problems);
			if (!plan.pending.length) return 0;
			const lanes = await step.do(`lanes ${label}`, async () => {
				const rows = await db.query.assets.findMany({ where: inArray(schema.assets.id, plan.pending) });
				return {
					throttled: rows.filter((row) => usesElevenLabs(row.generation)).map((row) => row.id),
					music: rows.filter((row) => row.generation?.type === "music" || row.tags.includes("music")).map((row) => row.id),
				};
			});
			const throttled = new Set(lanes.throttled);
			const music = new Set(lanes.music);
			// Everything pending, not just what this plan created: an earlier run that was stopped may have left
			// assets queued but never started. Starting one that is already running does nothing.
			const waiting = [...plan.pending];
			const started: string[] = [];
			// Exports need the finished soundtrack, so a run that renders waits for the music however long it takes.
			let graceLeft = renders.length ? Number.POSITIVE_INFINITY : MUSIC_GRACE_CHECKS;

			for (let i = 0; i < 600; i++) {
				const state = await step.do(`check ${label} ${i}`, async () => {
					const rows = await db.query.assets.findMany({ where: inArray(schema.assets.id, plan.pending) });
					const pending = rows.filter((row) => row.status === "pending").map((row) => row.id);
					await progress({
						stage: "assets",
						message: `Generating ${label} (${rows.length - pending.length}/${rows.length})`,
						total: rows.length,
						completed: rows.length - pending.length,
					});
					return { pending, failed: rows.filter((row) => row.status === "failed").map((row) => `${row.name}: ${row.error ?? "failed"}`) };
				});
				const pending = new Set(state.pending);

				// Start what may start now: everything not bound for ElevenLabs, and ElevenLabs jobs up to the limit.
				const busy = started.filter((id) => throttled.has(id) && pending.has(id)).length;
				const batch: string[] = [];
				let slots = limit - busy;
				for (const id of [...waiting]) {
					if (throttled.has(id)) {
						if (slots <= 0) continue;
						slots--;
					}
					batch.push(id);
					waiting.splice(waiting.indexOf(id), 1);
				}
				if (batch.length) {
					await step.do(`start ${label} ${i}`, async () => {
						await Promise.all(batch.map((id) => startGeneration({ id })));
					});
					started.push(...batch);
				}

				const blocking = state.pending.filter((id) => !music.has(id));
				if (!waiting.length && !blocking.length) {
					const musicPending = state.pending.filter((id) => music.has(id));
					if (!musicPending.length) {
						problems.push(...state.failed);
						return plan.created.length;
					}
					if (graceLeft-- <= 0) {
						problems.push(...state.failed);
						lateMusic = musicPending[0];
						return plan.created.length;
					}
				}
				await step.sleep(`wait ${label} ${i}`, i < 20 ? "3 seconds" : "8 seconds");
			}
			problems.push(`Timed out waiting for ${label}`);
			return plan.created.length;
		};

		try {
			// A storyboard edited while this runs (without a new video.prepare) would otherwise be composed with
			// media made for the old one. So after generating, plan again: what the edit needs, and anything that
			// failed for a passing reason (a rate limit, a timeout), gets one more round before composing.
			let force = regenerate;
			for (let round = 0; round < 2; round++) {
				const suffix = round ? " (second pass)" : "";
				await generate(`voice and visuals${suffix}`, 1, force);
				await generate(`clips and music${suffix}`, 2, force);
				force = {};
				if (round === 1) break;
				const drift = await step.do(`recheck ${round}`, async () => {
					const [first, second] = await Promise.all([planMedia(videoId, userId, 1, {}, { dryRun: true }), planMedia(videoId, userId, 2, {}, { dryRun: true })]);
					return first.todo.length + second.todo.length;
				});
				if (!drift) break;
			}

			// The person's own footage is timed from its transcript, so it has to have finished processing.
			for (let i = 0; i < 400; i++) {
				const processing = await step.do(`check footage ${i}`, async () => {
					const { video } = await loadVideo(videoId);
					const ids = [...new Set(video.storyboard.scenes.map((scene) => scene.footage?.assetId).filter((id): id is string => Boolean(id)))];
					if (!ids.length) return 0;
					const rows = await db.query.assets.findMany({ where: inArray(schema.assets.id, ids) });
					const busy = rows.filter((row) => (row.meta.footage as { status?: string } | undefined)?.status === "processing").length;
					if (busy) await progress({ stage: "assets", message: `Waiting for ${busy} recording${busy === 1 ? "" : "s"} to finish processing` });
					return busy;
				});
				if (!processing) break;
				await step.sleep(`wait footage ${i}`, "10 seconds");
			}

			const composed = await step.do("compose", async () => {
				await progress({ stage: "compose", message: "Timing scenes to the audio" });
				const { video, project } = await loadVideo(videoId);
				if (video.pipeline.instanceId && video.pipeline.instanceId !== instanceId) return { ok: false, superseded: true, errors: [], warnings: [], durationSec: 0 };
				const result = await composeAndSave(video, project);
				return { ok: Boolean(result.timeline), superseded: false, errors: result.errors, warnings: result.warnings, durationSec: result.durationSec };
			});
			if (composed.superseded) return;
			if (!composed.ok) {
				const reasons = [...problems, ...composed.errors.filter((error) => !problems.length || !/not been generated/.test(error))];
				await step.do("mark failed", () => progress({ stage: "compose", error: reasons.join("; ") || "Could not compose the video", finishedAt: Date.now() }, "failed"));
				return;
			}

			if (renders.length) {
				await step.do("start renders", async () => {
					const actor = await actorById(userId, "session");
					if (!actor) return;
					const { video, project } = await loadVideo(videoId);
					for (const target of renders) await createRender(actor, video, project, target);
					await progress({ stage: "render", message: `Rendering ${renders.length} export(s)` });
				});
			}
			const musicNote = lateMusic
				? `The music bed (${lateMusic}) is still being composed, so the timeline was composed without it; it is added automatically when it lands (video.get shows pipeline.musicPending until then).`
				: undefined;
			await step.do("finish", () =>
				progress({
					stage: "done",
					message: renders.length ? "Composed; exports are rendering" : "Composed and ready to render",
					warnings: [...new Set([...problems, ...composed.warnings, ...(musicNote ? [musicNote] : [])])],
					musicPending: Boolean(lateMusic),
					finishedAt: Date.now(),
				}),
			);

			if (lateMusic && !renders.length) await this.addLateMusic(step, videoId, instanceId, lateMusic);
		} catch (error) {
			const message = failureMessage(error, "video preparation");
			await step.do("mark errored", () => progress({ error: message, finishedAt: Date.now() }, "failed"));
		}
	}

	/** Waits for a music bed that missed the first compose, then composes again with it. */
	private async addLateMusic(step: WorkflowStep, videoId: string, instanceId: string, assetId: string) {
		for (let i = 0; i < LATE_MUSIC_CHECKS; i++) {
			await step.sleep(`wait for music ${i}`, "15 seconds");
			const status = await step.do(`check music ${i}`, async () => {
				const row = await db.query.assets.findFirst({ where: eq(schema.assets.id, assetId) });
				return row?.status ?? "missing";
			});
			if (status === "pending") continue;
			await step.do("add music", async () => {
				const { video, project } = await loadVideo(videoId);
				// Only if nothing has happened to the video since: no new run, no cancellation, no change of music.
				if (video.pipeline.instanceId !== instanceId || video.status !== "ready" || video.resolved.music?.assetId !== assetId) return;
				const warnings = (video.pipeline.warnings ?? []).filter((warning) => !warning.includes(assetId));
				if (status === "ready") {
					const result = await composeAndSave(video, project);
					if (!result.timeline) return;
					warnings.push(...result.warnings.filter((warning) => !warnings.includes(warning)));
				} else {
					warnings.push(`The music bed could not be composed (${status}); the video has no music. Run video.prepare to try again.`);
				}
				const fresh = await db.query.videos.findFirst({ where: eq(schema.videos.id, videoId) });
				await db
					.update(schema.videos)
					.set({ pipeline: { ...fresh!.pipeline, musicPending: false, warnings } })
					.where(eq(schema.videos.id, videoId));
			});
			return;
		}
		await step.do("music gave up", async () => {
			const video = await db.query.videos.findFirst({ where: eq(schema.videos.id, videoId) });
			const warnings = (video?.pipeline.warnings ?? []).filter((warning) => !warning.includes(assetId));
			warnings.push(`The music bed (${assetId}) took too long; the video has no music. Run video.prepare to try again, or pick a faster music model (audio.musicModel).`);
			await setPipeline(videoId, instanceId, { musicPending: false, warnings });
		});
	}
}
