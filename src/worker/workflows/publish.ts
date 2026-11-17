/**
 * Publishes one render to YouTube: opens a resumable upload session, sends
 * the file from R2 in chunks (each chunk is its own step, and asks YouTube
 * where it got to first, so a retried step never resends or skips bytes),
 * then adds the optional extras. Captions, thumbnail and playlist failures
 * become warnings: by then the video is already on YouTube.
 */
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep, env } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import { isRetryable } from "../lib/util.ts";
import {
	type UploadProgress,
	type UploadedVideo,
	type VideoResource,
	addToPlaylist,
	insertCaptions,
	setThumbnail,
	startUpload,
	uploadChunk,
	uploadStatus,
} from "../providers/youtube.ts";
import { assetsById } from "../services/assets.ts";
import { readObject } from "../services/storage.ts";
import { accessTokenFor, captionsSrt, composeDescription, creditsFor, youtubeSafe } from "../services/youtube.ts";

/** 32 MiB: a multiple of 256 KiB, as YouTube requires of every chunk but the last. */
const CHUNK_BYTES = 32 * 1024 * 1024;
const network = { retries: { limit: 5, delay: "10 seconds", backoff: "exponential" }, timeout: "10 minutes" } as const;
const extra = { retries: { limit: 2, delay: "20 seconds", backoff: "exponential" }, timeout: "5 minutes" } as const;

/** Permanent failures (bad input, revoked access, quota) are not retried. */
async function attempt<T>(work: () => Promise<T>): Promise<T> {
	try {
		return await work();
	} catch (error) {
		if (isRetryable(error)) throw error;
		throw new NonRetryableError(error instanceof Error ? error.message : String(error));
	}
}

const loadUpload = (uploadId: string) => db.query.youtubeUploads.findFirst({ where: eq(schema.youtubeUploads.id, uploadId) });
const update = (uploadId: string, values: Partial<typeof schema.youtubeUploads.$inferInsert>) =>
	db.update(schema.youtubeUploads).set(values).where(eq(schema.youtubeUploads.id, uploadId));

async function tokenFor(uploadId: string): Promise<string> {
	const upload = await loadUpload(uploadId);
	const channel = upload?.connectionId ? await db.query.youtubeChannels.findFirst({ where: eq(schema.youtubeChannels.id, upload.connectionId) }) : undefined;
	if (!channel) throw new NonRetryableError("The YouTube channel was disconnected before the upload finished");
	return accessTokenFor(channel);
}

export class PublishWorkflow extends WorkflowEntrypoint<Env, { uploadId: string }> {
	async run(event: WorkflowEvent<{ uploadId: string }>, step: WorkflowStep) {
		const { uploadId } = event.payload;
		try {
			const session = await step.do("start", network, () =>
				attempt(async () => {
					const upload = await loadUpload(uploadId);
					// "uploading" too: a retry of this step after the status was saved must still return a session.
					if (!upload || (upload.status !== "queued" && upload.status !== "uploading")) return null;
					const render = await db.query.renders.findFirst({ where: eq(schema.renders.id, upload.renderId) });
					if (!render?.r2Key || render.status !== "done" || !render.bytes) throw new NonRetryableError("The render is no longer available");
					const request = upload.request;
					const resource: VideoResource = {
						snippet: {
							title: youtubeSafe(request.title),
							description: composeDescription(request.description, await creditsFor(upload.projectId, render.timeline)),
							tags: request.tags.length ? request.tags : undefined,
							categoryId: request.categoryId,
							defaultLanguage: request.language,
							defaultAudioLanguage: request.language,
						},
						status: {
							privacyStatus: request.privacy,
							publishAt: request.publishAt,
							selfDeclaredMadeForKids: request.madeForKids,
							containsSyntheticMedia: request.containsSyntheticMedia,
							embeddable: true,
							license: "youtube",
						},
					};
					const uri = await startUpload(await tokenFor(uploadId), resource, render.bytes, request.notifySubscribers);
					await update(uploadId, { status: "uploading", startedAt: new Date(), error: null });
					return { uri, key: render.r2Key, size: render.bytes };
				}),
			);
			if (!session) return;

			let video: UploadedVideo | undefined;
			for (let i = 0; i < 10_000 && !video; i++) {
				const progress: UploadProgress = await step.do(`chunk ${i}`, network, () =>
					attempt(async () => {
						const token = await tokenFor(uploadId);
						// Ask first: a previous attempt of this step may have landed some or all of its bytes.
						const current = await uploadStatus(token, session.uri, session.size);
						if (current.done) return current;
						const offset = current.received;
						const length = Math.min(CHUNK_BYTES, session.size - offset);
						const object = await env.MEDIA.get(session.key, { range: { offset, length } });
						if (!object) throw new NonRetryableError("The rendered file is missing from storage");
						const result = await uploadChunk(token, session.uri, await object.arrayBuffer(), offset, session.size);
						const received = result.done ? session.size : result.received;
						await update(uploadId, { progress: Math.min(99, Math.floor((received / session.size) * 100)) });
						return result;
					}),
				);
				if (progress.done) video = progress.video;
			}
			if (!video) throw new Error("The upload did not finish");
			const youtubeVideoId = video.id;

			const requested = await step.do("uploaded", async () => {
				await update(uploadId, { status: "finishing", progress: 100, youtubeVideoId });
				return (await loadUpload(uploadId))!.request;
			});

			const warnings: string[] = [];
			if (video.privacyStatus && video.privacyStatus !== requested.privacy) {
				warnings.push(`Requested ${requested.privacy}, but YouTube set the video to ${video.privacyStatus}. Check it in YouTube Studio.`);
			}

			const optional = async (label: string, work: () => Promise<void>) => {
				try {
					await step.do(label, extra, () => attempt(work));
				} catch (error) {
					warnings.push(`${label}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 400));
				}
			};

			if (requested.captions) {
				await optional("captions", async () => {
					const upload = (await loadUpload(uploadId))!;
					const render = await db.query.renders.findFirst({ where: eq(schema.renders.id, upload.renderId) });
					const srt = render ? captionsSrt(render.timeline) : "";
					if (!srt) return;
					await insertCaptions(await tokenFor(uploadId), { videoId: youtubeVideoId, language: requested.language ?? "en", name: "Narration", srt });
				});
			}
			if (requested.thumbnailAssetId) {
				await optional("thumbnail", async () => {
					const upload = (await loadUpload(uploadId))!;
					const asset = (await assetsById(upload.projectId, [requested.thumbnailAssetId!])).get(requested.thumbnailAssetId!);
					if (!asset?.r2Key || asset.status !== "ready") throw new Error("The thumbnail image is no longer available");
					const { bytes, contentType } = await readObject(asset.r2Key);
					await setThumbnail(await tokenFor(uploadId), youtubeVideoId, bytes, contentType);
				});
			}
			if (requested.playlistId) {
				await optional("playlist", async () => addToPlaylist(await tokenFor(uploadId), requested.playlistId!, youtubeVideoId));
			}

			await step.do("done", () => update(uploadId, { status: "done", warnings, finishedAt: new Date() }).then(() => undefined));
		} catch (error) {
			const message = (error instanceof Error ? error.message : String(error)).replace(/^NonRetryableError:\s*/, "");
			await step.do("mark failed", () => update(uploadId, { status: "failed", error: message.slice(0, 1000), finishedAt: new Date() }).then(() => undefined));
		}
	}
}
