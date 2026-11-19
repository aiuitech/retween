/**
 * Renders one export: starts a container, feeds it the timeline, follows its
 * progress, then copies the finished file into R2 in parts so that an export
 * of any size fits through the Worker.
 */
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep, env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import type { RenderStatus } from "../db/schema.ts";
import { rendererFetch, stopRenderer } from "../renderer.ts";
import { notify } from "../services/notifications.ts";
import { renderProps } from "../services/renders.ts";
import { renderKey } from "../services/storage.ts";
import { posterFrame, posterKey } from "../services/thumbnails.ts";

const PART_BYTES = 16 * 1024 * 1024;
const network = { retries: { limit: 4, delay: "5 seconds", backoff: "exponential" }, timeout: "5 minutes" } as const;

interface RendererStatus {
	state: "idle" | "rendering" | "done" | "error";
	jobId?: string;
	stage?: string;
	progress?: number;
	error?: string;
	output?: { bytes: number; durationInFrames: number; fps: number; loudness?: { inputLufs: number | null; outputLufs: number | null; outputTruePeak: number | null; mode: string } };
	warnings?: string[];
}

/** Signed links inside renderer messages are of no use to a reader and should not be stored. */
const tidy = (warnings: string[] = []) => warnings.slice(0, 20).map((warning) => warning.replace(/\?[^\s"')]+/g, "").slice(0, 300));

const loadRender = (renderId: string) => db.query.renders.findFirst({ where: eq(schema.renders.id, renderId) });

/** Tells whoever started an export that it finished or failed. Never throws: the export is what matters. */
async function announce(renderId: string) {
	try {
		await tell(renderId);
	} catch (error) {
		console.warn("could not announce render", renderId, error instanceof Error ? error.message : error);
	}
}

async function tell(renderId: string) {
	const render = await loadRender(renderId);
	if (!render || (render.status !== "done" && render.status !== "failed")) return;
	const video = await db.query.videos.findFirst({ where: eq(schema.videos.id, render.videoId), columns: { title: true } });
	const shape = `${render.aspect} ${render.height}p`;
	const done = render.status === "done";
	await notify({
		to: [render.createdBy],
		kind: done ? "render.finished" : "render.failed",
		title: done ? `${video?.title ?? "Your video"} (${shape}) is ready` : `The ${shape} export of ${video?.title ?? "your video"} failed`,
		body: done ? "The export is ready to download, publish or host." : (render.error ?? undefined)?.slice(0, 400),
		link: `/projects/${render.projectId}/videos/${render.videoId}/renders/${render.id}`,
		projectId: render.projectId,
		emailAction: done ? "Open the export" : "See what happened",
	});
}
const update = (renderId: string, values: Partial<typeof schema.renders.$inferInsert>) =>
	db.update(schema.renders).set(values).where(eq(schema.renders.id, renderId));

export interface RenderParams {
	renderId: string;
	/** Loudness to level the soundtrack to; null leaves it alone. Absent on runs started before levelling existed. */
	master?: { lufs: number; truePeak: number } | null;
}

export class RenderWorkflow extends WorkflowEntrypoint<Env, RenderParams> {
	async run(event: WorkflowEvent<RenderParams>, step: WorkflowStep) {
		const { renderId, master } = event.payload;
		try {
			const started = await step.do("start", network, async () => {
				const render = await loadRender(renderId);
				if (!render || render.status === "cancelled") return false;
				await update(renderId, { status: "starting", startedAt: new Date(), error: null });
				const response = await rendererFetch(renderId, "/render", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ jobId: renderId, props: await renderProps(render), ...(master ? { options: { master } } : {}) }),
				});
				if (response.status === 409) {
					// Busy. Fine if a previous attempt of this step already started this very job; otherwise retry.
					const current = (await rendererFetch(renderId, "/status").then((r) => r.json())) as RendererStatus;
					if (current.jobId !== renderId) throw new Error("The renderer is busy with another job");
				} else if (!response.ok) {
					throw new Error(`Renderer refused the job (${response.status}): ${(await response.text()).slice(0, 400)}`);
				}
				await update(renderId, { status: "rendering" });
				return true;
			});
			if (!started) return;

			let output: RendererStatus["output"];
			let warnings: string[] = [];
			let lastProgress = -1;
			for (let i = 0; i < 2000 && !output; i++) {
				await step.sleep(`wait ${i}`, i < 5 ? "3 seconds" : "6 seconds");
				const status = await step.do(`status ${i}`, network, async () => {
					const render = await loadRender(renderId);
					if (!render || render.status === "cancelled") {
						await rendererFetch(renderId, "/cancel", { method: "POST" }).catch(() => undefined);
						return { state: "cancelled" as const };
					}
					const response = await rendererFetch(renderId, "/status");
					if (!response.ok) throw new Error(`Renderer status ${response.status}`);
					return (await response.json()) as RendererStatus;
				});
				if (status.state === "cancelled") return;
				if (status.state === "error") throw new Error(status.error ?? "Rendering failed");
				if (status.state === "idle" || (status.jobId && status.jobId !== renderId)) {
					throw new Error("The renderer restarted before the export finished");
				}
				const progress = Math.min(99, Math.round((status.progress ?? 0) * 100));
				if (progress !== lastProgress) {
					lastProgress = progress;
					await step.do(`progress ${i}`, () => update(renderId, { progress }).then(() => undefined));
				}
				if (status.state === "done") {
					output = status.output;
					warnings = tidy(status.warnings);
				}
			}
			if (!output) throw new Error("Rendering did not finish in time");
			const size = output.bytes;

			const upload = await step.do("begin upload", async () => {
				const render = (await loadRender(renderId))!;
				const key = renderKey(render.projectId, renderId);
				await update(renderId, { status: "uploading" });
				const multipart = await env.MEDIA.createMultipartUpload(key, { httpMetadata: { contentType: "video/mp4" } });
				return { key, uploadId: multipart.uploadId };
			});

			const parts: { partNumber: number; etag: string }[] = [];
			for (let offset = 0, partNumber = 1; offset < size; offset += PART_BYTES, partNumber++) {
				const end = Math.min(size, offset + PART_BYTES) - 1;
				parts.push(
					await step.do(`upload part ${partNumber}`, network, async () => {
						const response = await rendererFetch(renderId, "/output", { headers: { range: `bytes=${offset}-${end}` } });
						if (response.status !== 206 && response.status !== 200) throw new Error(`Renderer output ${response.status}`);
						const bytes = await response.arrayBuffer();
						if (bytes.byteLength !== end - offset + 1) throw new Error("Renderer returned a short read");
						const part = await env.MEDIA.resumeMultipartUpload(upload.key, upload.uploadId).uploadPart(partNumber, bytes);
						return { partNumber: part.partNumber, etag: part.etag };
					}),
				);
			}

			// The container's cost is metered from its own start and stop (see Renderer), not here.
			await step.do("finish", async () => {
				await env.MEDIA.resumeMultipartUpload(upload.key, upload.uploadId).complete(parts);
				const finishedAt = new Date();
				await update(renderId, {
					status: "done",
					progress: 100,
					r2Key: upload.key,
					bytes: size,
					durationMs: Math.round((output!.durationInFrames / output!.fps) * 1000),
					warnings,
					finishedAt,
				});
			});
			// The poster: a still of the opening in this export's shape, taken while the container is still up.
			// Nice to have, so a failure here never fails the export.
			await step.do("poster", { retries: { limit: 1, delay: "3 seconds" }, timeout: "2 minutes" }, async () => {
				try {
					const render = (await loadRender(renderId))!;
					const props = await renderProps(render);
					const scale = Math.min(1, 720 / Math.min(render.width, render.height));
					const response = await rendererFetch(renderId, "/still", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ props, frame: posterFrame(render.timeline), format: "jpeg", scale: Math.max(0.1, Math.round(scale * 100) / 100) }),
					});
					if (!response.ok) throw new Error(`still ${response.status}: ${(await response.text()).slice(0, 200)}`);
					const key = posterKey(render.projectId, renderId);
					await env.MEDIA.put(key, await response.arrayBuffer(), { httpMetadata: { contentType: "image/jpeg" } });
					await update(renderId, { posterKey: key });
				} catch (error) {
					console.warn("could not take a poster still", renderId, error instanceof Error ? error.message : error);
				}
			});
			await step.do("notify", { retries: { limit: 0, delay: "1 second" } }, () => announce(renderId));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await step.do("mark failed", async () => {
				const render = await loadRender(renderId);
				const status: RenderStatus = render?.status === "cancelled" ? "cancelled" : "failed";
				await update(renderId, { status, error: message.slice(0, 1000), finishedAt: new Date() });
			});
			await step.do("notify", { retries: { limit: 0, delay: "1 second" } }, () => announce(renderId));
		} finally {
			await step.do("stop renderer", () => stopRenderer(renderId));
		}
	}
}
