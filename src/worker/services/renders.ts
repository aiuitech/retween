/**
 * Renders: one export of a video at a given aspect ratio and resolution.
 */
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import {
	type AspectRatio,
	type RenderProps,
	type Resolution,
	type Timeline,
	collectAssetRefs,
	dimensionsFor,
	dropMissingAssetRefs,
	resolveAssetRefs,
} from "../../../shared/timeline.ts";
import { masterLoudness } from "../../../shared/audio-models.ts";
import type { Actor } from "../auth/index.ts";
import { db, schema } from "../db/client.ts";
import { AppError, newId, notFound, slugify } from "../lib/util.ts";
import { assetsById } from "./assets.ts";
import { type Project, getProject } from "./projects.ts";
import { signedUrl } from "./storage.ts";
import { type Video, composeAndSave, compositionHash } from "./videos.ts";

export type Render = typeof schema.renders.$inferSelect;

export async function getRender(actor: Actor, renderId: string): Promise<{ render: Render; project: Project }> {
	const render = await db.query.renders.findFirst({ where: eq(schema.renders.id, renderId) });
	if (!render) throw notFound("Render");
	const project = await getProject(actor, render.projectId).catch(() => {
		throw notFound("Render");
	});
	return { render, project };
}

export async function renderView(render: Render, title?: string) {
	const done = render.status === "done" && render.r2Key;
	const name = `${slugify(title ?? "video")}-${render.aspect.replace(":", "x")}-${render.resolution}.mp4`;
	return {
		id: render.id,
		videoId: render.videoId,
		aspect: render.aspect,
		resolution: render.resolution,
		width: render.width,
		height: render.height,
		fps: render.fps,
		status: render.status,
		progress: render.progress,
		durationSec: render.durationMs != null ? render.durationMs / 1000 : undefined,
		bytes: render.bytes ?? undefined,
		error: render.error ?? undefined,
		/** Problems the renderer worked around. A finished render with warnings is worth watching before publishing. */
		warnings: render.warnings.length ? render.warnings : undefined,
		/** Plays in a browser. Valid for 24 hours; ask again for a fresh link. */
		url: done ? await signedUrl(render.r2Key!, { expiresIn: 24 * 3600 }) : undefined,
		downloadUrl: done ? await signedUrl(render.r2Key!, { expiresIn: 24 * 3600, downloadAs: name }) : undefined,
		createdAt: render.createdAt,
		finishedAt: render.finishedAt ?? undefined,
	};
}

/** The video's timeline, recomposed first if anything changed since it was built. */
export async function freshTimeline(video: Video, project: Project): Promise<Timeline> {
	const current = await compositionHash(video, project.brand);
	if (video.timeline && video.composedFrom === current) return video.timeline;
	const result = await composeAndSave(video, project);
	if (!result.timeline) {
		throw new AppError(
			409,
			`This video is not ready to render: ${result.errors.join("; ")}. Run video.prepare to generate the missing media.`,
			"not_ready",
			{ errors: result.errors },
		);
	}
	return result.timeline;
}

export async function createRender(
	actor: Actor,
	video: Video,
	project: Project,
	options: { aspect: AspectRatio; resolution: Resolution; loudness?: number | "off" },
	timeline?: Timeline,
): Promise<Render> {
	const source = timeline ?? (await freshTimeline(video, project));
	const { width, height } = dimensionsFor(options.aspect, options.resolution);
	const [render] = await db
		.insert(schema.renders)
		.values({
			id: newId("rnd"),
			videoId: video.id,
			projectId: project.id,
			aspect: options.aspect,
			resolution: options.resolution,
			width,
			height,
			fps: source.fps,
			timeline: source,
			createdBy: actor.id,
		})
		.returning();
	// The soundtrack is levelled to the brand's loudness unless this export asks for another (or none).
	const master = masterLoudness(options.loudness ?? project.brand.audio?.loudness);
	await env.RENDER_WORKFLOW.create({ id: render!.id, params: { renderId: render!.id, master } });
	return render!;
}

/**
 * Swaps every `asset://` reference (logo, watermark, backgrounds, cutouts,
 * Lottie, icons, audio) for a signed URL the container can fetch. Media that
 * has been deleted since the timeline was composed is dropped rather than left
 * dangling: a scene falls back to the brand backdrop, an audio clip is removed,
 * and a logo, watermark, cutout or icon is left out.
 */
export async function resolveTimeline(projectId: string, timeline: Timeline, expiresIn = 6 * 3600): Promise<Timeline> {
	const assets = await assetsById(projectId, collectAssetRefs(timeline));
	const urls = new Map<string, string>();
	for (const asset of assets.values()) {
		if (asset.status === "ready" && asset.r2Key) urls.set(asset.id, await signedUrl(asset.r2Key, { expiresIn }));
	}
	return resolveAssetRefs(
		dropMissingAssetRefs(timeline, (id) => urls.has(id)),
		(id) => urls.get(id)!,
	);
}

export async function renderProps(render: Render): Promise<RenderProps> {
	return { timeline: await resolveTimeline(render.projectId, render.timeline), width: render.width, height: render.height };
}
