/**
 * Hosts one render: Stream fetches the file from a signed R2 link, the
 * workflow waits for Stream to finish processing it, then adds captions.
 * Captions failing is a warning: by then the video plays.
 *
 * Retries must never leave a second copy behind (it would be stored at our
 * cost), so the source link is the same on every attempt: Stream refuses a
 * link it has already taken, and the copy it made is then found by its meta.
 */
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep, env } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { eq } from "drizzle-orm";
import { captionsVtt } from "../../../shared/hosting.ts";
import { db, schema } from "../db/client.ts";
import { isRetryable } from "../lib/util.ts";
import { deleteStreamCopy } from "../services/hosting.ts";
import { signedUrl } from "../services/storage.ts";

const network = { retries: { limit: 5, delay: "10 seconds", backoff: "exponential" }, timeout: "5 minutes" } as const;
const extra = { retries: { limit: 2, delay: "20 seconds", backoff: "exponential" }, timeout: "2 minutes" } as const;
/** Stream processes a few minutes of video in a few minutes; give up after an hour. */
const MAX_CHECKS = 240;
/** How long the source link works: Stream may queue the fetch for a while. */
const SOURCE_LINK_SECONDS = 24 * 3600;

async function attempt<T>(work: () => Promise<T>): Promise<T> {
	try {
		return await work();
	} catch (error) {
		if (error instanceof NonRetryableError || isRetryable(error)) throw error;
		const status = (error as { statusCode?: number }).statusCode;
		// Stream's own hiccups (5xx, rate limits) are worth another go; bad input is not.
		if (status && (status >= 500 || status === 429)) throw error;
		throw new NonRetryableError(error instanceof Error ? error.message : String(error));
	}
}

const load = (hostedId: string) => db.query.hostedVideos.findFirst({ where: eq(schema.hostedVideos.id, hostedId) });
const update = (hostedId: string, values: Partial<typeof schema.hostedVideos.$inferInsert>) =>
	db.update(schema.hostedVideos).set(values).where(eq(schema.hostedVideos.id, hostedId));

/** The copy Stream made from an earlier attempt, found by the hosted id in its meta. */
async function findCopy(hostedId: string, since: Date): Promise<StreamVideo | undefined> {
	const videos = await env.STREAM.videos.list({ after: new Date(since.getTime() - 60_000).toISOString(), limit: 1000 });
	return videos.find((video) => video.meta?.retween === hostedId);
}

export class HostingWorkflow extends WorkflowEntrypoint<Env, { hostedId: string }> {
	async run(event: WorkflowEvent<{ hostedId: string }>, step: WorkflowStep) {
		const { hostedId } = event.payload;
		try {
			const uid = await step.do("upload", network, () =>
				attempt(async () => {
					const row = await load(hostedId);
					if (!row) return null;
					if (row.streamUid) return row.streamUid;
					const render = await db.query.renders.findFirst({ where: eq(schema.renders.id, row.renderId) });
					if (!render?.r2Key || render.status !== "done") throw new NonRetryableError("The export is no longer available");
					// Fixed expiry, so every attempt sends the same link.
					const source = await signedUrl(render.r2Key, { expiresIn: Math.floor((row.createdAt.getTime() + SOURCE_LINK_SECONDS * 1000 - Date.now()) / 1000) });
					let video: StreamVideo | undefined;
					try {
						video = await env.STREAM.upload(source, {
							creator: row.userId,
							requireSignedURLs: true,
							meta: { name: row.title.slice(0, 200), retween: row.id, video: row.videoId, render: row.renderId },
						});
					} catch (error) {
						if (!(error instanceof Error && error.name === "AlreadyUploadedError")) throw error;
						video = await findCopy(row.id, row.createdAt);
						if (!video) throw new NonRetryableError("Stream already took this export, but the copy could not be found");
					}
					await update(hostedId, { streamUid: video.id, streamHost: new URL(video.hlsPlaybackUrl).origin, status: "processing", error: null });
					return video.id;
				}),
			);
			if (!uid) return;

			let ready: { duration: number } | undefined;
			for (let i = 0; i < MAX_CHECKS && !ready; i++) {
				const state = await step.do(`check ${i}`, network, () =>
					attempt(async () => {
						const video = await env.STREAM.video(uid).details();
						if (video.status?.state === "error") {
							throw new NonRetryableError(`Stream could not process the export: ${video.status.errorReasonText || video.status.errorReasonCode || "unknown error"}`);
						}
						return { ready: video.readyToStream, duration: video.duration };
					}),
				);
				if (state.ready) ready = { duration: state.duration };
				else await step.sleep(`wait ${i}`, "15 seconds");
			}
			if (!ready) throw new Error("Stream did not finish processing the export within an hour");

			const warnings: string[] = [];
			const row = await step.do("processed", async () => {
				const current = (await load(hostedId))!;
				// Stream's own measure is what it bills storage on; keep the export's length if it reports none.
				if (ready.duration > 0) await update(hostedId, { durationSec: ready.duration });
				return { captionsLanguage: current.captionsLanguage, renderId: current.renderId };
			});

			if (row.captionsLanguage) {
				try {
					await step.do("captions", extra, () =>
						attempt(async () => {
							const render = await db.query.renders.findFirst({ where: eq(schema.renders.id, row.renderId) });
							const vtt = render ? captionsVtt(render.timeline) : "";
							if (!vtt) return;
							const captions = env.STREAM.video(uid).captions;
							// A retry after Stream took the file must replace it, not fail on the duplicate.
							await captions.delete(row.captionsLanguage!).catch(() => undefined);
							await captions.upload(row.captionsLanguage!, new Blob([vtt], { type: "text/vtt" }).stream());
						}),
					);
				} catch (error) {
					warnings.push(`captions: ${error instanceof Error ? error.message : String(error)}`.slice(0, 400));
					await step.do("no captions", () => update(hostedId, { captionsLanguage: null }).then(() => undefined));
				}
			}

			await step.do("done", () => update(hostedId, { status: "ready", warnings, readyAt: new Date() }).then(() => undefined));
		} catch (error) {
			const message = (error instanceof Error ? error.message : String(error)).replace(/^NonRetryableError:\s*/, "");
			await step.do("mark failed", async () => {
				const row = await load(hostedId);
				// A copy that will never play should not be stored. Its id is kept if it could not be
				// deleted now, so hosting.delete (or deleting the video) can still remove it.
				const deleted = row?.streamUid ? await deleteStreamCopy(row.streamUid).then(() => true, () => false) : true;
				await update(hostedId, { status: "failed", error: message.slice(0, 1000), ...(deleted ? { streamUid: null } : {}) });
			});
		}
	}
}
