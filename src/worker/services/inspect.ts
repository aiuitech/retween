/**
 * Ways to look at a video before (and instead of) rendering it: contact
 * sheets, layout checks, audio measurements and quick draft cuts. They all run
 * on the person's warm preview renderer, which they pay for by the second
 * like any container run (see services/metering.ts).
 */
import { env } from "cloudflare:workers";
import { type ComposeAsset, composeTimeline } from "../../../shared/compose.ts";
import type { FitReport } from "../../../shared/inspect.ts";
import type { Scene, Storyboard } from "../../../shared/storyboard.ts";
import type { Timeline } from "../../../shared/timeline.ts";
import type { Actor } from "../auth/index.ts";
import { AppError, base64ToBytes, sha256Hex } from "../lib/util.ts";
import { rendererFetch } from "../renderer.ts";
import { previewInstance } from "./metering.ts";
import type { Project } from "./projects.ts";
import { resolveTimeline } from "./renders.ts";
import { signedUrl } from "./storage.ts";
import { type Video, runCompose } from "./videos.ts";

// --- the timeline being looked at ------------------------------------------------

export interface InspectedTimeline {
	timeline: Timeline;
	storyboard: Storyboard;
	/** True when media is missing: timings are estimated and missing visuals show the brand backdrop. */
	draft: boolean;
	warnings: string[];
}

/**
 * Composes the video from the media that exists, without saving anything. When
 * media is missing it composes a draft instead (estimated timings, brand
 * backdrop in place of missing visuals), so a video can be looked at before
 * anything has been generated.
 *
 * `trial` swaps in a version of one scene (or adds a new one) for this look
 * only. If its narration or visual differs from the saved scene, the media
 * generated for the saved one is not used: the trial scene is shown as it
 * would be before video.prepare (estimated timing, brand backdrop).
 */
export async function inspectTimeline(video: Video, project: Project, trial?: Scene): Promise<InspectedTimeline> {
	let storyboard = video.storyboard;
	let resolved = video.resolved;
	const notes: string[] = [];
	if (trial) {
		const scenes = [...storyboard.scenes];
		const at = scenes.findIndex((scene) => scene.id === trial.id);
		const saved = at >= 0 ? scenes[at] : undefined;
		if (at >= 0) scenes[at] = trial;
		else scenes.push(trial);
		storyboard = { ...storyboard, scenes };
		const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
		const narration = { ...resolved.narration };
		const visual = { ...resolved.visual };
		const cutout = { ...resolved.cutout };
		if (!saved || !same(saved.narration, trial.narration) || !same(saved.voice, trial.voice)) {
			delete narration[trial.id];
			if (trial.narration?.trim()) notes.push(`Scene "${trial.id}" is timed from an estimate: its narration has not been voiced.`);
		}
		if (!saved || !same(saved.visual, trial.visual)) {
			delete visual[trial.id];
			delete cutout[trial.id];
			if (trial.visual && ["image", "vector", "video", "stock"].includes(trial.visual.source)) notes.push(`Scene "${trial.id}" shows the brand backdrop: its new visual has not been generated.`);
		}
		resolved = { ...resolved, narration, visual, cutout };
	}

	const subject = { ...video, storyboard, resolved };
	const composed = await runCompose(subject, project);
	if (composed.timeline) return { timeline: composed.timeline, storyboard, draft: false, warnings: [...notes, ...composed.warnings] };

	const assets = new Map<string, ComposeAsset>(
		[...composed.assets].map(([id, asset]) => [
			id,
			{
				id,
				kind: asset.kind,
				ready: asset.status === "ready",
				durationSec: asset.durationMs != null ? asset.durationMs / 1000 : undefined,
				words: asset.meta.words,
				contentType: asset.contentType ?? undefined,
				mono: typeof asset.meta.mono === "boolean" ? asset.meta.mono : undefined,
			},
		]),
	);
	const draft = composeTimeline({ storyboard, brand: project.brand, resolved, assets, draft: true });
	if (!draft.timeline) throw new AppError(409, `Nothing to look at yet: ${[...composed.errors, ...draft.errors].join("; ")}`, "not_ready");
	return { timeline: draft.timeline, storyboard, draft: true, warnings: [...notes, ...draft.warnings] };
}

// --- the preview renderer ------------------------------------------------------------

/** Calls the person's preview renderer, retrying once: a container that is starting or being replaced can drop a request. */
async function previewCall(actor: Pick<Actor, "id">, path: string, init?: RequestInit): Promise<Response> {
	const request = () => rendererFetch(previewInstance(actor.id), path, init);
	let response = await request().catch(() => null);
	if (!response || response.status >= 500) {
		await new Promise((resolve) => setTimeout(resolve, 2500));
		response = await request().catch((error: Error) => {
			throw new AppError(502, `The preview renderer is not reachable right now (${error.message}). Try again in a moment.`, "preview_failed");
		});
	}
	if (!response.ok) {
		const text = await response.text().catch(() => "");
		let detail = text;
		try {
			detail = (JSON.parse(text) as { error?: string }).error ?? text;
		} catch {
			// Plain text.
		}
		detail = detail.replace(/\?[^\s"')]+/g, "").slice(0, 400);
		if (response.status === 409) throw new AppError(409, `The preview renderer is busy: ${detail}`, "renderer_busy");
		throw new AppError(response.status === 400 ? 400 : 502, `The preview renderer could not do this: ${detail || response.status}`, "preview_failed");
	}
	return response;
}

const postJson = (actor: Pick<Actor, "id">, path: string, body: unknown) =>
	previewCall(actor, path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/** Strips signed-URL query strings from renderer messages. */
const tidy = (messages: string[]) => [...new Set(messages.map((message) => message.replace(/\?[^\s"')]+/g, "").slice(0, 300)))];

// --- contact sheets ----------------------------------------------------------------------

export type SheetTile =
	| { kind: "frame"; frame: number; width: number; height: number; label?: string }
	| { kind: "image"; src: string; label?: string }
	| { kind: "video"; src: string; atSec: number; label?: string }
	| {
			kind: "thumbnail";
			frame: number;
			width: number;
			height: number;
			overlay: import("../../../shared/thumbnail.ts").ThumbnailOverlay;
			label?: string;
			displayHeight?: number;
			badge?: string;
	  };

export interface Sheet {
	bytes: Uint8Array;
	contentType: string;
	width: number;
	height: number;
	/** Valid for an hour. */
	url: string;
	/** Tile index -> why a media tile could not be shown. */
	failed: Record<number, string>;
	fits: FitReport[];
	warnings: string[];
}

/**
 * Renders many frames (or media files) as one image on the preview renderer
 * and keeps a copy in R2 (under `storeAs`, e.g. `projects/<id>/previews/<video id>`)
 * so it can also be opened by link. Frame tiles need the timeline and the
 * project it belongs to: its `asset://` references are signed here.
 */
export async function renderSheet(
	actor: Actor,
	options: {
		storeAs: string;
		timeline?: { projectId: string; timeline: Timeline };
		tiles: SheetTile[];
		tileHeight: number;
		maxWidth: number;
		bare?: boolean;
		quality?: number;
	},
): Promise<Sheet> {
	const source = options.tiles.some((tile) => tile.kind === "frame" || tile.kind === "thumbnail") ? options.timeline : undefined;
	const timeline = source ? await resolveTimeline(source.projectId, source.timeline, 1800) : undefined;
	const response = await postJson(actor, "/sheet", {
		timeline,
		tiles: options.tiles,
		tileHeight: options.tileHeight,
		maxWidth: options.maxWidth,
		bare: options.bare,
		format: "jpeg",
		quality: options.quality ?? 82,
	});
	const result = (await response.json()) as {
		image: string;
		contentType: string;
		width: number;
		height: number;
		failed: Record<number, string>;
		fits: FitReport[];
		warnings: string[];
	};
	const bytes = base64ToBytes(result.image);
	const key = `${options.storeAs}-${(await sha256Hex(bytes)).slice(0, 16)}.jpg`;
	await env.MEDIA.put(key, bytes, { httpMetadata: { contentType: result.contentType } });
	return {
		bytes,
		contentType: result.contentType,
		width: result.width,
		height: result.height,
		url: await signedUrl(key, { expiresIn: 3600 }),
		failed: result.failed,
		fits: result.fits,
		warnings: tidy(result.warnings),
	};
}

// --- sound ------------------------------------------------------------------------------------

/** Measures the timeline's mix (see renderer/server/audio.ts). Frames are absolute; the range is [fromFrame, toFrame). */
export async function analyseAudio(actor: Actor, projectId: string, timeline: Timeline, options: { fromFrame?: number; toFrame?: number; profile?: boolean }) {
	const resolved = await resolveTimeline(projectId, timeline, 1800);
	const response = await postJson(actor, "/audio", { timeline: resolved, ...options });
	const analysis = (await response.json()) as import("../../../shared/inspect.ts").AudioAnalysis;
	return { ...analysis, skipped: analysis.skipped.map((entry) => ({ ...entry, reason: tidy([entry.reason])[0]! })) };
}

// --- draft cuts --------------------------------------------------------------------------------

export interface DraftStatus {
	draftId: string;
	status: "rendering" | "done" | "failed";
	progress?: number;
	/** Plays in a browser. Valid for 24 hours. */
	url?: string;
	error?: string;
	warnings?: string[];
}

export const draftKey = (projectId: string, videoId: string, draftId: string) => `projects/${projectId}/previews/${videoId}-${draftId}.mp4`;

/** Starts a draft render of frames [first, last] on the preview renderer. */
export async function startDraft(
	actor: Pick<Actor, "id">,
	project: Pick<Project, "id">,
	draftId: string,
	timeline: Timeline,
	size: { width: number; height: number },
	frameRange: [number, number],
): Promise<void> {
	const props = { timeline: await resolveTimeline(project.id, timeline, 6 * 3600), ...size };
	await postJson(actor, "/render", { jobId: draftId, props, options: { draft: true, frameRange } });
}

/**
 * Where a draft stands. A finished draft is copied from the renderer into R2
 * the first time it is seen, so its link outlives the container.
 */
export async function draftStatus(actor: Pick<Actor, "id">, project: Pick<Project, "id">, videoId: string, draftId: string): Promise<DraftStatus> {
	const key = draftKey(project.id, videoId, draftId);
	if (await env.MEDIA.head(key)) return { draftId, status: "done", progress: 1, url: await signedUrl(key, { expiresIn: 24 * 3600 }) };

	const response = await rendererFetch(previewInstance(actor.id), `/status?jobId=${encodeURIComponent(draftId)}`).catch(() => null);
	if (!response || response.status === 404) {
		return { draftId, status: "failed", error: "The preview renderer restarted and this draft was lost. Start a new one." };
	}
	if (!response.ok) throw new AppError(502, `The preview renderer did not answer (${response.status}). Try again in a moment.`, "preview_failed");
	const state = (await response.json()) as { state: string; progress?: number; error?: string; warnings?: string[] };
	const warnings = state.warnings?.length ? tidy(state.warnings) : undefined;
	if (state.state === "error") return { draftId, status: "failed", error: tidy([state.error ?? "Rendering failed"])[0], warnings };
	if (state.state !== "done") return { draftId, status: "rendering", progress: Math.round((state.progress ?? 0) * 100) / 100, warnings };

	const output = await rendererFetch(previewInstance(actor.id), `/output?jobId=${encodeURIComponent(draftId)}`);
	if (!output.ok) return { draftId, status: "failed", error: "The finished draft is no longer on the renderer. Start a new one." };
	await env.MEDIA.put(key, await output.arrayBuffer(), { httpMetadata: { contentType: "video/mp4" } });
	return { draftId, status: "done", progress: 1, url: await signedUrl(key, { expiresIn: 24 * 3600 }), warnings };
}
