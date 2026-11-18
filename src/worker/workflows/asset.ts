/**
 * Fills in one pending asset. Everything except generated video is a single
 * step; a video clip is a remote job that is submitted, polled and downloaded.
 */
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import { failureMessage, isRetryable } from "../lib/util.ts";
import { VIDEO_MODEL, downloadVideo, getVideoJob, submitVideo } from "../providers/openrouter.ts";
import { assetDataUrl, assetsById, executeGeneration, failAsset, storeAsset } from "../services/assets.ts";
import { OPENROUTER_CLIP_USD_PER_SECOND } from "../services/pricing.ts";
import { recordUsage } from "../services/usage.ts";

const once = { retries: { limit: 0, delay: 1000 }, timeout: "15 minutes" } as const;
// Rate limits are already waited out inside the provider calls; these retries cover longer outages and storage blips.
const patient = { retries: { limit: 3, delay: "20 seconds", backoff: "exponential" }, timeout: "15 minutes" } as const;

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

			let finished: { status: string; error?: string; costUsd?: number; generationId?: string } | undefined;
			for (let i = 0; i < 90 && !finished; i++) {
				await step.sleep(`wait for clip ${i}`, i < 6 ? "10 seconds" : "20 seconds");
				const job = await step.do(`check clip ${i}`, patient, () => getVideoJob(jobId));
				if (job.status !== "pending" && job.status !== "in_progress") finished = job;
			}
			if (!finished) throw new Error("The clip took too long to generate");
			const job = finished;

			// Charged once the job ends, before downloading, so download retries are not charged again. A job that
			// failed is charged only if OpenRouter reports a cost for it.
			await step.do("record clip cost", patient, async () => {
				const asset = (await db.query.assets.findFirst({ where: eq(schema.assets.id, assetId) }))!;
				const spec = asset.generation;
				if (spec?.type !== "video") return;
				if (job.status !== "completed" && !job.costUsd) return;
				await recordUsage({
					userId: asset.createdBy,
					projectId: asset.projectId,
					videoId: asset.meta.videoId,
					ref: asset.id,
					kind: "video",
					provider: "openrouter",
					model: spec.model ?? VIDEO_MODEL,
					quantity: spec.seconds,
					unit: "seconds",
					costUsd: job.costUsd ?? spec.seconds * (OPENROUTER_CLIP_USD_PER_SECOND[spec.resolution] ?? OPENROUTER_CLIP_USD_PER_SECOND["1080p"]!),
					basis: job.costUsd === undefined ? "list" : "vendor",
					vendorRef: job.generationId ?? jobId,
					dedupeKey: `openrouter-video:${jobId}`,
				});
			});
			if (job.status !== "completed") throw new Error(job.error ?? `Clip generation ${job.status}`);

			await step.do("store clip", patient, async () => {
				const asset = (await db.query.assets.findFirst({ where: eq(schema.assets.id, assetId) }))!;
				if (asset.status === "ready") return;
				const spec = asset.generation;
				const response = await downloadVideo(jobId);
				const body = response.headers.has("content-length") ? response.body! : new Uint8Array(await response.arrayBuffer());
				await storeAsset(asset, body, "video/mp4", { meta: { model: (spec?.type === "video" && spec.model) || VIDEO_MODEL, provider: "openrouter" } });
			});
		} catch (error) {
			// Our own errors are written for the person; a raw database or network error is not, and is logged instead.
			const message = failureMessage(error, `asset ${assetId}`);
			await step.do("mark failed", () => failAsset(assetId, message));
		}
	}
}
