/**
 * Takes a video from storyboard to timeline (and optionally to finished
 * exports), in the order that makes timing trustworthy:
 *
 *   1. narration, stills, stock and sound effects are generated
 *   2. once the voice has landed, clips and music are sized to it
 *   3. the timeline is composed from the measured media
 *   4. renders are started
 */
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { eq, inArray } from "drizzle-orm";
import type { AspectRatio, Resolution } from "../../../shared/timeline.ts";
import { actorById } from "../auth/index.ts";
import { db, schema } from "../db/client.ts";
import type { PipelineState } from "../db/schema.ts";
import { startGeneration } from "../services/assets.ts";
import { createRender } from "../services/renders.ts";
import { type RegenerateOptions, composeAndSave, loadVideo, planMedia } from "../services/videos.ts";

export interface PipelineParams {
	videoId: string;
	userId: string;
	regenerate: RegenerateOptions;
	renders: { aspect: AspectRatio; resolution: Resolution }[];
}

async function setPipeline(videoId: string, patch: PipelineState, status?: "preparing" | "ready" | "failed") {
	const video = await db.query.videos.findFirst({ where: eq(schema.videos.id, videoId) });
	if (!video) return;
	await db
		.update(schema.videos)
		.set({ pipeline: { ...video.pipeline, ...patch }, ...(status ? { status } : {}) })
		.where(eq(schema.videos.id, videoId));
}

export class PipelineWorkflow extends WorkflowEntrypoint<Env, PipelineParams> {
	async run(event: WorkflowEvent<PipelineParams>, step: WorkflowStep) {
		const { videoId, userId, regenerate, renders } = event.payload;
		const problems: string[] = [];

		/** Starts generation for a plan and waits until none of its assets is pending. */
		const generate = async (label: string, phase: 1 | 2) => {
			const plan = await step.do(`plan ${label}`, () => planMedia(videoId, userId, phase, regenerate));
			problems.push(...plan.problems);
			if (!plan.pending.length) return;
			await step.do(`start ${label}`, async () => {
				await Promise.all(plan.created.map((id) => startGeneration({ id })));
			});
			for (let i = 0; i < 600; i++) {
				const state = await step.do(`check ${label} ${i}`, async () => {
					const rows = await db.query.assets.findMany({ where: inArray(schema.assets.id, plan.pending) });
					const pending = rows.filter((row) => row.status === "pending").length;
					await setPipeline(videoId, {
						stage: "assets",
						message: `Generating ${label} (${rows.length - pending}/${rows.length})`,
						total: rows.length,
						completed: rows.length - pending,
					});
					return { pending, failed: rows.filter((row) => row.status === "failed").map((row) => `${row.name}: ${row.error ?? "failed"}`) };
				});
				if (state.pending === 0) {
					problems.push(...state.failed);
					return;
				}
				await step.sleep(`wait ${label} ${i}`, i < 20 ? "3 seconds" : "8 seconds");
			}
			problems.push(`Timed out waiting for ${label}`);
		};

		try {
			await generate("voice and visuals", 1);
			await generate("clips and music", 2);

			const composed = await step.do("compose", async () => {
				await setPipeline(videoId, { stage: "compose", message: "Timing scenes to the audio" });
				const { video, project } = await loadVideo(videoId);
				const result = await composeAndSave(video, project);
				return { ok: Boolean(result.timeline), errors: result.errors, warnings: result.warnings, durationSec: result.durationSec };
			});
			if (!composed.ok) {
				const reasons = [...problems, ...composed.errors.filter((error) => !problems.length || !/not been generated/.test(error))];
				await step.do("mark failed", () =>
					setPipeline(videoId, { stage: "compose", error: reasons.join("; ") || "Could not compose the video", finishedAt: Date.now() }, "failed"),
				);
				return;
			}

			if (renders.length) {
				await step.do("start renders", async () => {
					const actor = await actorById(userId, "session");
					if (!actor) return;
					const { video, project } = await loadVideo(videoId);
					for (const target of renders) await createRender(actor, video, project, target);
					await setPipeline(videoId, { stage: "render", message: `Rendering ${renders.length} export(s)` });
				});
			}
			await step.do("finish", () =>
				setPipeline(videoId, {
					stage: "done",
					message: renders.length ? "Composed; exports are rendering" : "Composed and ready to render",
					warnings: [...problems, ...composed.warnings],
					finishedAt: Date.now(),
				}),
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await step.do("mark errored", () => setPipeline(videoId, { error: message, finishedAt: Date.now() }, "failed"));
		}
	}
}
