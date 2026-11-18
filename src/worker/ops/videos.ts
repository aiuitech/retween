import { env } from "cloudflare:workers";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { composeTimeline } from "../../../shared/compose.ts";
import { EMPTY_STORYBOARD, Scene, Storyboard, StoryboardMusic } from "../../../shared/storyboard.ts";
import { ASPECT_RATIOS, RESOLUTIONS } from "../../../shared/timeline.ts";
import { db, schema } from "../db/client.ts";
import { AppError, badRequest, newId, notFound } from "../lib/util.ts";
import { assetsById } from "../services/assets.ts";
import { getProject } from "../services/projects.ts";
import { createRender, freshTimeline, getRender, renderView } from "../services/renders.ts";
import { deletePrefix } from "../services/storage.ts";
import { getControls, limitResolution } from "../services/controls.ts";
import { assertBudget, projectVideoSpend } from "../services/usage.ts";
import {
	type DetailOptions,
	type RegenerateOptions,
	type Video,
	cancelPipeline,
	composeAndSave,
	emptyResolved,
	getVideo,
	pipelineInputHash,
	planMedia,
	runCompose,
	startPipeline,
	videoCredits,
	videoDetail,
	videoSummary,
} from "../services/videos.ts";
import type { Project } from "../services/projects.ts";
import { defineOp, waitSeconds } from "./registry.ts";

const videoId = z.string().describe("Video id (vid_…)");

/** What video.get and video.prepare include beyond the essentials. Polling with the defaults stays small. */
const detail = {
	storyboard: z.boolean().default(false).describe("Include the whole storyboard (large; you usually have it already)"),
	media: z.enum(["summary", "full"]).default("summary").describe("summary: counts and whatever is not ready yet. full: every scene's narration and visual"),
	timing: z.boolean().default(false).describe("Include each scene's start and length in the composed timeline (video.timing has much more)"),
};
const detailOptions = (input: { storyboard: boolean; media: "summary" | "full"; timing: boolean }): DetailOptions => input;

/** In words, what a preparation run will generate (empty when everything is reused). */
async function preview(videoId: string, userId: string, regenerate: RegenerateOptions) {
	const [first, second] = await Promise.all([planMedia(videoId, userId, 1, regenerate, { dryRun: true }), planMedia(videoId, userId, 2, regenerate, { dryRun: true })]);
	const byKind = new Map<string, string[]>();
	for (const item of [...first.todo, ...second.todo]) {
		const list = byKind.get(item.kind) ?? [];
		list.push(item.sceneId ?? "video");
		byKind.set(item.kind, list);
	}
	return Object.fromEntries([...byKind].map(([kind, scenes]) => [kind, kind === "icon" ? scenes.length : scenes]));
}
const aspect = z.enum(ASPECT_RATIOS);
const resolution = z.enum(RESOLUTIONS);

/** Problems an author should hear about straight away: bad references, and a draft timing. */
async function reviewStoryboard(video: Video, project: Project) {
	const board = video.storyboard;
	const problems: string[] = [];
	const referenced = board.scenes.flatMap((scene) => [
		scene.visual?.assetId,
		scene.visual?.firstFrameAssetId,
		...(scene.visual?.referenceAssetIds ?? []),
		...(scene.sfx ?? []).map((effect) => effect.assetId),
	]);
	if (board.music?.assetId) referenced.push(board.music.assetId);
	const ids = referenced.filter((id): id is string => Boolean(id));
	const found = await assetsById(project.id, ids);
	for (const id of new Set(ids)) if (!found.has(id)) problems.push(`Asset ${id} does not exist in this project`);
	const cast = new Set((project.brand.cast ?? []).map((member) => member.id));
	for (const scene of board.scenes) {
		for (const member of scene.visual?.cast ?? []) {
			if (!cast.has(member)) problems.push(`Scene "${scene.id}": cast member "${member}" is not in the brand kit`);
		}
	}
	const composed = await runCompose(video, project);
	const draft = composed.timeline
		? composed
		: composeTimeline({
				storyboard: board,
				brand: project.brand,
				resolved: video.resolved,
				assets: new Map(
					[...composed.assets].map(([id, asset]) => [
						id,
						{ id, kind: asset.kind, ready: asset.status === "ready", durationSec: asset.durationMs ? asset.durationMs / 1000 : undefined, words: asset.meta.words },
					]),
				),
				draft: true,
			});
	return {
		problems,
		estimatedSeconds: Math.round(draft.durationSec * 10) / 10,
		scenes: draft.scenes.map((scene) => ({ id: scene.id, seconds: Math.round(scene.durationSec * 10) / 10 })),
	};
}

async function saveStoryboard(video: Video, storyboard: Storyboard) {
	const [updated] = await db
		.update(schema.videos)
		.set({ storyboard, status: video.status === "preparing" ? "preparing" : "draft" })
		.where(eq(schema.videos.id, video.id))
		.returning();
	return updated!;
}

/** Polls until the pipeline stops preparing, or the time runs out. */
async function waitWhilePreparing(id: string, seconds: number): Promise<Video> {
	const deadline = Date.now() + seconds * 1000;
	for (;;) {
		const video = (await db.query.videos.findFirst({ where: eq(schema.videos.id, id) }))!;
		if (video.status !== "preparing" || Date.now() >= deadline) return video;
		await new Promise((resolve) => setTimeout(resolve, 2000));
	}
}

export const videoOps = [
	defineOp({
		name: "video.list",
		title: "List videos",
		description: "Videos in a project, most recently updated first, each with what it has cost so far (chargeUsd, as billed).",
		input: z.object({ projectId: z.string() }),
		readOnly: true,
		handler: async (input, { actor }) => {
			const project = await getProject(actor, input.projectId);
			const [rows, spend] = await Promise.all([
				db.query.videos.findMany({ where: eq(schema.videos.projectId, project.id), orderBy: desc(schema.videos.updatedAt) }),
				projectVideoSpend(project.id),
			]);
			return { videos: await Promise.all(rows.map(async (row) => ({ ...(await videoSummary(row)), chargeUsd: spend.get(row.id) ?? 0 }))) };
		},
	}),

	defineOp({
		name: "video.create",
		title: "Create video",
		description:
			"Create a video in a project. Read project.brief first so the script, visuals and voice follow the brand, then write its scenes with storyboard.set.",
		input: z.object({
			projectId: z.string(),
			title: z.string().min(1).max(200),
			brief: z.string().max(4000).optional().describe("Goal, audience and key message of this video"),
			aspect: aspect.optional().describe("The aspect ratio visuals are generated for (other ratios crop from it). Defaults to the brand's first aspect ratio, or 16:9"),
		}),
		handler: async (input, { actor }) => {
			const project = await getProject(actor, input.projectId);
			const [video] = await db
				.insert(schema.videos)
				.values({
					id: newId("vid"),
					projectId: project.id,
					title: input.title,
					brief: input.brief,
					aspect: input.aspect ?? project.brand.format?.aspectRatios?.[0] ?? "16:9",
					storyboard: EMPTY_STORYBOARD,
					resolved: emptyResolved(),
				})
				.returning();
			return { video: await videoSummary(video!), next: "Add scenes with storyboard.set" };
		},
	}),

	defineOp({
		name: "video.get",
		title: "Get video",
		description:
			"A video's status, pipeline progress, media state, composed length, recent renders, " +
			"and what it has cost so far as billed (spend: generated media, including versions it replaced, and renders; previews, drafts and storage are account-wide). " +
			"Kept small for polling: media is summarised (counts, and whatever is not ready, with errors) and the storyboard is left out; " +
			"pass storyboard: true, media: \"full\" or timing: true for more. Use waitSeconds to wait for video.prepare to finish.",
		input: z.object({ videoId, waitSeconds: waitSeconds.default(0), ...detail }),
		readOnly: true,
		handler: async (input, { actor }) => {
			const { video, project } = await getVideo(actor, input.videoId);
			const current = video.status === "preparing" && input.waitSeconds ? await waitWhilePreparing(video.id, input.waitSeconds) : video;
			return { video: await videoDetail(current, project, detailOptions(input)) };
		},
	}),

	defineOp({
		name: "video.update",
		title: "Update video",
		description:
			"Change a video's title, brief, primary aspect ratio or music, without sending the storyboard again. " +
			"`music` is merged into the current settings: e.g. { prompt: \"…\" } to re-score, { assetId } to use an uploaded bed, { model } to change who composes it, " +
			"{ volume, duckedVolume } to rebalance, { enabled: false } for none, or null to go back to the brand's music. " +
			"Run video.prepare after changing the prompt or model (only the music is regenerated), or video.compose after a volume change or a new assetId.",
		input: z.object({
			videoId,
			title: z.string().min(1).max(200).optional(),
			brief: z.string().max(4000).optional(),
			aspect: aspect.optional(),
			music: StoryboardMusic.partial().nullable().optional().describe("Music settings to merge in; null clears them"),
		}),
		handler: async (input, { actor }) => {
			const { video } = await getVideo(actor, input.videoId);
			let storyboard = video.storyboard;
			if (input.music !== undefined) {
				const { music: _old, ...rest } = storyboard;
				const merged = input.music === null ? undefined : { ...storyboard.music, ...input.music };
				// Pointing at an uploaded bed replaces a prompt (and the other way round), so the two never fight.
				if (merged && input.music?.assetId) delete merged.prompt;
				if (merged && input.music?.prompt) delete merged.assetId;
				storyboard = merged ? { ...rest, music: merged } : rest;
				if (merged?.assetId) {
					const found = await assetsById(video.projectId, [merged.assetId]);
					if (!found.has(merged.assetId)) throw badRequest(`Asset ${merged.assetId} does not exist in this project`);
				}
			}
			const [updated] = await db
				.update(schema.videos)
				.set({
					title: input.title ?? video.title,
					brief: input.brief ?? video.brief,
					aspect: input.aspect ?? video.aspect,
					storyboard,
					...(input.music !== undefined && video.status !== "preparing" ? { status: "draft" as const } : {}),
				})
				.where(eq(schema.videos.id, video.id))
				.returning();
			return { video: await videoSummary(updated!), music: updated!.storyboard.music ?? null };
		},
	}),

	defineOp({
		name: "video.delete",
		title: "Delete video",
		description: "Permanently delete a video, its renders and the media generated for its scenes.",
		input: z.object({ videoId }),
		destructive: true,
		handler: async (input, { actor }) => {
			const { video, project } = await getVideo(actor, input.videoId);
			const renders = await db.query.renders.findMany({ where: eq(schema.renders.videoId, video.id) });
			const keys = renders.map((render) => render.r2Key).filter((key): key is string => Boolean(key));
			const generated = [
				...Object.values(video.resolved.narration),
				...Object.values(video.resolved.visual),
				...Object.values(video.resolved.sfx),
				...Object.values(video.resolved.cutout ?? {}),
				...(video.resolved.music ? [video.resolved.music] : []),
				// Icons are left alone: they are shared by every video in the project.
			].map((entry) => entry.assetId);
			const assets = [...(await assetsById(project.id, generated)).values()].filter((asset) => asset.tags.includes("auto"));
			for (const asset of assets) if (asset.r2Key) keys.push(asset.r2Key);
			if (keys.length) await env.MEDIA.delete(keys);
			await deletePrefix(`projects/${project.id}/previews/${video.id}-`);
			for (const asset of assets) await db.delete(schema.assets).where(eq(schema.assets.id, asset.id));
			await db.delete(schema.videos).where(eq(schema.videos.id, video.id));
			return { deleted: video.id };
		},
	}),

	defineOp({
		name: "storyboard.set",
		title: "Set storyboard",
		description:
			"Replace a video's whole storyboard. Keep scene ids stable when revising: media already generated for an unchanged scene is reused. " +
			"Scenes carry no durations; each lasts as long as its narration. Returns a draft timing estimate and any problems found.",
		input: z.object({ videoId, storyboard: Storyboard }),
		handler: async (input, { actor }) => {
			const { video, project } = await getVideo(actor, input.videoId);
			const updated = await saveStoryboard(video, input.storyboard);
			return { video: await videoSummary(updated), review: await reviewStoryboard(updated, project) };
		},
	}),

	defineOp({
		name: "scene.save",
		title: "Add or change a scene",
		description:
			"Add a scene, or replace the scene that has the same id. New scenes go at the end unless afterSceneId or index says otherwise. " +
			"Changing one scene and running video.prepare again regenerates only that scene's media.",
		input: z.object({
			videoId,
			scene: Scene,
			afterSceneId: z.string().optional().describe("Insert the new scene after this one"),
			index: z.number().int().min(0).optional().describe("Or insert at this position (0 = first)"),
		}),
		handler: async (input, { actor }) => {
			const { video, project } = await getVideo(actor, input.videoId);
			const scenes = [...video.storyboard.scenes];
			const existing = scenes.findIndex((scene) => scene.id === input.scene.id);
			if (existing >= 0) scenes[existing] = input.scene;
			else if (input.afterSceneId) {
				const after = scenes.findIndex((scene) => scene.id === input.afterSceneId);
				if (after < 0) throw notFound(`Scene "${input.afterSceneId}"`);
				scenes.splice(after + 1, 0, input.scene);
			} else scenes.splice(input.index ?? scenes.length, 0, input.scene);
			const parsed = Storyboard.safeParse({ ...video.storyboard, scenes });
			if (!parsed.success) {
				throw badRequest(`Invalid scene: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
			}
			const storyboard = parsed.data;
			const updated = await saveStoryboard(video, storyboard);
			return { sceneIds: scenes.map((scene) => scene.id), review: await reviewStoryboard(updated, project) };
		},
	}),

	defineOp({
		name: "scene.remove",
		title: "Remove a scene",
		description: "Remove a scene from the storyboard.",
		input: z.object({ videoId, sceneId: z.string() }),
		handler: async (input, { actor }) => {
			const { video } = await getVideo(actor, input.videoId);
			const scenes = video.storyboard.scenes.filter((scene) => scene.id !== input.sceneId);
			if (scenes.length === video.storyboard.scenes.length) throw notFound(`Scene "${input.sceneId}"`);
			await saveStoryboard(video, { ...video.storyboard, scenes });
			return { sceneIds: scenes.map((scene) => scene.id) };
		},
	}),

	defineOp({
		name: "scene.move",
		title: "Reorder a scene",
		description: "Move a scene to a new position in the storyboard.",
		input: z.object({ videoId, sceneId: z.string(), index: z.number().int().min(0).describe("New position (0 = first)") }),
		handler: async (input, { actor }) => {
			const { video } = await getVideo(actor, input.videoId);
			const scenes = [...video.storyboard.scenes];
			const from = scenes.findIndex((scene) => scene.id === input.sceneId);
			if (from < 0) throw notFound(`Scene "${input.sceneId}"`);
			const [scene] = scenes.splice(from, 1);
			scenes.splice(Math.min(input.index, scenes.length), 0, scene!);
			await saveStoryboard(video, { ...video.storyboard, scenes });
			return { sceneIds: scenes.map((item) => item.id) };
		},
	}),

	defineOp({
		name: "video.estimate",
		title: "Estimate a video",
		description:
			"Free. The video's expected length scene by scene, and exactly what video.prepare would generate (and so what it would cost): " +
			"narration, images, vector illustrations, cut-outs, icons, stock lookups, clips and music. Check this before preparing, especially when the storyboard uses generated clips.",
		input: z.object({ videoId }),
		readOnly: true,
		handler: async (input, { actor }) => {
			const { video, project } = await getVideo(actor, input.videoId);
			const [first, second, review] = await Promise.all([
				planMedia(video.id, actor.id, 1, {}, { dryRun: true }),
				planMedia(video.id, actor.id, 2, {}, { dryRun: true }),
				reviewStoryboard(video, project),
			]);
			const todo = [...first.todo, ...second.todo];
			const sum = (kind: string) => todo.filter((item) => item.kind === kind).reduce((total, item) => total + (item.units ?? 0), 0);
			const count = (kind: string) => todo.filter((item) => item.kind === kind).length;
			return {
				...review,
				toGenerate: {
					narration: { scenes: count("narration"), characters: sum("narration") },
					images: count("image"),
					vectors: count("vector"),
					cutouts: count("cutout"),
					icons: count("icon"),
					stock: count("stock"),
					clips: { count: count("clip"), seconds: sum("clip") },
					soundEffects: count("sfx"),
					music: count("music") ? { seconds: sum("music") } : null,
				},
				...([...first.problems, ...second.problems].length ? { mediaProblems: [...first.problems, ...second.problems] } : {}),
				note: todo.length
					? "Generated clips cost far more than anything else here. Everything else is cheap (icons, charts and maps are free)."
					: "Nothing to generate: all media for the current storyboard already exists.",
			};
		},
	}),

	defineOp({
		name: "video.prepare",
		title: "Prepare a video",
		description:
			"Generate everything the storyboard needs and compose the timeline. Narration, stills, stock and sound effects are produced first; " +
			"once the voice has landed, clips and music are sized to it, and every scene, bullet and caption is timed to the recorded audio. " +
			"Only what changed since the last run is regenerated (a scene's narration text, voice or speed; a visual prompt; the music prompt or model); " +
			"`willGenerate` lists it. Spends generation budget. Takes from a few seconds to a few minutes: " +
			"if it is still running when this returns, call video.get with waitSeconds until status is ready or failed. " +
			"Calling it again while a run is going restarts the run with the latest storyboard (media already in flight is kept); video.cancel stops it. " +
			"Music never holds the video up: a bed that is still being composed is added when it lands (pipeline.musicPending).",
		input: z.object({
			videoId,
			regenerate: z
				.object({
					narration: z.boolean().optional().describe("Re-voice even if the text is unchanged"),
					visuals: z.boolean().optional().describe("Re-roll images, clips and stock picks"),
					music: z.boolean().optional(),
					sceneIds: z.array(z.string()).optional().describe("Limit re-generation to these scenes"),
				})
				.optional()
				.describe("Force new takes of media that would otherwise be reused"),
			waitSeconds,
			...detail,
		}),
		paid: true,
		handler: async (input, { actor }) => {
			const { video, project } = await getVideo(actor, input.videoId);
			if (!video.storyboard.scenes.length) throw badRequest("The storyboard has no scenes yet. Add them with storyboard.set or scene.save.");
			const regenerate = input.regenerate ?? {};
			const inputHash = await pipelineInputHash(video, project.brand, regenerate);
			const running = video.status === "preparing" && Date.now() - (video.pipeline.startedAt ?? 0) < 45 * 60_000;
			// The same request again just follows the run in progress; anything changed (or forced) restarts it.
			const following = running && video.pipeline.inputHash === inputHash && !Object.keys(regenerate).length;
			const willGenerate = following ? undefined : await preview(video.id, actor.id, regenerate);
			if (!following) {
				await assertBudget(actor);
				await startPipeline(video, actor.id, { regenerate, inputHash });
			}
			const current = await waitWhilePreparing(video.id, input.waitSeconds);
			const notes = [
				running && !following ? "A run was already going; it was restarted with the current storyboard." : "",
				current.status === "preparing" ? "Still preparing. Call video.get with waitSeconds to follow it." : "",
			].filter(Boolean);
			return {
				...(willGenerate ? { willGenerate } : { following: "A run with the same storyboard is already going; this follows it." }),
				video: await videoDetail(current, project, detailOptions(input)),
				...(notes.length ? { note: notes.join(" ") } : {}),
			};
		},
	}),

	defineOp({
		name: "video.cancel",
		title: "Stop preparing",
		description:
			"Stop a video.prepare that is running: the run stops and media it is still waiting for (narration, visuals, a slow music bed) is abandoned and marked failed, " +
			"so the next video.prepare makes it afresh. The video keeps its last composed timeline, if it had one. Work a vendor had already started may still be charged.",
		input: z.object({ videoId }),
		handler: async (input, { actor }) => {
			const { video, project } = await getVideo(actor, input.videoId);
			const result = await cancelPipeline(video, project);
			const updated = (await db.query.videos.findFirst({ where: eq(schema.videos.id, video.id) }))!;
			return {
				...result,
				status: updated.status,
				note: result.stopped || result.abandoned.length ? "Stopped." : "Nothing was being prepared.",
			};
		},
	}),

	defineOp({
		name: "video.compose",
		title: "Recompose the timeline",
		description:
			"Rebuild the timeline from media that already exists, without generating anything. Use after changing on-screen text, layout, transitions, " +
			"captions or brand styling. If narration or visuals changed, run video.prepare instead.",
		input: z.object({ videoId }),
		handler: async (input, { actor }) => {
			const { video, project } = await getVideo(actor, input.videoId);
			const result = await composeAndSave(video, project);
			if (!result.timeline) {
				throw new AppError(409, `Cannot compose yet: ${result.errors.join("; ")}. Run video.prepare to generate the missing media.`, "not_ready", {
					errors: result.errors,
				});
			}
			return { durationSec: result.durationSec, scenes: result.scenes, warnings: result.warnings };
		},
	}),

	defineOp({
		name: "video.render",
		title: "Render a video",
		description:
			"Export the composed video as MP4. The soundtrack is levelled to the brand's loudness target (default -14 LUFS, peaks under -1 dBTP; see `loudness`). " +
			"Render one aspect ratio and resolution, or pass `exports` for several at once: " +
			"the same timeline is laid out afresh for each aspect ratio. Rendering takes roughly as long as the video for 1080p. " +
			"Follow progress with render.get; the finished render has a download link.",
		input: z.object({
			videoId,
			aspect: aspect.optional().describe("Defaults to the video's primary aspect ratio"),
			resolution: resolution.optional().describe("Short side in pixels. Defaults to the brand's resolution, or 1080p"),
			exports: z.array(z.object({ aspect, resolution: resolution.default("1080p") })).min(1).max(8).optional().describe("Several exports in one call"),
			loudness: z
				.union([z.number().min(-30).max(-9), z.literal("off")])
				.optional()
				.describe('Level the soundtrack to this integrated loudness (LUFS), peaks under -1 dBTP. Defaults to the brand\'s audio.loudness, else -14. "off" keeps the mix as it is'),
			waitSeconds,
		}),
		paid: true,
		handler: async (input, { actor }) => {
			const { video, project } = await getVideo(actor, input.videoId);
			if (video.status === "preparing") throw new AppError(409, "This video is still being prepared. Wait for video.get to report ready.", "not_ready");
			await assertBudget(actor);
			const controls = await getControls(actor.id);
			const notes = new Set<string>();
			const targets = (
				input.exports ?? [{ aspect: input.aspect ?? video.aspect, resolution: input.resolution ?? project.brand.format?.resolution ?? "1080p" }]
			).map((target) => {
				const limited = limitResolution(controls, target.resolution);
				if (limited.note) notes.add(limited.note);
				return { ...target, resolution: limited.resolution };
			});
			const timeline = await freshTimeline(video, project);
			const renders = [];
			for (const target of targets) renders.push(await createRender(actor, video, project, { ...target, loudness: input.loudness }, timeline));

			const deadline = Date.now() + input.waitSeconds * 1000;
			let current = renders;
			while (Date.now() < deadline) {
				current = await Promise.all(renders.map(async (render) => (await db.query.renders.findFirst({ where: eq(schema.renders.id, render.id) })) ?? render));
				if (current.every((render) => ["done", "failed", "cancelled"].includes(render.status))) break;
				await new Promise((resolve) => setTimeout(resolve, 2500));
			}
			return {
				renders: await Promise.all(current.map((render) => renderView(render, video.title))),
				note: ["Rendering continues in the background. Use render.get with waitSeconds to follow it.", ...notes].join(" "),
			};
		},
	}),

	defineOp({
		name: "video.credits",
		title: "Credits for a video",
		description: "The third-party media a video uses, with licences, and the credit lines that must accompany it when published.",
		input: z.object({ videoId }),
		readOnly: true,
		handler: async (input, { actor }) => {
			const { video, project } = await getVideo(actor, input.videoId);
			return videoCredits(video, project);
		},
	}),

	defineOp({
		name: "render.list",
		title: "List renders",
		description: "Exports of a video, newest first, with download links for the finished ones.",
		input: z.object({ videoId }),
		readOnly: true,
		handler: async (input, { actor }) => {
			const { video } = await getVideo(actor, input.videoId);
			const rows = await db.query.renders.findMany({ where: eq(schema.renders.videoId, video.id), orderBy: desc(schema.renders.createdAt), limit: 50 });
			return { renders: await Promise.all(rows.map((render) => renderView(render, video.title))) };
		},
	}),

	defineOp({
		name: "render.get",
		title: "Get render",
		description: "A render's status and progress, and its download link once it is done. Use waitSeconds to wait for it.",
		input: z.object({ renderId: z.string(), waitSeconds: waitSeconds.default(0) }),
		readOnly: true,
		handler: async (input, { actor }) => {
			let { render } = await getRender(actor, input.renderId);
			const deadline = Date.now() + input.waitSeconds * 1000;
			while (!["done", "failed", "cancelled"].includes(render.status) && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 2500));
				render = (await db.query.renders.findFirst({ where: eq(schema.renders.id, render.id) })) ?? render;
			}
			const video = await db.query.videos.findFirst({ where: eq(schema.videos.id, render.videoId) });
			return { render: await renderView(render, video?.title) };
		},
	}),

	defineOp({
		name: "render.cancel",
		title: "Cancel render",
		description: "Stop a render that is queued or in progress.",
		input: z.object({ renderId: z.string() }),
		handler: async (input, { actor }) => {
			const { render } = await getRender(actor, input.renderId);
			if (["done", "failed", "cancelled"].includes(render.status)) return { render: await renderView(render) };
			const [updated] = await db.update(schema.renders).set({ status: "cancelled", finishedAt: new Date() }).where(eq(schema.renders.id, render.id)).returning();
			return { render: await renderView(updated!) };
		},
	}),

	defineOp({
		name: "render.delete",
		title: "Delete render",
		description: "Delete a render and its file.",
		input: z.object({ renderId: z.string() }),
		destructive: true,
		handler: async (input, { actor }) => {
			const { render } = await getRender(actor, input.renderId);
			if (render.r2Key) await env.MEDIA.delete(render.r2Key);
			await db.delete(schema.renders).where(eq(schema.renders.id, render.id));
			return { deleted: render.id };
		},
	}),
];
