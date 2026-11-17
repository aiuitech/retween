/**
 * Fills in one pending asset. Everything except generated video is a single
 * step; a video clip is a remote job that is submitted, polled and downloaded.
 */
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import { isRetryable } from "../lib/util.ts";
import { VIDEO_MODEL, downloadVideo, getVideoJob, submitVideo } from "../providers/openrouter.ts";
import { assetDataUrl, assetsById, executeGeneration, failAsset, storeAsset } from "../services/assets.ts";
import { recordUsage } from "../services/usage.ts";

/** Published per-second prices for the clip model, used when a job does not report its cost. */
const CLIP_USD_PER_SECOND: Record<string, number> = { "360p": 0.023172, "720p": 0.069504, "1080p": 0.104256 };

const once = { retries: { limit: 0, delay: 1000 }, timeout: "15 minutes" } as const;
const patient = { retries: { limit: 2, delay: "15 seconds", backoff: "exponential" }, timeout: "15 minutes" } as const;

/** Turns permanent failures (bad input, refused prompt) into errors that are not retried. */
async function attempt<T>(work: () => Promise<T>): Promise<T> {
	try {
		return await work();
	} catch (error) {
		if (isRetryable(error)) throw error;
		throw new NonRetryableError(error instanceof Error ? error.message : String(error));
	}
}

export class AssetWorkflow extends WorkflowEntrypoint<Env, { assetId: string }> {
	async run(event: WorkflowEvent<{ assetId: string }>, step: WorkflowStep) {
		const { assetId } = event.payload;
		try {
			const kind = await step.do("load", async () => {
				const asset = await db.query.assets.findFirst({ where: eq(schema.assets.id, assetId) });
				return asset?.status === "pending" ? (asset.generation?.type ?? null) : null;
			});
			if (!kind) return;

			if (kind !== "video") {
				await step.do("generate", patient, () => attempt(async () => void (await executeGeneration(assetId))));
				return;
			}

			const jobId = await step.do("submit clip", once, () =>
				attempt(async () => {
					const asset = (await db.query.assets.findFirst({ where: eq(schema.assets.id, assetId) }))!;
					const spec = asset.generation;
					if (spec?.type !== "video") throw new NonRetryableError("Asset is not a video generation");
					const firstFrame = spec.firstFrameAssetId
						? (await assetsById(asset.projectId, [spec.firstFrameAssetId])).get(spec.firstFrameAssetId)
						: undefined;
					const job = await submitVideo({
						prompt: spec.prompt,
						seconds: spec.seconds,
						aspectRatio: spec.aspectRatio,
						resolution: spec.resolution,
						withAudio: spec.withAudio,
						firstFrame: (firstFrame && (await assetDataUrl(firstFrame))) ?? undefined,
						model: spec.model,
					});
					return job.id;
				}),
			);

			let finished: { status: string; error?: string; costUsd?: number } | undefined;
			for (let i = 0; i < 90 && !finished; i++) {
				await step.sleep(`wait for clip ${i}`, i < 6 ? "10 seconds" : "20 seconds");
				const job = await step.do(`check clip ${i}`, patient, () => getVideoJob(jobId));
				if (job.status !== "pending" && job.status !== "in_progress") finished = job;
			}
			if (!finished) throw new Error("The clip took too long to generate");
			if (finished.status !== "completed") throw new Error(finished.error ?? `Clip generation ${finished.status}`);
			const costUsd = finished.costUsd;

			await step.do("store clip", patient, async () => {
				const asset = (await db.query.assets.findFirst({ where: eq(schema.assets.id, assetId) }))!;
				if (asset.status === "ready") return;
				const spec = asset.generation;
				const response = await downloadVideo(jobId);
				const body = response.headers.has("content-length") ? response.body! : new Uint8Array(await response.arrayBuffer());
				await storeAsset(asset, body, "video/mp4", { meta: { model: (spec?.type === "video" && spec.model) || VIDEO_MODEL, provider: "openrouter" } });
				const seconds = spec?.type === "video" ? spec.seconds : 0;
				const resolution = spec?.type === "video" ? spec.resolution : "720p";
				await recordUsage({
					userId: asset.createdBy,
					projectId: asset.projectId,
					ref: asset.id,
					kind: "video",
					provider: "openrouter",
					model: VIDEO_MODEL,
					quantity: seconds,
					unit: "seconds",
					costUsd: costUsd ?? seconds * (CLIP_USD_PER_SECOND[resolution] ?? CLIP_USD_PER_SECOND["1080p"]!),
					estimated: costUsd === undefined,
				});
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await step.do("mark failed", () => failAsset(assetId, message));
		}
	}
}
