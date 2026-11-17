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
import { RENDER_USD_PER_SECOND, renderProps } from "../services/renders.ts";
import { renderKey } from "../services/storage.ts";
import { recordUsage } from "../services/usage.ts";

const PART_BYTES = 16 * 1024 * 1024;
const network = { retries: { limit: 4, delay: "5 seconds", backoff: "exponential" }, timeout: "5 minutes" } as const;

interface RendererStatus {
	state: "idle" | "rendering" | "done" | "error";
	jobId?: string;
	stage?: string;
	progress?: number;
	error?: string;
	output?: { bytes: number; durationInFrames: number; fps: number };
	warnings?: string[];
}

/** Signed links inside renderer messages are of no use to a reader and should not be stored. */
const tidy = (warnings: string[] = []) => warnings.slice(0, 20).map((warning) => warning.replace(/\?[^\s"')]+/g, "").slice(0, 300));

const loadRender = (renderId: string) => db.query.renders.findFirst({ where: eq(schema.renders.id, renderId) });
const update = (renderId: string, values: Partial<typeof schema.renders.$inferInsert>) =>
	db.update(schema.renders).set(values).where(eq(schema.renders.id, renderId));

export class RenderWorkflow extends WorkflowEntrypoint<Env, { renderId: string }> {
	async run(event: WorkflowEvent<{ renderId: string }>, step: WorkflowStep) {
		const { renderId } = event.payload;
		try {
			const started = await step.do("start", network, async () => {
				const render = await loadRender(renderId);
				if (!render || render.status === "cancelled") return false;
				await update(renderId, { status: "starting", startedAt: new Date(), error: null });
				const response = await rendererFetch(renderId, "/render", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ jobId: renderId, props: await renderProps(render) }),
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

			await step.do("finish", async () => {
				const render = (await loadRender(renderId))!;
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
				const seconds = render.startedAt ? (finishedAt.getTime() - render.startedAt.getTime()) / 1000 : 0;
				await recordUsage({
					userId: render.createdBy,
					projectId: render.projectId,
					ref: renderId,
					kind: "render",
					provider: "cloudflare",
					quantity: seconds,
					unit: "seconds",
					costUsd: seconds * RENDER_USD_PER_SECOND,
					estimated: true,
				});
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await step.do("mark failed", async () => {
				const render = await loadRender(renderId);
				const status: RenderStatus = render?.status === "cancelled" ? "cancelled" : "failed";
				await update(renderId, { status, error: message.slice(0, 1000), finishedAt: new Date() });
			});
		} finally {
			await step.do("stop renderer", () => stopRenderer(renderId));
		}
	}
}
