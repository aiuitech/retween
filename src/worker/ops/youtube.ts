import { env } from "cloudflare:workers";
import { and, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db/client.ts";
import { YOUTUBE_PRIVACY, type YoutubePublishRequest } from "../db/schema.ts";
import { AppError, badRequest, newId } from "../lib/util.ts";
import { revokeToken, videoStatus } from "../providers/youtube.ts";
import { assetsById } from "../services/assets.ts";
import { getRender } from "../services/renders.ts";
import { getVideo } from "../services/videos.ts";
import {
	type YoutubeUpload,
	accessTokenFor,
	channelView,
	getUpload,
	listChannels,
	refreshTokenOf,
	resolveChannel,
	uploadView,
	uploadsForVideo,
} from "../services/youtube.ts";
import { defineOp, waitSeconds } from "./registry.ts";

const channel = z.string().optional().describe("Which connected channel: its id (ytc_…) or YouTube channel id (UC…). Optional when only one is connected");
const noAngleBrackets = (text: string) => !/[<>]/.test(text);

async function waitForUpload(upload: YoutubeUpload, seconds: number): Promise<YoutubeUpload> {
	const deadline = Date.now() + seconds * 1000;
	let current = upload;
	while (!["done", "failed"].includes(current.status) && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 2500));
		current = (await db.query.youtubeUploads.findFirst({ where: eq(schema.youtubeUploads.id, upload.id) })) ?? current;
	}
	return current;
}

export const youtubeOps = [
	defineOp({
		name: "youtube.connect",
		title: "Connect a YouTube channel",
		description:
			"Returns a link for the person to open in their browser. They sign in to Google, pick the channel (brand-account channels included) and allow Retween to upload. " +
			"Give them the link; you cannot complete this step yourself. Afterwards the channel appears in youtube.channels. Opening it again for a connected channel refreshes its access.",
		input: z.object({}),
		readOnly: true,
		handler: async (_input, { actor }) => ({
			url: `${env.APP_URL}/api/youtube/connect`,
			channels: (await listChannels(actor.id)).map(channelView),
			note: "Ask the person to open the url while signed in to Retween, then call youtube.channels to confirm.",
		}),
	}),

	defineOp({
		name: "youtube.channels",
		title: "List YouTube channels",
		description: "YouTube channels connected to this account. A channel marked needsReconnect must be connected again with youtube.connect before publishing to it.",
		input: z.object({}),
		readOnly: true,
		handler: async (_input, { actor }) => ({ channels: (await listChannels(actor.id)).map(channelView) }),
	}),

	defineOp({
		name: "youtube.disconnect",
		title: "Disconnect a YouTube channel",
		description: "Removes a connected channel and revokes Retween's access to it. Videos already on YouTube are not touched.",
		input: z.object({ channel: z.string().describe("Channel id (ytc_…) or YouTube channel id (UC…)") }),
		destructive: true,
		handler: async (input, { actor }) => {
			const found = await resolveChannel(actor, input.channel);
			await revokeToken(await refreshTokenOf(found).catch(() => ""));
			await db.delete(schema.youtubeChannels).where(eq(schema.youtubeChannels.id, found.id));
			return { disconnected: found.id, title: found.title };
		},
	}),

	defineOp({
		name: "youtube.publish",
		title: "Publish to YouTube",
		description:
			"Uploads a finished render to a connected YouTube channel. Credit lines required by third-party media are appended to the description automatically, " +
			"and captions timed to the narration are added (captions: false to skip). Uploads default to private so the person can review in YouTube Studio first; " +
			"only use unlisted or public, or a publishAt time, when the person asked for it. Use a 9:16 render of three minutes or less for a YouTube Short. " +
			"Follow progress with youtube.get.",
		input: z.object({
			renderId: z.string().describe("A finished render (rnd_…) from video.render / render.list"),
			channel,
			title: z.string().min(1).max(100).refine(noAngleBrackets, "YouTube does not allow < or > in titles").optional().describe("Defaults to the video's title"),
			description: z.string().max(4800).default("").describe("Shown under the video. Required credits are added after it"),
			tags: z
				.array(z.string().min(1).max(100))
				.max(30)
				.default([])
				.refine((tags) => tags.join(",").length <= 450, "Tags may total at most about 500 characters"),
			categoryId: z.string().regex(/^\d+$/).default("22").describe('YouTube category id, e.g. "22" People & Blogs, "27" Education, "28" Science & Technology'),
			privacy: z.enum(YOUTUBE_PRIVACY).default("private"),
			publishAt: z.iso
				.datetime({ offset: true })
				.optional()
				.describe("Schedule the video to go public at this time (ISO 8601). The upload stays private until then"),
			madeForKids: z.boolean().describe("Whether the video is made for children (YouTube requires this declaration; ask the person if unsure)"),
			containsSyntheticMedia: z
				.boolean()
				.describe(
					"Whether the video contains realistic altered or AI-generated people, places or events that a viewer could mistake for real. Generated photoreal footage or a cloned real voice: true. Stylised graphics, text and a stock narrator voice: usually false. Ask the person if unsure",
				),
			notifySubscribers: z.boolean().default(true),
			language: z.string().min(2).max(10).optional().describe("Language of the title, description and speech, e.g. en. Defaults to the brand's narration language"),
			captions: z.boolean().default(true).describe("Upload captions timed to the narration"),
			thumbnailAssetId: z
				.string()
				.nullable()
				.optional()
				.describe("An image asset to use as the thumbnail (1280×720 recommended). Defaults to the video's thumbnail (thumbnail.design); null for none. Custom thumbnails need a verified YouTube channel"),
			playlistId: z.string().optional().describe("Add the video to this playlist on the channel"),
			allowDuplicate: z.boolean().default(false).describe("Publish even though this render was already sent to this channel"),
			waitSeconds,
		}),
		handler: async (input, { actor }) => {
			const { render, project } = await getRender(actor, input.renderId);
			if (render.status !== "done" || !render.r2Key) {
				throw new AppError(409, `Render ${render.id} is ${render.status}; publish it once it is done.`, "not_ready");
			}
			const target = await resolveChannel(actor, input.channel);
			// Fails early, with a clear message, when access has lapsed.
			await accessTokenFor(target);

			if (!input.allowDuplicate) {
				const previous = await db.query.youtubeUploads.findFirst({
					where: and(eq(schema.youtubeUploads.renderId, render.id), eq(schema.youtubeUploads.channelId, target.channelId), ne(schema.youtubeUploads.status, "failed")),
				});
				if (previous) {
					throw new AppError(409, `This render was already sent to "${target.title}" (${previous.id}). Pass allowDuplicate: true to upload it again.`, "duplicate", {
						upload: uploadView(previous),
					});
				}
			}

			let privacy = input.privacy;
			if (input.publishAt) {
				if (new Date(input.publishAt).getTime() < Date.now() + 15 * 60 * 1000) throw badRequest("publishAt must be at least 15 minutes in the future");
				// YouTube only schedules private videos.
				privacy = "private";
			}
			const { video } = await getVideo(actor, render.videoId);
			// The video's own thumbnail goes up with it unless another (or none) was asked for.
			const thumbnailAssetId = input.thumbnailAssetId === null ? undefined : (input.thumbnailAssetId ?? video.thumbnailAssetId ?? undefined);
			if (thumbnailAssetId) {
				const thumbnail = (await assetsById(project.id, [thumbnailAssetId])).get(thumbnailAssetId);
				if (!thumbnail || thumbnail.kind !== "image" || thumbnail.status !== "ready") throw badRequest("thumbnailAssetId must be a ready image asset in this project");
				if (!["image/jpeg", "image/png"].includes(thumbnail.contentType ?? "")) throw badRequest("YouTube thumbnails must be JPEG or PNG");
			}

			const request: YoutubePublishRequest = {
				title: input.title ?? video.title.slice(0, 100),
				description: input.description,
				tags: input.tags,
				categoryId: input.categoryId,
				privacy,
				publishAt: input.publishAt ? new Date(input.publishAt).toISOString() : undefined,
				madeForKids: input.madeForKids,
				containsSyntheticMedia: input.containsSyntheticMedia,
				notifySubscribers: input.notifySubscribers,
				language: input.language ?? project.brand.narration?.language,
				captions: input.captions,
				thumbnailAssetId,
				playlistId: input.playlistId,
			};
			if (/[<>]/.test(request.title)) request.title = request.title.replace(/[<>]/g, "");

			const [upload] = await db
				.insert(schema.youtubeUploads)
				.values({
					id: newId("ytu"),
					userId: actor.id,
					projectId: project.id,
					videoId: render.videoId,
					renderId: render.id,
					connectionId: target.id,
					channelId: target.channelId,
					channelTitle: target.title,
					request,
				})
				.returning();
			await env.PUBLISH_WORKFLOW.create({ id: upload!.id, params: { uploadId: upload!.id } });
			const current = await waitForUpload(upload!, input.waitSeconds);
			return {
				upload: uploadView(current),
				...(["done", "failed"].includes(current.status) ? {} : { note: `Still uploading. Follow it with youtube.get (uploadId ${upload!.id}).` }),
			};
		},
	}),

	defineOp({
		name: "youtube.get",
		title: "Get a YouTube upload",
		description:
			"Progress of a YouTube upload. Once it is done, also reports what YouTube says now (privacy, processing, any rejection), unless live is false. Use waitSeconds to wait for it.",
		input: z.object({
			uploadId: z.string().describe("ytu_…"),
			live: z.boolean().default(true).describe("Ask YouTube for the video's current status once uploaded"),
			waitSeconds: waitSeconds.default(0),
		}),
		readOnly: true,
		handler: async (input, { actor }) => {
			const upload = await waitForUpload(await getUpload(actor, input.uploadId), input.waitSeconds);
			let youtube: object | undefined;
			if (input.live && upload.youtubeVideoId && upload.connectionId) {
				const connection = await db.query.youtubeChannels.findFirst({ where: eq(schema.youtubeChannels.id, upload.connectionId) });
				if (connection) {
					try {
						youtube = (await videoStatus(await accessTokenFor(connection), upload.youtubeVideoId)) ?? { deleted: true };
					} catch (error) {
						youtube = { unavailable: error instanceof Error ? error.message : "Could not reach YouTube" };
					}
				}
			}
			return { upload: uploadView(upload), ...(youtube ? { youtube } : {}) };
		},
	}),

	defineOp({
		name: "youtube.list",
		title: "List YouTube uploads",
		description: "Uploads of a video to YouTube, newest first.",
		input: z.object({ videoId: z.string().describe("vid_…") }),
		readOnly: true,
		handler: async (input, { actor }) => {
			const { video } = await getVideo(actor, input.videoId);
			return { uploads: (await uploadsForVideo(actor, video.id)).map(uploadView) };
		},
	}),
];
