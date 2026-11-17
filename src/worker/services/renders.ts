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
import type { Actor } from "../auth/index.ts";
import { db, schema } from "../db/client.ts";
import { AppError, newId, notFound, slugify } from "../lib/util.ts";
import { rendererFetch } from "../renderer.ts";
import { assetsById } from "./assets.ts";
import { type Project, getProject } from "./projects.ts";
import { signedUrl } from "./storage.ts";
import { type Video, composeAndSave, compositionHash, runCompose } from "./videos.ts";

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
	options: { aspect: AspectRatio; resolution: Resolution },
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
	await env.RENDER_WORKFLOW.create({ id: render!.id, params: { renderId: render!.id } });
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

/**
 * Renders a single frame so the layout can be checked before paying for a
 * full export. Works on a draft timeline, so it can be used before any media
 * has been generated.
 */
export async function previewFrame(
	actor: Actor,
	video: Video,
	project: Project,
	options: { aspect: AspectRatio; sceneId?: string; seconds?: number },
): Promise<{ bytes: Uint8Array; contentType: string; frame: number; seconds: number; sceneId: string; warnings: string[] }> {
	const composed = await runCompose(video, project);
	let timeline = composed.timeline;
	let warnings = composed.warnings;
	if (!timeline) {
		const { composeTimeline } = await import("../../../shared/compose.ts");
		const draft = composeTimeline({
			storyboard: video.storyboard,
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
		timeline = draft.timeline;
		warnings = draft.warnings;
	}
	if (!timeline) throw new AppError(409, `Nothing to preview: ${composed.errors.join("; ")}`, "not_ready");

	let scene = options.sceneId ? timeline.scenes.find((candidate) => candidate.id === options.sceneId) : undefined;
	if (options.sceneId && !scene) throw notFound(`Scene "${options.sceneId}"`);
	let frame: number;
	if (options.seconds !== undefined) {
		frame = Math.min(timeline.durationInFrames - 1, Math.round(options.seconds * timeline.fps));
		scene = timeline.scenes.findLast((candidate) => candidate.startFrame <= frame) ?? timeline.scenes[0]!;
	} else {
		scene ??= timeline.scenes[0]!;
		// Late enough that entrances have settled and cued bullets are on screen.
		frame = scene.startFrame + Math.min(scene.durationInFrames - 1, Math.round(scene.durationInFrames * 0.85));
	}

	const { width, height } = dimensionsFor(options.aspect, "720p");
	const props: RenderProps = { timeline: await resolveTimeline(project.id, timeline, 1800), width, height };
	const request = () =>
		rendererFetch(`preview-${actor.id}`, "/still", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ props, frame, format: "jpeg" }),
		});
	// A container that is starting, or being replaced by a new release, can drop the first request.
	let response = await request().catch(() => null);
	if (!response || response.status >= 500) {
		await new Promise((resolve) => setTimeout(resolve, 2500));
		response = await request().catch((error: Error) => {
			throw new AppError(502, `The preview renderer is not reachable right now (${error.message}). Try again in a moment.`, "preview_failed");
		});
	}
	if (!response.ok) {
		const detail = await response.text().catch(() => "");
		throw new AppError(response.status === 409 ? 409 : 502, `Preview failed: ${detail.slice(0, 300) || response.status}`, "preview_failed");
	}
	const reported = response.headers.get("x-render-warning");
	if (reported) {
		const messages = decodeURIComponent(reported).split(" | ").map((message) => message.replace(/\?[^\s"')]+/g, "").slice(0, 300));
		warnings = [...warnings, ...messages.filter((message) => !warnings.includes(message))];
	}
	return {
		bytes: new Uint8Array(await response.arrayBuffer()),
		contentType: response.headers.get("content-type") ?? "image/jpeg",
		frame,
		seconds: Math.round((frame / timeline.fps) * 100) / 100,
		sceneId: scene.id,
		warnings,
	};
}
