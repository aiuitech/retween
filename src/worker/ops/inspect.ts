/**
 * Operations for checking work cheaply while iterating on a video: look at
 * frames, whole videos and assets as images, read the timing as text, measure
 * the sound, and cut quick low-resolution drafts.
 */
import { z } from "zod";
import { type Issue, audioIssues, clock, cueSheet, fitIssues, pacingIssues, round2, sceneAt, sceneRange, settledFrame, sortIssues, spreadFrames } from "../../../shared/inspect.ts";
import { masterLoudness } from "../../../shared/audio-models.ts";
import { Scene } from "../../../shared/storyboard.ts";
import { ASPECT_RATIOS, type AspectRatio, type Timeline, dimensionsFor } from "../../../shared/timeline.ts";
import { AppError, badRequest, bytesToBase64, newId, notFound } from "../lib/util.ts";
import { getAsset } from "../services/assets.ts";
import { type SheetTile, analyseAudio, draftStatus, inspectTimeline, renderSheet, startDraft } from "../services/inspect.ts";
import type { Project } from "../services/projects.ts";
import { signedUrl } from "../services/storage.ts";
import { assertBudget } from "../services/usage.ts";
import { type Video, getVideo, runCompose } from "../services/videos.ts";
import { INLINE_IMAGE, defineOp, waitSeconds } from "./registry.ts";

const videoId = z.string().describe("Video id (vid_…)");
const aspect = z.enum(ASPECT_RATIOS);
/** Most frames one sheet holds (the renderer's limit). */
const MAX_TILES = 32;
/** Longest draft cut, in seconds. */
const MAX_DRAFT_SECONDS = 180;

/** Tile height that keeps a sheet readable for each shape: portrait tiles get taller so their text is legible. */
const TILE_HEIGHT: Record<AspectRatio, number> = { "16:9": 200, "1:1": 240, "4:5": 260, "9:16": 320 };

/** Missing media in a draft is expected; say it once instead of once per scene. */
function condense(warnings: string[]): string[] {
	const pending = warnings.filter((warning) => /has not been generated yet/.test(warning));
	const rest = warnings.filter((warning) => !/has not been generated yet/.test(warning));
	return pending.length
		? [`${pending.length} piece${pending.length === 1 ? "" : "s"} of media ha${pending.length === 1 ? "s" : "ve"} not been generated yet: timings are estimated and missing visuals show the brand backdrop. Run video.prepare for the real thing.`, ...rest]
		: rest;
}

/**
 * What a cue sheet's numbers rest on. While narration is still being voiced some scenes have real word
 * timings and others are estimated: say which, rather than one blanket statement that contradicts the words shown.
 */
function timingNote(scenes: { id: string; estimated?: true; narration?: unknown }[], draft: boolean, preparing: boolean) {
	if (!draft) return {};
	const estimated = scenes.filter((scene) => scene.estimated).map((scene) => scene.id);
	const voiced = scenes.filter((scene) => scene.narration).length;
	const progress = preparing ? " video.prepare is still running; ask again when it finishes." : " Run video.prepare to voice them.";
	if (!estimated.length) {
		return { draft: true, note: `Narration timings are real; some other media is not generated yet, so missing visuals show the brand backdrop.${preparing ? " video.prepare is still running." : ""}` };
	}
	return {
		draft: true,
		estimatedScenes: estimated,
		note:
			(voiced
				? `${voiced} scene${voiced === 1 ? " is" : "s are"} voiced and timed to the recording (word times are real). ` +
					`${estimated.length} ${estimated.length === 1 ? "is" : "are"} not voiced yet (estimatedScenes): their times are estimated from the word count and everything after them may shift.`
				: "No narration has been voiced yet: every time here is estimated from word counts, and there are no word timings.") + progress,
	};
}

const settled = (timeline: Timeline, sceneId: string | undefined) => {
	const scene = sceneId ? timeline.scenes.find((candidate) => candidate.id === sceneId) : timeline.scenes[0];
	if (!scene) throw notFound(`Scene "${sceneId}"`);
	return { scene, frame: settledFrame(scene, timeline.fps) };
};

function checkSceneIds(timeline: Timeline, sceneIds: string[] | undefined) {
	for (const id of sceneIds ?? []) if (!timeline.scenes.some((scene) => scene.id === id)) throw notFound(`Scene "${id}"`);
}

/** Frame range [first, last] from scene ids or seconds; the whole video when neither is given. */
function frameRange(timeline: Timeline, input: { sceneIds?: string[]; fromSeconds?: number; toSeconds?: number }): [number, number] {
	const last = timeline.durationInFrames - 1;
	if (input.sceneIds?.length) {
		checkSceneIds(timeline, input.sceneIds);
		return sceneRange(timeline, input.sceneIds)!;
	}
	const first = Math.min(last, Math.max(0, Math.round((input.fromSeconds ?? 0) * timeline.fps)));
	const end = input.toSeconds === undefined ? last : Math.min(last, Math.round(input.toSeconds * timeline.fps));
	if (end <= first) throw badRequest(`The range is empty: the video is ${clock(timeline.durationInFrames / timeline.fps)} long`);
	return [first, end];
}

/** One contact sheet per batch of scenes for an aspect ratio, collecting what didn't fit. */
async function layoutSheets(actor: Parameters<typeof renderSheet>[0], video: Video, project: Project, timeline: Timeline, target: AspectRatio, sceneIds?: string[]) {
	const scenes = timeline.scenes.filter((scene) => !sceneIds || sceneIds.includes(scene.id));
	const size = dimensionsFor(target, "720p");
	const sheets: { aspect: AspectRatio; url: string }[] = [];
	const issues: Issue[] = [];
	const warnings: string[] = [];
	for (let offset = 0; offset < scenes.length; offset += MAX_TILES) {
		const batch = scenes.slice(offset, offset + MAX_TILES).map((scene) => ({ scene, frame: settledFrame(scene, timeline.fps) }));
		const sheet = await renderSheet(actor, {
			storeAs: `projects/${project.id}/previews/${video.id}-check`,
			timeline: { projectId: project.id, timeline },
			tiles: batch.map(({ scene, frame }) => ({ kind: "frame", frame, ...size, label: `${scene.id} · ${clock(frame / timeline.fps)}` })),
			tileHeight: Math.round(TILE_HEIGHT[target] * 0.6),
			maxWidth: 1600,
			quality: 70,
		});
		sheets.push({ aspect: target, url: sheet.url });
		issues.push(...fitIssues(sheet.fits, (i) => (batch[i] ? { aspect: target, atSec: round2(batch[i]!.frame / timeline.fps) } : undefined)));
		warnings.push(...sheet.warnings);
	}
	return { sheets, issues, warnings };
}

const summary = (issues: Issue[]) => ({
	errors: issues.filter((issue) => issue.severity === "error").length,
	warnings: issues.filter((issue) => issue.severity === "warning").length,
	info: issues.filter((issue) => issue.severity === "info").length,
});

export const inspectOps = [
	defineOp({
		name: "video.preview",
		title: "Preview a frame",
		description:
			"Render one frame of the video as an image to check layout, text fit and branding before paying for media or a render. " +
			"Works at any stage: scenes whose media does not exist yet show the brand backdrop. Pick a scene (shown once its text and last bullet are on screen) or a time. " +
			"Pass `aspects` to see the same frame in several aspect ratios side by side, and `scene` to try a version of a scene without saving it. " +
			"Text that had to shrink to fit is listed under `layout`.",
		input: z.object({
			videoId,
			sceneId: z.string().optional().describe("Preview this scene, once it has settled"),
			seconds: z.number().min(0).optional().describe("Or preview this moment of the video"),
			aspect: aspect.optional().describe("Defaults to the video's primary aspect ratio"),
			aspects: z.array(aspect).min(1).max(4).optional().describe("Several aspect ratios side by side in one image (layout often breaks in only one)"),
			scene: Scene.optional().describe(
				"Try a version of a scene without saving it. It replaces the scene with the same id, or is added at the end; that scene is previewed unless sceneId or seconds says otherwise. " +
					"Changed narration or visuals are not generated: they show with estimated timing and the brand backdrop.",
			),
		}),
		readOnly: true,
		handler: async (input, { actor }) => {
			const { video, project } = await getVideo(actor, input.videoId);
			const inspected = await inspectTimeline(video, project, input.scene);
			const { timeline } = inspected;
			let frame: number;
			let sceneId: string;
			if (input.seconds !== undefined) {
				frame = Math.min(timeline.durationInFrames - 1, Math.round(input.seconds * timeline.fps));
				sceneId = sceneAt(timeline, frame).id;
			} else {
				const target = settled(timeline, input.sceneId ?? input.scene?.id);
				frame = target.frame;
				sceneId = target.scene.id;
			}
			const aspects = [...new Set(input.aspects ?? [input.aspect ?? video.aspect])];
			const single = aspects.length === 1 ? dimensionsFor(aspects[0]!, "720p") : null;
			const sheet = await renderSheet(actor, {
				storeAs: `projects/${project.id}/previews/${video.id}`,
				timeline: { projectId: project.id, timeline },
				tiles: aspects.map((target) => ({ kind: "frame", frame, ...dimensionsFor(target, "720p"), label: target })),
				tileHeight: single ? single.height : 400,
				maxWidth: single ? single.width : 1800,
				bare: Boolean(single),
			});
			const seconds = round2(frame / timeline.fps);
			const layout = sortIssues(fitIssues(sheet.fits, (i) => (aspects[i] ? { aspect: aspects[i]!, atSec: seconds } : undefined)));
			return {
				sceneId,
				seconds,
				aspects,
				url: sheet.url,
				...(inspected.draft ? { draft: true } : {}),
				...(input.scene ? { trial: `Scene "${input.scene.id}" is shown as given; nothing was saved. Save it with scene.save.` } : {}),
				layout,
				warnings: [...condense(inspected.warnings), ...sheet.warnings],
				[INLINE_IMAGE]: { base64: bytesToBase64(sheet.bytes), mimeType: sheet.contentType },
			};
		},
	}),

	defineOp({
		name: "video.sheet",
		title: "Contact sheet",
		description:
			"Many frames of the video on one image: by default every scene once it has settled, which shows the whole video at a glance. " +
			"Give fromSeconds/toSeconds (or one sceneId with count) to see an animation, transition or reveal frame by frame instead. " +
			"Cheaper and faster than rendering, and it works before any media exists. Text that had to shrink to fit is listed under `layout`.",
		input: z.object({
			videoId,
			aspect: aspect.optional().describe("Defaults to the video's primary aspect ratio"),
			sceneIds: z.array(z.string()).min(1).max(MAX_TILES).optional().describe("Only these scenes"),
			fromSeconds: z.number().min(0).optional().describe("Start of a stretch to show frame by frame"),
			toSeconds: z.number().min(0).optional().describe("End of that stretch"),
			count: z.number().int().min(2).max(24).optional().describe("Frames to spread over the stretch (default 8)"),
			tileHeight: z.number().int().min(100).max(480).optional().describe("Height of each frame in pixels. Defaults suit the aspect ratio"),
		}),
		readOnly: true,
		handler: async (input, { actor }) => {
			const { video, project } = await getVideo(actor, input.videoId);
			const inspected = await inspectTimeline(video, project);
			const { timeline } = inspected;
			const { fps } = timeline;
			const target = input.aspect ?? video.aspect;
			checkSceneIds(timeline, input.sceneIds);

			let picks: { frame: number; label: string }[];
			const notes: string[] = [];
			const stretch = input.fromSeconds !== undefined || input.toSeconds !== undefined || (input.sceneIds?.length === 1 && input.count);
			if (stretch) {
				const [first, last] = frameRange(timeline, input);
				picks = spreadFrames(first, last, input.count ?? 8).map((frame) => ({ frame, label: `${clock(frame / fps)} · ${sceneAt(timeline, frame).id}` }));
			} else {
				const scenes = timeline.scenes.map((scene, index) => ({ scene, index })).filter(({ scene }) => !input.sceneIds || input.sceneIds.includes(scene.id));
				if (scenes.length > MAX_TILES) notes.push(`Showing the first ${MAX_TILES} of ${scenes.length} scenes. Pass sceneIds for the rest.`);
				picks = scenes.slice(0, MAX_TILES).map(({ scene, index }) => {
					const frame = settledFrame(scene, fps);
					return { frame, label: `#${index + 1} ${scene.id} · ${clock(frame / fps)}` };
				});
			}

			const sheet = await renderSheet(actor, {
				storeAs: `projects/${project.id}/previews/${video.id}-sheet`,
				timeline: { projectId: project.id, timeline },
				tiles: picks.map(({ frame, label }) => ({ kind: "frame", frame, ...dimensionsFor(target, "720p"), label })),
				tileHeight: input.tileHeight ?? TILE_HEIGHT[target],
				maxWidth: 1600,
			});
			const tiles = picks.map(({ frame }, i) => ({ n: i + 1, sceneId: sceneAt(timeline, frame).id, seconds: round2(frame / fps) }));
			return {
				aspect: target,
				tiles,
				url: sheet.url,
				...(inspected.draft ? { draft: true } : {}),
				layout: sortIssues(fitIssues(sheet.fits, (i) => (tiles[i] ? { aspect: target, atSec: tiles[i]!.seconds } : undefined))),
				warnings: [...notes, ...condense(inspected.warnings), ...sheet.warnings],
				[INLINE_IMAGE]: { base64: bytesToBase64(sheet.bytes), mimeType: sheet.contentType },
			};
		},
	}),

	defineOp({
		name: "video.check",
		title: "Check a video",
		description:
			"Review the whole video for problems without watching it, as a list ordered by severity with a suggested fix for each: " +
			"text that overflows or shrinks to fit in each aspect ratio, narration that is too fast, more on-screen text than there is time to read, " +
			"bullets that land just before a cut, dead air, missing or unusable media, and compose warnings. Works before video.prepare (timings are then estimated). " +
			"Run it after each round of edits; check the sound separately with video.audio.",
		input: z.object({
			videoId,
			aspects: z.array(aspect).min(1).max(4).optional().describe("Aspect ratios to check the layout in. Defaults to the brand's, or the video's own"),
			sceneIds: z.array(z.string()).min(1).optional().describe("Only check these scenes"),
			layout: z.boolean().default(true).describe("Render every scene to measure text fit (takes a few seconds per aspect ratio). False checks timing only"),
		}),
		readOnly: true,
		handler: async (input, { actor }) => {
			const { video, project } = await getVideo(actor, input.videoId);
			const inspected = await inspectTimeline(video, project);
			const { timeline, storyboard } = inspected;
			checkSceneIds(timeline, input.sceneIds);
			const aspects = [...new Set(input.aspects ?? [video.aspect, ...(project.brand.format?.aspectRatios ?? [])])];

			const issues: Issue[] = [];
			const notes = condense(inspected.warnings);
			for (const warning of notes) {
				if (/has not been generated yet/.test(warning)) continue;
				const sceneId = /^Scene "([^"]+)"/.exec(warning)?.[1];
				issues.push({ severity: "warning", kind: "compose", sceneId, message: warning });
			}
			issues.push(...pacingIssues(timeline, storyboard));

			const sheets: { aspect: AspectRatio; url: string }[] = [];
			if (input.layout) {
				const media = new Set<string>();
				for (const target of aspects) {
					const result = await layoutSheets(actor, video, project, timeline, target, input.sceneIds);
					sheets.push(...result.sheets);
					issues.push(...result.issues);
					for (const warning of result.warnings) media.add(warning);
				}
				for (const warning of media) {
					issues.push({ severity: /unusable|could not|failed/.test(warning) ? "error" : "warning", kind: "media", sceneId: /scene "([^"]+)"/.exec(warning)?.[1], message: warning });
				}
			}

			const scoped = input.sceneIds ? issues.filter((issue) => !issue.sceneId || input.sceneIds!.includes(issue.sceneId)) : issues;
			const sorted = sortIssues(scoped);
			const counts = summary(sorted);
			return {
				ok: counts.errors === 0 && counts.warnings === 0,
				...counts,
				...(inspected.draft ? { draft: true, note: notes.find((note) => /has not been generated yet/.test(note)) } : {}),
				aspects: input.layout ? aspects : [],
				issues: sorted,
				sheets,
				next: inspected.draft ? "Run video.prepare, then video.check again for real timings and video.audio for the sound." : "Check the sound with video.audio.",
			};
		},
	}),

	defineOp({
		name: "video.timing",
		title: "Cue sheet",
		description:
			"When everything happens, as text: each scene's start and end, the narration line by line with times and its speed in words a minute, " +
			"when each bullet, chart value, map place and sound effect lands (and the words it was cued to), the music bed and its ducking, and stretches with no voice. " +
			"Free and instant. Use it to check pacing and sync without watching. Set words for every spoken word's time.",
		input: z.object({
			videoId,
			sceneIds: z.array(z.string()).min(1).optional().describe("Only these scenes"),
			words: z.boolean().default(false).describe("Include the time of every spoken word"),
		}),
		readOnly: true,
		handler: async (input, { actor }) => {
			const { video, project } = await getVideo(actor, input.videoId);
			const inspected = await inspectTimeline(video, project);
			checkSceneIds(inspected.timeline, input.sceneIds);
			const sheet = cueSheet(inspected.timeline, inspected.storyboard, { sceneIds: input.sceneIds, words: input.words });
			return { ...sheet, ...timingNote(sheet.scenes, inspected.draft, video.status === "preparing") };
		},
	}),

	defineOp({
		name: "video.audio",
		title: "Check the sound",
		description:
			"Listen to the mix without rendering: measures loudness (LUFS, as YouTube does), peaks and clipping, how far the voice sits above the music, " +
			"each scene's levels, jumps in narration level between scenes, and silences, then lists problems with fixes. " +
			"Needs the narration and music to exist (after video.prepare). Takes a few seconds.",
		input: z.object({
			videoId,
			sceneIds: z.array(z.string()).min(1).optional().describe("Only measure the stretch covering these scenes"),
			fromSeconds: z.number().min(0).optional(),
			toSeconds: z.number().min(0).optional(),
			profile: z.boolean().default(false).describe("Also return the loudness once a second"),
		}),
		readOnly: true,
		handler: async (input, { actor }) => {
			const { video, project } = await getVideo(actor, input.videoId);
			const composed = await runCompose(video, project);
			if (!composed.timeline) {
				throw new AppError(409, `The sound can be checked once its media exists: ${composed.errors.slice(0, 3).join("; ")}. Run video.prepare first.`, "not_ready");
			}
			const timeline = composed.timeline;
			const [first, last] = frameRange(timeline, input);
			const analysis = await analyseAudio(actor, project.id, timeline, { fromFrame: first, toFrame: last + 1, profile: input.profile });
			const master = masterLoudness(project.brand.audio?.loudness);
			const issues = sortIssues(audioIssues(analysis, timeline.durationInFrames / timeline.fps, master));
			const counts = summary(issues);
			return {
				ok: counts.errors === 0 && counts.warnings === 0,
				...counts,
				issues,
				...analysis,
				targets: { loudnessLufs: -14, speechOverMusicLu: "12-20", maxPeakDbfs: -1 },
				/** What renders do to the mix measured here. */
				mastering: master
					? `Exports are levelled to ${master.lufs} LUFS integrated, true peak ≤ ${master.truePeak} dBTP (two-pass loudnorm). These measurements are of the mix before levelling. Change it with brand.update audio.loudness, or per export with video.render loudness.`
					: "Exports are not levelled (brand audio.loudness is \"off\"): they keep the mix as measured here.",
			};
		},
	}),

	defineOp({
		name: "video.draft",
		title: "Draft cut",
		description:
			"A quick low-resolution MP4 of the whole video or a stretch of it (sceneIds, or fromSeconds/toSeconds), to watch motion, transitions and sync " +
			"or to show a person before paying for a full render. Renders in seconds on the preview renderer, at most 3 minutes long; not for publishing. " +
			"Works before video.prepare (with estimated timing and placeholders). Follow a draft that is still rendering by calling again with its draftId.",
		input: z.object({
			videoId,
			draftId: z.string().regex(/^drf_/).optional().describe("Check on a draft started earlier"),
			sceneIds: z.array(z.string()).min(1).optional().describe("Cut from the first of these scenes to the end of the last"),
			fromSeconds: z.number().min(0).optional(),
			toSeconds: z.number().min(0).optional(),
			aspect: aspect.optional().describe("Defaults to the video's primary aspect ratio"),
			resolution: z.enum(["480p", "720p"]).default("480p"),
			waitSeconds,
		}),
		handler: async (input, { actor }) => {
			const { video, project } = await getVideo(actor, input.videoId);
			let draftId = input.draftId;
			let range: Record<string, unknown> = {};
			let draft = false;
			if (!draftId) {
				await assertBudget(actor);
				const inspected = await inspectTimeline(video, project);
				const { timeline } = inspected;
				const frames = frameRange(timeline, input);
				const seconds = (frames[1] - frames[0] + 1) / timeline.fps;
				if (seconds > MAX_DRAFT_SECONDS) throw badRequest(`A draft is at most ${MAX_DRAFT_SECONDS / 60} minutes; this stretch is ${clock(seconds)}. Pick scenes or a range.`);
				const target = input.aspect ?? video.aspect;
				draftId = newId("drf");
				await startDraft(actor, project, draftId, timeline, dimensionsFor(target, input.resolution), frames);
				draft = inspected.draft;
				range = { fromSec: round2(frames[0] / timeline.fps), toSec: round2((frames[1] + 1) / timeline.fps), aspect: target, resolution: input.resolution };
			}
			const deadline = Date.now() + input.waitSeconds * 1000;
			let status = await draftStatus(actor, project, video.id, draftId);
			while (status.status === "rendering" && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 2000));
				status = await draftStatus(actor, project, video.id, draftId);
			}
			return {
				...status,
				...range,
				...(draft ? { draft: true, note: "Media is missing: timing is estimated, there is no voice yet and missing visuals show the brand backdrop." } : {}),
				...(status.status === "rendering" ? { next: `Call video.draft again with draftId "${draftId}" to follow it.` } : {}),
			};
		},
	}),

	defineOp({
		name: "asset.view",
		title: "Look at assets",
		description:
			"See images and video clips as one numbered contact sheet: each picture once, each clip as a strip of frames. " +
			"Use it to check generated or stock media before putting it in a scene, since a link alone shows nothing.",
		input: z.object({
			assetIds: z.array(z.string()).min(1).max(16),
			frames: z.number().int().min(1).max(8).default(4).describe("Frames to show from each video clip"),
		}),
		readOnly: true,
		handler: async (input, { actor }) => {
			const found = await Promise.all([...new Set(input.assetIds)].map((id) => getAsset(actor, id)));
			const videos = found.filter(({ asset }) => asset.kind === "video" && asset.status === "ready").length;
			const images = found.filter(({ asset }) => asset.kind === "image" && asset.status === "ready").length;
			const perVideo = Math.max(1, Math.min(input.frames, Math.floor((MAX_TILES - images) / Math.max(1, videos))));

			const tiles: SheetTile[] = [];
			const legend: { n: number; assetId: string; name: string; kind: string; tiles: number[] }[] = [];
			const skipped: { assetId: string; reason: string }[] = [];
			for (const { asset } of found) {
				if (asset.status !== "ready" || !asset.r2Key) {
					skipped.push({ assetId: asset.id, reason: asset.status === "failed" ? `failed: ${asset.error ?? "unknown error"}` : "still generating" });
					continue;
				}
				if (asset.kind !== "image" && asset.kind !== "video") {
					skipped.push({ assetId: asset.id, reason: `${asset.kind} files cannot be shown as a picture` });
					continue;
				}
				const n = legend.length + 1;
				const src = await signedUrl(asset.r2Key, { expiresIn: 1800 });
				const indices: number[] = [];
				if (asset.kind === "image") {
					indices.push(tiles.length + 1);
					tiles.push({ kind: "image", src, label: `${n}. ${asset.name}` });
				} else {
					const duration = (asset.durationMs ?? 0) / 1000;
					for (let i = 0; i < perVideo; i++) {
						const atSec = duration > 0 ? round2((duration * (i + 0.5)) / perVideo) : 0;
						indices.push(tiles.length + 1);
						tiles.push({ kind: "video", src, atSec, label: `${n}. ${asset.name} @${atSec}s` });
					}
				}
				legend.push({ n, assetId: asset.id, name: asset.name, kind: asset.kind, tiles: indices });
			}
			if (!tiles.length) return { assets: legend, skipped, note: "Nothing to show." };

			const sheet = await renderSheet(actor, { storeAs: `projects/${found[0]!.project.id}/previews/assets`, tiles, tileHeight: 220, maxWidth: 1600 });
			const failed = Object.entries(sheet.failed).map(([index, reason]) => ({ tile: Number(index) + 1, reason }));
			return {
				assets: legend,
				...(skipped.length ? { skipped } : {}),
				...(failed.length ? { failed } : {}),
				url: sheet.url,
				[INLINE_IMAGE]: { base64: bytesToBase64(sheet.bytes), mimeType: sheet.contentType },
			};
		},
	}),
];
