/**
 * Thumbnails and posters.
 *
 * A thumbnail is designed (up to three variants at once, each shown at full
 * size and at the sizes a feed shows it), chosen, and saved as an image asset
 * tagged `thumbnail` that the video points at. It is published with the video
 * and is the video's poster everywhere it is shown. Without one, the poster is
 * the still each render takes of its opening.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { sceneAt, settledFrame } from "../../../shared/inspect.ts";
import {
	FEED_SIZES,
	THUMBNAIL_MAX_BYTES,
	THUMBNAIL_SIZE,
	type ThumbnailDesign,
	type ThumbnailNote,
	type ThumbnailOverlay,
	overlayFor,
	thumbnailNotes,
	thumbnailTimeline,
} from "../../../shared/thumbnail.ts";
import type { Timeline, TimelineBackground } from "../../../shared/timeline.ts";
import type { Actor } from "../auth/index.ts";
import { db, schema } from "../db/client.ts";
import { AppError, badRequest, notFound } from "../lib/util.ts";
import { falConfigured } from "../providers/fal.ts";
import { type Asset, assetsById, createAsset, startGeneration, storeAsset, waitForAssets } from "./assets.ts";
import { blockedReason, getControls } from "./controls.ts";
import { type SheetTile, inspectTimeline, renderSheet } from "./inspect.ts";
import type { Project } from "./projects.ts";
import { signedUrl } from "./storage.ts";
import type { Video } from "./videos.ts";

const ref = (assetId: string) => `asset://${assetId}`;
const refId = (src: string) => (src.startsWith("asset://") ? src.slice("asset://".length) : undefined);

/** A picture without the scene's own motion settings that make no sense on a still. */
function stillOf(background: TimelineBackground, offsetSec: number): TimelineBackground {
	if (background.kind === "video") return { ...background, startFromSec: background.startFromSec + offsetSec * background.playbackRate, loop: false };
	if (background.kind === "image") return { ...background, cutout: undefined };
	return background;
}

interface ResolvedVariant {
	design: ThumbnailDesign;
	background: TimelineBackground;
	/** The asset the picture came from, when it is a still: what a cut-out is made from. */
	pictureAssetId?: string;
	sceneId?: string;
	notes: ThumbnailNote[];
}

/** Works out each variant's picture from the video's own timeline (composed as a draft if media is missing). */
async function resolvePictures(video: Video, project: Project, designs: ThumbnailDesign[]) {
	const { timeline } = await inspectTimeline(video, project);
	const assetIds = designs.map((design) => design.picture?.assetId).filter((id): id is string => Boolean(id));
	const assets = await assetsById(project.id, assetIds);
	const firstPicture = timeline.scenes.find((scene) => scene.background.kind === "image" || scene.background.kind === "video");

	const variants = designs.map((design): ResolvedVariant => {
		const notes: ThumbnailNote[] = [];
		const picture = design.picture ?? {};
		let background: TimelineBackground = { kind: "brand" };
		let sceneId: string | undefined;
		if (picture.assetId) {
			const asset = assets.get(picture.assetId);
			if (!asset) throw badRequest(`Asset ${picture.assetId} does not exist in this project`);
			if (asset.status !== "ready") throw badRequest(`Asset ${picture.assetId} is not ready yet (${asset.status})`);
			if (asset.kind === "image") background = { kind: "image", src: ref(asset.id), fit: "cover" };
			else if (asset.kind === "video") background = { kind: "video", src: ref(asset.id), fit: "cover", startFromSec: picture.atSec ?? 0, loop: false, volume: 0, playbackRate: 1 };
			else throw badRequest(`Asset ${picture.assetId} is ${asset.kind === "animation" ? "an animation" : `a ${asset.kind} file`}; a thumbnail needs an image or a video`);
		} else {
			const scene =
				picture.sceneId !== undefined
					? timeline.scenes.find((candidate) => candidate.id === picture.sceneId)
					: picture.seconds !== undefined
						? sceneAt(timeline, Math.min(timeline.durationInFrames - 1, Math.round(picture.seconds * timeline.fps)))
						: firstPicture;
			if (picture.sceneId !== undefined && !scene) throw notFound(`Scene "${picture.sceneId}"`);
			if (scene) {
				sceneId = scene.id;
				const offset =
					picture.atSec ?? (picture.seconds !== undefined ? Math.max(0, picture.seconds - scene.startFrame / timeline.fps) : (settledFrame(scene, timeline.fps) - scene.startFrame) / timeline.fps);
				background = stillOf(scene.background, offset);
				if (background.kind === "brand" && !design.subject) {
					notes.push({ severity: "info", kind: "plain-picture", message: `Scene "${scene.id}" has no picture yet, so this variant shows the brand backdrop.`, fix: "Pick a scene with a picture, or pass picture.assetId." });
				}
			}
		}
		if (design.look && (background.kind === "image" || background.kind === "video")) background = { ...background, look: { ...background.look, ...design.look } };
		const pictureAssetId = background.kind === "image" ? refId(background.src) : undefined;
		return { design, background, pictureAssetId, sceneId, notes };
	});
	return { timeline, variants };
}

/** An existing cut-out of `sourceAssetId`, or a new one (generated, a fraction of a cent). */
async function cutoutOf(actor: Actor, project: Project, video: Video, sourceAssetId: string, sceneId: string | undefined, waitSeconds: number): Promise<Asset | string> {
	if (sceneId) {
		const sceneCutout = video.resolved.cutout?.[sceneId]?.assetId;
		const found = sceneCutout ? (await assetsById(project.id, [sceneCutout])).get(sceneCutout) : undefined;
		if (found?.status === "ready" && found.generation?.type === "cutout" && found.generation.sourceAssetId === sourceAssetId) return found;
	}
	// A finished cut-out of the same picture is reused; one still being made is waited for rather than made twice.
	const existing = await db.query.assets.findMany({
		where: and(
			eq(schema.assets.projectId, project.id),
			sql`${schema.assets.status} in ('ready', 'pending')`,
			sql`json_extract(${schema.assets.generation}, '$.type') = 'cutout'`,
			sql`json_extract(${schema.assets.generation}, '$.sourceAssetId') = ${sourceAssetId}`,
		),
		orderBy: desc(schema.assets.createdAt),
		limit: 5,
	});
	const ready = existing.find((asset) => asset.status === "ready");
	if (ready) return ready;
	let asset = existing.find((asset) => asset.status === "pending");
	if (!asset) {
		if (!falConfigured()) return "Cut-outs need a fal.ai key (FAL_KEY) on this service";
		const blocked = blockedReason(await getControls(actor.id), "cutout");
		if (blocked) return blocked;
		asset = await createAsset({
			projectId: project.id,
			createdBy: actor.id,
			kind: "image",
			name: `Cut-out · ${video.title}`,
			source: "generated",
			tags: ["cutout"],
			generation: { type: "cutout", sourceAssetId },
			videoId: video.id,
		});
		await startGeneration(asset);
	}
	const [done] = await waitForAssets([asset.id], waitSeconds);
	if (!done || done.status === "pending") return `The cut-out is still being made (asset ${asset.id}); design again in a moment and it will be used`;
	if (done.status === "failed") return `The cut-out failed: ${done.error ?? "unknown error"}`;
	return done;
}

export interface DesignedVariant {
	n: number;
	overlay: ThumbnailOverlay;
	background: TimelineBackground;
	notes: ThumbnailNote[];
}

/** Turns designs into what the renderer draws, cutting subjects out where asked. */
async function prepareVariants(actor: Actor, project: Project, video: Video, designs: ThumbnailDesign[], waitSeconds: number) {
	const { timeline, variants } = await resolvePictures(video, project, designs);
	const subjectIds = designs.map((design) => design.subject?.assetId).filter((id): id is string => Boolean(id));
	const subjects = await assetsById(project.id, subjectIds);
	const prepared: DesignedVariant[] = [];
	const subjectSrcs: (string | undefined)[] = [];
	for (const [i, variant] of variants.entries()) {
		const { design } = variant;
		let subject: Asset | undefined;
		if (design.subject?.assetId) {
			subject = subjects.get(design.subject.assetId);
			if (!subject) throw badRequest(`Asset ${design.subject.assetId} does not exist in this project`);
			if (subject.kind !== "image" || subject.status !== "ready") throw badRequest(`Asset ${design.subject.assetId} is not a ready image`);
		} else if (design.subject?.fromPicture) {
			if (!variant.pictureAssetId) {
				variant.notes.push({ severity: "warning", kind: "no-cutout", message: "Only a still picture can have its subject cut out; this one is a clip or the brand backdrop, so no subject is shown.", fix: "Use picture.assetId with an image, or subject.assetId with a transparent image." });
			} else {
				const result = await cutoutOf(actor, project, video, variant.pictureAssetId, variant.sceneId, waitSeconds);
				if (typeof result === "string") variant.notes.push({ severity: "warning", kind: "no-cutout", message: `No subject: ${result}.` });
				else subject = result;
			}
		}
		const src = subject?.r2Key ? await signedUrl(subject.r2Key, { expiresIn: 1800 }) : undefined;
		subjectSrcs.push(src);
		prepared.push({ n: i + 1, overlay: overlayFor(design, src), background: variant.background, notes: [...variant.notes, ...thumbnailNotes(design, video.title)] });
	}
	const thumbs = thumbnailTimeline(
		timeline.theme,
		prepared.map((variant) => variant.background),
		prepared.map((variant) => [variant.overlay.kicker, variant.overlay.headline].filter(Boolean).join(" ")),
	);
	return { timeline, thumbs, prepared };
}

/** "8:42", or "1:02:05" past an hour: as YouTube prints the length over a thumbnail. */
export function badgeText(seconds: number): string {
	const total = Math.max(1, Math.round(seconds));
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = String(total % 60).padStart(2, "0");
	return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/**
 * Renders the variants side by side: each at full size and at the size it is
 * seen in a home feed and in the up-next column, with the duration badge a
 * feed prints over it. Returns the sheet and each variant's notes.
 */
export async function designThumbnails(actor: Actor, project: Project, video: Video, designs: ThumbnailDesign[], waitSeconds: number) {
	const { timeline, thumbs, prepared } = await prepareVariants(actor, project, video, designs, waitSeconds);
	const badge = badgeText(timeline.durationInFrames / timeline.fps);
	const tiles: SheetTile[] = [];
	for (const variant of prepared) {
		const base = { kind: "thumbnail" as const, frame: variant.n - 1, ...THUMBNAIL_SIZE, overlay: variant.overlay, badge };
		tiles.push({ ...base, label: `${variant.n} · full size`, displayHeight: 270 });
		for (const feed of FEED_SIZES) tiles.push({ ...base, label: `${variant.n} · ${feed.name}`, displayHeight: feed.height });
	}
	const sheet = await renderSheet(actor, {
		storeAs: `projects/${project.id}/previews/${video.id}-thumbs`,
		timeline: { projectId: project.id, timeline: thumbs },
		tiles,
		tileHeight: 270,
		// Narrow enough that each variant gets a row of its own.
		maxWidth: 1100,
		quality: 85,
	});
	// FitBox reports how far each headline shrank; any one of a variant's tiles tells.
	for (const variant of prepared) {
		const fit = sheet.fits.find((report) => report.box === `thumb-${variant.n}/headline`);
		if (fit && fit.scale < 1) {
			const design = designs[variant.n - 1]!;
			variant.notes = [...variant.notes.filter((note) => note.kind !== "headline-too-small"), ...thumbnailNotes(design, video.title, fit.scale).filter((note) => note.kind === "headline-too-small")];
		}
	}
	return { sheet, variants: prepared };
}

/** Renders one design at 1280×720 and makes it the video's thumbnail. */
export async function saveThumbnail(actor: Actor, project: Project, video: Video, design: ThumbnailDesign, waitSeconds: number) {
	const { thumbs, prepared } = await prepareVariants(actor, project, video, [design], waitSeconds);
	const variant = prepared[0]!;
	const render = (quality: number) =>
		renderSheet(actor, {
			storeAs: `projects/${project.id}/previews/${video.id}-thumb`,
			timeline: { projectId: project.id, timeline: thumbs },
			tiles: [{ kind: "thumbnail", frame: 0, ...THUMBNAIL_SIZE, overlay: variant.overlay }],
			tileHeight: THUMBNAIL_SIZE.height,
			maxWidth: THUMBNAIL_SIZE.width,
			bare: true,
			quality,
		});
	let image = await render(90);
	if (image.bytes.byteLength > THUMBNAIL_MAX_BYTES) image = await render(72);
	if (image.bytes.byteLength > THUMBNAIL_MAX_BYTES) throw new AppError(422, "The thumbnail came out larger than YouTube's 2 MB limit. Use a simpler picture.", "too_large");
	const asset = await createAsset({
		projectId: project.id,
		createdBy: actor.id,
		kind: "image",
		name: `Thumbnail · ${video.title}`.slice(0, 200),
		description: design.headline,
		source: "generated",
		tags: ["thumbnail"],
		meta: { thumbnail: { design, overlay: { ...variant.overlay, subject: variant.overlay.subject && { ...variant.overlay.subject, src: "" } } } },
		videoId: video.id,
	});
	const stored = await storeAsset(asset, image.bytes, image.contentType);
	await db.update(schema.videos).set({ thumbnailAssetId: stored.id }).where(eq(schema.videos.id, video.id));
	return { asset: stored, notes: variant.notes, fits: image.fits };
}

/** Makes an existing image the video's thumbnail (or clears it with null), with what YouTube will make of it. */
export async function setThumbnail(project: Project, video: Video, assetId: string | null) {
	const notes: ThumbnailNote[] = [];
	if (assetId) {
		const asset = (await assetsById(project.id, [assetId])).get(assetId);
		if (!asset) throw badRequest(`Asset ${assetId} does not exist in this project`);
		if (asset.kind !== "image" || asset.status !== "ready") throw badRequest(`Asset ${assetId} is not a ready image`);
		if ((asset.bytes ?? 0) > THUMBNAIL_MAX_BYTES) notes.push({ severity: "warning", kind: "too-large", message: `The image is ${Math.round((asset.bytes ?? 0) / 1e5) / 10} MB; YouTube accepts thumbnails up to 2 MB, so publishing will leave the thumbnail out.`, fix: "Design one with thumbnail.design, which keeps under the limit." });
		if (asset.width && asset.height) {
			if (Math.abs(asset.width / asset.height - 16 / 9) > 0.05) notes.push({ severity: "warning", kind: "not-16x9", message: `The image is ${asset.width}×${asset.height}; YouTube shows thumbnails at 16:9 and will letterbox or crop it.` });
			if (asset.width < 640) notes.push({ severity: "warning", kind: "too-small", message: `The image is only ${asset.width}px wide; YouTube asks for at least 640 (1280 recommended).` });
		}
	}
	await db.update(schema.videos).set({ thumbnailAssetId: assetId }).where(eq(schema.videos.id, video.id));
	return notes;
}

/** The poster for a video: its thumbnail, else the latest finished render's opening still in the video's shape (or any shape). */
export async function posterFor(video: Pick<Video, "id" | "aspect" | "thumbnailAssetId" | "projectId">, expiresIn = 24 * 3600): Promise<{ url: string; source: "thumbnail" | "render" } | undefined> {
	if (video.thumbnailAssetId) {
		const asset = (await assetsById(video.projectId, [video.thumbnailAssetId])).get(video.thumbnailAssetId);
		if (asset?.status === "ready" && asset.r2Key) return { url: await signedUrl(asset.r2Key, { expiresIn }), source: "thumbnail" };
	}
	const renders = await db.query.renders.findMany({
		where: and(eq(schema.renders.videoId, video.id), eq(schema.renders.status, "done")),
		columns: { posterKey: true, aspect: true },
		orderBy: desc(schema.renders.createdAt),
		limit: 20,
	});
	const pick = renders.find((render) => render.posterKey && render.aspect === video.aspect) ?? renders.find((render) => render.posterKey);
	return pick?.posterKey ? { url: await signedUrl(pick.posterKey, { expiresIn }), source: "render" } : undefined;
}

/** The frame a render's poster is taken from: the opening scene once it has settled. */
export function posterFrame(timeline: Timeline): number {
	return settledFrame(timeline.scenes[0]!, timeline.fps);
}

export const posterKey = (projectId: string, renderId: string) => `projects/${projectId}/renders/${renderId}-poster.jpg`;

/** For messages: a variant's notes as one line each. */
export const noteLines = (notes: ThumbnailNote[]) => notes.map((note) => `${note.severity}: ${note.message}${note.fix ? ` ${note.fix}` : ""}`);
