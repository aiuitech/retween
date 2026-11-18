/**
 * Processes one recording (see services/footage.ts): the container converts
 * it and measures it, the outputs are copied into R2 in parts, and the voice
 * track is transcribed.
 */
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep, env } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import { isRetryable } from "../lib/util.ts";
import { TRANSCRIBE_MODEL, transcribe } from "../providers/elevenlabs.ts";
import { rendererFetch, stopRenderer } from "../renderer.ts";
import { createAsset } from "../services/assets.ts";
import { type FootageMeta, footageInstance, footageOf, updateFootage } from "../services/footage.ts";
import { ELEVENLABS } from "../services/pricing.ts";
import { assetKey, signedUrl } from "../services/storage.ts";
import { recordUsage } from "../services/usage.ts";

const PART_BYTES = 16 * 1024 * 1024;
/** Largest voice track sent to the transcriber in the request itself. */
const MAX_SENT_BYTES = 40 * 1024 * 1024;
const network = { retries: { limit: 4, delay: "5 seconds", backoff: "exponential" }, timeout: "5 minutes" } as const;
const patient = { retries: { limit: 2, delay: "20 seconds", backoff: "exponential" }, timeout: "15 minutes" } as const;

/** What the container reports when it is done (renderer/server/footage.ts). */
interface FootageResult {
	durationSec: number;
	hasVideo: boolean;
	hasAudio: boolean;
	video?: { width: number; height: number; fps: number; sourceFps: number; variableFrameRate: boolean; rotation: number; hdr: boolean; sourceCodec: string; bytes: number };
	audio?: { bytes: number; sourceLufs: number | null; lufs: number | null; peakDbfs: number | null; channels: 1 };
	shots: number[];
	silences: [number, number][];
	warnings: string[];
}

interface JobStatus {
	state: "running" | "done" | "error";
	stage?: string;
	progress?: number;
	error?: string;
	result?: FootageResult;
}

const STAGES: Record<string, string> = { downloading: "Downloading", probing: "Reading the file", transcoding: "Converting the picture", audio: "Levelling the sound" };

/** Turns permanent failures into errors that are not retried. */
async function attempt<T>(work: () => Promise<T>): Promise<T> {
	try {
		return await work();
	} catch (error) {
		if (isRetryable(error)) throw error;
		throw new NonRetryableError(error instanceof Error ? error.message : String(error));
	}
}

const loadAsset = async (assetId: string) => {
	const asset = await db.query.assets.findFirst({ where: eq(schema.assets.id, assetId) });
	if (!asset) throw new NonRetryableError("The asset was deleted");
	return asset;
};

export class FootageWorkflow extends WorkflowEntrypoint<Env, { assetId: string; runId: string }> {
	async run(event: WorkflowEvent<{ assetId: string; runId: string }>, step: WorkflowStep) {
		const { assetId, runId } = event.payload;
		const instance = footageInstance(assetId);
		/** A newer run (footage.process again) takes over; this one stops quietly. */
		const current = async () => footageOf(await loadAsset(assetId))?.runId === runId;
		try {
			const started = await step.do("start", network, async () => {
				const asset = await loadAsset(assetId);
				const footage = footageOf(asset);
				if (footage?.runId !== runId) return false;
				// Reprocessing starts again from the file as it was uploaded.
				const sourceKey = footage.originalKey ?? asset.r2Key;
				if (!sourceKey) throw new NonRetryableError("The asset has no file");
				const response = await rendererFetch(instance, "/footage", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ jobId: runId, src: await signedUrl(sourceKey, { expiresIn: 3 * 3600 }), denoise: footage.options.denoise }),
				});
				if (!response.ok && response.status !== 409) throw new Error(`The processor refused the job (${response.status}): ${(await response.text()).slice(0, 300)}`);
				if (response.status === 409) throw new Error("The processor is busy with another job");
				await updateFootage(assetId, { stage: "downloading", progress: 0 });
				return true;
			});
			if (!started) return;

			let result: FootageResult | undefined;
			let last = "";
			for (let i = 0; i < 1500 && !result; i++) {
				await step.sleep(`wait ${i}`, i < 10 ? "3 seconds" : "6 seconds");
				const status = await step.do(`status ${i}`, network, async () => {
					const response = await rendererFetch(instance, `/footage/status?jobId=${encodeURIComponent(runId)}`);
					if (response.status === 404) return { state: "error", error: "The processor restarted before it finished. Run footage.process again." } satisfies JobStatus;
					if (!response.ok) throw new Error(`Processor status ${response.status}`);
					return (await response.json()) as JobStatus;
				});
				if (status.state === "error") throw new NonRetryableError(status.error ?? "Processing failed");
				if (status.state === "done") result = status.result;
				const marker = `${status.stage}:${Math.round((status.progress ?? 0) * 20)}`;
				if (marker !== last && status.state === "running") {
					last = marker;
					await step.do(`progress ${i}`, async () => {
						if (await current()) await updateFootage(assetId, { stage: STAGES[status.stage ?? ""] ?? status.stage, progress: Math.round((status.progress ?? 0) * 100) / 100 });
					});
				}
			}
			if (!result) throw new NonRetryableError("Processing did not finish in time");
			const output = result;

			// --- copy the outputs into R2 ----------------------------------------------------
			const copy = async (file: "video" | "audio", key: string, bytes: number, contentType: string) => {
				const upload = await step.do(`begin ${file}`, async () => {
					const multipart = await env.MEDIA.createMultipartUpload(key, { httpMetadata: { contentType } });
					return { uploadId: multipart.uploadId };
				});
				const parts: { partNumber: number; etag: string }[] = [];
				for (let offset = 0, partNumber = 1; offset < bytes; offset += PART_BYTES, partNumber++) {
					const end = Math.min(bytes, offset + PART_BYTES) - 1;
					parts.push(
						await step.do(`${file} part ${partNumber}`, network, async () => {
							const response = await rendererFetch(instance, `/footage/output?jobId=${encodeURIComponent(runId)}&file=${file}`, { headers: { range: `bytes=${offset}-${end}` } });
							if (response.status !== 206 && response.status !== 200) throw new Error(`Processor output ${response.status}`);
							const body = await response.arrayBuffer();
							if (body.byteLength !== end - offset + 1) throw new Error("The processor returned a short read");
							const part = await env.MEDIA.resumeMultipartUpload(key, upload.uploadId).uploadPart(partNumber, body);
							return { partNumber: part.partNumber, etag: part.etag };
						}),
					);
				}
				await step.do(`finish ${file}`, () => env.MEDIA.resumeMultipartUpload(key, upload.uploadId).complete(parts).then(() => undefined));
			};

			const keys = await step.do("plan outputs", async () => {
				const asset = await loadAsset(assetId);
				const footage = footageOf(asset)!;
				let audioAssetId = footage.audioAssetId;
				if (output.hasAudio && !audioAssetId) {
					const voice = await createAsset({
						projectId: asset.projectId,
						createdBy: asset.createdBy,
						kind: "audio",
						name: `Voice from ${asset.name}`.slice(0, 200),
						source: "upload",
						tags: ["footage-voice"],
						description: `The sound of ${asset.name}, levelled. Scenes that use that footage play from it.`,
						meta: { sourceAssetId: asset.id },
					});
					audioAssetId = voice.id;
					await updateFootage(assetId, { audioAssetId });
				}
				return {
					video: output.hasVideo ? assetKey(asset.projectId, asset.id, "edit.mp4") : undefined,
					audio: audioAssetId ? { assetId: audioAssetId, key: assetKey(asset.projectId, audioAssetId, "m4a") } : undefined,
				};
			});
			if (keys.video && output.video) await copy("video", keys.video, output.video.bytes, "video/mp4");
			if (keys.audio && output.audio) await copy("audio", keys.audio.key, output.audio.bytes, "audio/mp4");

			await step.do("store outputs", async () => {
				const asset = await loadAsset(assetId);
				const footage = footageOf(asset)!;
				const original = footage.originalKey
					? { originalKey: footage.originalKey, originalBytes: footage.originalBytes, originalContentType: footage.originalContentType }
					: { originalKey: asset.r2Key ?? undefined, originalBytes: asset.bytes ?? undefined, originalContentType: asset.contentType ?? undefined };
				const patch: Partial<FootageMeta> = {
					durationSec: output.durationSec,
					hasVideo: output.hasVideo,
					hasAudio: output.hasAudio,
					shots: output.shots,
					silences: output.silences,
					warnings: output.warnings.length ? output.warnings.map((warning) => warning.replace(/\?[^\s"')]+/g, "")) : undefined,
					audio: output.audio && { sourceLufs: output.audio.sourceLufs, lufs: output.audio.lufs, peakDbfs: output.audio.peakDbfs },
				};
				if (keys.video && output.video) {
					const { bytes, ...video } = output.video;
					// The edit master becomes the asset's file; the upload is kept beside it.
					await updateFootage(assetId, { ...patch, ...original, video }, {
						r2Key: keys.video,
						contentType: "video/mp4",
						bytes,
						width: output.video.width,
						height: output.video.height,
						durationMs: Math.round(output.durationSec * 1000),
					});
				} else {
					await updateFootage(assetId, patch, { durationMs: Math.round(output.durationSec * 1000) });
				}
				if (keys.audio && output.audio) {
					await db
						.update(schema.assets)
						.set({ status: "ready", r2Key: keys.audio.key, contentType: "audio/mp4", bytes: output.audio.bytes, durationMs: Math.round(output.durationSec * 1000), error: null })
						.where(eq(schema.assets.id, keys.audio.assetId));
				}
			});
			await step.do("stop processor", () => stopRenderer(instance));

			// --- transcribe ----------------------------------------------------------------------
			if (keys.audio && output.hasAudio) {
				await step.do("progress transcribing", () => updateFootage(assetId, { stage: "Transcribing", progress: 0 }));
				// A failed transcription leaves the footage usable (cut by seconds); footage.process tries again.
				await step.do("transcribe", patient, () =>
					attempt(async () => {
						const asset = await loadAsset(assetId);
						const footage = footageOf(asset)!;
						// Up to about 40 minutes of voice is sent as a file; longer ones are fetched by ElevenLabs from a link.
						const head = await env.MEDIA.head(keys.audio!.key);
						if (!head) throw new Error("The voice track is missing from storage");
						const small = head.size <= MAX_SENT_BYTES;
						const object = small ? await env.MEDIA.get(keys.audio!.key) : null;
						const transcript = await transcribe({
							file: object ? new Blob([await object.arrayBuffer()], { type: "audio/mp4" }) : undefined,
							sourceUrl: small ? undefined : await signedUrl(keys.audio!.key, { expiresIn: 3 * 3600 }),
							language: footage.options.language,
							keyterms: footage.options.keyterms,
							speakers: footage.options.speakers,
						});
						const seconds = transcript.durationSec ?? output.durationSec;
						const perHour = ELEVENLABS.transcriptionUsdPerHour + (footage.options.keyterms?.length ? ELEVENLABS.transcriptionKeytermsUsdPerHour : 0);
						await recordUsage({
							userId: asset.createdBy,
							projectId: asset.projectId,
							ref: asset.id,
							kind: "transcription",
							provider: "elevenlabs",
							model: TRANSCRIBE_MODEL,
							quantity: seconds,
							unit: "seconds",
							costUsd: (seconds / 3600) * perHour,
							basis: "list",
							vendorRef: transcript.transcriptionId,
							dedupeKey: transcript.transcriptionId && `elevenlabs-stt:${transcript.transcriptionId}`,
						});
						await updateFootage(assetId, { language: transcript.language, transcribed: true, transcriptError: undefined }, {
							meta: { ...asset.meta, words: transcript.words, speakers: transcript.speakers, events: transcript.events },
						});
					}),
				).catch(async (error: unknown) => {
					const message = (error instanceof Error ? error.message : String(error)).replace(/^NonRetryableError:\s*/, "");
					await step.do("note transcription failure", () => updateFootage(assetId, { transcriptError: message.slice(0, 400) }));
				});
			}
			await step.do("finish", () => updateFootage(assetId, { status: "ready", stage: undefined, progress: 1, finishedAt: Date.now() }));
		} catch (error) {
			const message = (error instanceof Error ? error.message : String(error)).replace(/^NonRetryableError:\s*/, "");
			await step.do("mark failed", async () => {
				if (await current().catch(() => false)) await updateFootage(assetId, { status: "failed", stage: undefined, error: message.replace(/\?[^\s"')]+/g, "").slice(0, 600), finishedAt: Date.now() });
			});
		} finally {
			// Stopping the instance also discards its working files.
			await step.do("stop renderer", () => stopRenderer(instance));
		}
	}
}
