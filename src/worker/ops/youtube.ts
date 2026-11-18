import { env } from "cloudflare:workers";
import { and, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db/client.ts";
import { YOUTUBE_PRIVACY, type YoutubePublishRequest } from "../db/schema.ts";
import { AppError, badRequest, newId, notFound } from "../lib/util.ts";
import { ANALYTICS_SCOPE, retention, revokeToken, videoStatus } from "../providers/youtube.ts";
import { sceneRetention, worstScenes } from "../../../shared/retention.ts";
import { sceneSummary } from "../services/reviews.ts";
import { assetsById } from "../services/assets.ts";
import { chapterBlock, chaptersFor } from "../../../shared/publish.ts";
import { preflight } from "../services/publish.ts";
import { getRender } from "../services/renders.ts";
import { approvedNow } from "../services/reviews.ts";
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

/** Chapters go after the description and before the credits, unless the description already lists its own. */
const withChapters = (description: string, block: string) => (!block || /^0?0:00\s/m.test(description) ? description : [description.trim(), block].filter(Boolean).join("\n\n"));

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
		name: "youtube.preflight",
		title: "Check before publishing",
		description:
			"Free. Everything worth knowing before youtube.publish, worst first: whether it will be a Short, whether the export is of the current cut, " +
			"whether the person approved it (review.request), the thumbnail, chapters, captions, credits, a duplicate upload and the daily upload limit. " +
			"Also suggests the containsSyntheticMedia answer from what the video is made of (generated clips, generated stills), with reasons.",
		input: z.object({ renderId: z.string().describe("A render (rnd_…) to publish"), channel }),
		readOnly: true,
		handler: async (input, { actor }) => {
			const { render } = await getRender(actor, input.renderId);
			const { video } = await getVideo(actor, render.videoId);
			const target = input.channel || (await listChannels(actor.id)).length === 1 ? await resolveChannel(actor, input.channel).catch(() => undefined) : undefined;
			const result = await preflight(render, video, { channelId: target?.channelId });
			return {
				...result,
				...(target ? { channel: channelView(target) } : (await listChannels(actor.id)).length ? {} : { note: "No YouTube channel is connected yet: youtube.connect gives the person a link." }),
			};
		},
	}),

	defineOp({
		name: "youtube.publish",
		title: "Publish to YouTube",
		description:
			"Uploads a finished render to a connected YouTube channel. Credit lines required by third-party media are appended to the description automatically, " +
			"and captions timed to the narration are added (captions: false to skip). Uploads default to private so the person can review in YouTube Studio first; " +
			"only use unlisted or public, or a publishAt time, when the person asked for it, and those need the person's approval of the cut (review.request) or personApproved. " +
				"The video's thumbnail and its chapters go up with it. Run youtube.preflight first. Use a 9:16 render of three minutes or less for a YouTube Short. " +
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
			chapters: z.boolean().default(true).describe("List the chapters (scenes with a chapter title) with their times in the description"),
			personApproved: z
				.boolean()
				.default(false)
				.describe("Unlisted, public or scheduled uploads need the person's approval of this cut: a review they approved, or set this when they approved it in some other way"),
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
			if ((privacy !== "private" || input.publishAt) && !input.personApproved && !(await approvedNow(video)).approved) {
				throw new AppError(
					409,
					"Nobody has approved this cut for anyone to see. Ask the person with review.request (or upload it private). If they approved it another way, pass personApproved: true.",
					"not_approved",
				);
			}
			// The video's own thumbnail goes up with it unless another (or none) was asked for.
			const thumbnailAssetId = input.thumbnailAssetId === null ? undefined : (input.thumbnailAssetId ?? video.thumbnailAssetId ?? undefined);
			if (thumbnailAssetId) {
				const thumbnail = (await assetsById(project.id, [thumbnailAssetId])).get(thumbnailAssetId);
				if (!thumbnail || thumbnail.kind !== "image" || thumbnail.status !== "ready") throw badRequest("thumbnailAssetId must be a ready image asset in this project");
				if (!["image/jpeg", "image/png"].includes(thumbnail.contentType ?? "")) throw badRequest("YouTube thumbnails must be JPEG or PNG");
			}

			const request: YoutubePublishRequest = {
				title: input.title ?? video.title.slice(0, 100),
				description: withChapters(input.description, input.chapters ? chapterBlock(chaptersFor(render.timeline, video.storyboard).chapters) : ""),
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
		name: "youtube.retention",
		title: "Where viewers left",
		description:
			"YouTube's audience retention for an uploaded video, laid over its scenes: the share of viewers still watching at the start and end of each scene, " +
			"how fast each scene lost them, how it compares with similar videos, and the scenes that lost people fastest. " +
			"Use it to learn what to change next time, and pass saveLearning to keep the lesson as a pinned project note so future videos follow it. " +
			"Data appears a day or two after views come in. Needs the channel connected with analytics access (connect again if it was connected before).",
		input: z.object({
			uploadId: z.string().describe("ytu_… from youtube.publish or youtube.list"),
			saveLearning: z.boolean().default(false).describe("Save what the numbers say as a pinned learning note in the project"),
		}),
		readOnly: false,
		handler: async (input, { actor }) => {
			const upload = await getUpload(actor, input.uploadId);
			if (!upload.youtubeVideoId) throw new AppError(409, "This upload has not finished, so there is nothing to measure yet.", "not_ready");
			const connection = upload.connectionId ? await db.query.youtubeChannels.findFirst({ where: eq(schema.youtubeChannels.id, upload.connectionId) }) : undefined;
			if (!connection) throw new AppError(409, "The channel this went to is no longer connected. Connect it again with youtube.connect.", "youtube_reconnect");
			if (connection.scope && !connection.scope.split(" ").includes(ANALYTICS_SCOPE)) {
				throw new AppError(409, "This channel was connected without analytics access. Connect it again with youtube.connect and allow YouTube Analytics.", "youtube_analytics_scope");
			}
			const render = await db.query.renders.findFirst({ where: eq(schema.renders.id, upload.renderId) });
			if (!render) throw notFound("The export that was uploaded");
			const data = await retention(await accessTokenFor(connection), upload.youtubeVideoId, upload.finishedAt ?? upload.createdAt);
			if (!data.curve.length) {
				return { views: data.views, note: "YouTube has no retention data for this video yet. It usually appears a day or two after the first views." };
			}
			const { video } = await getVideo(actor, upload.videoId);
			const board = new Map(video.storyboard.scenes.map((scene) => [scene.id, scene]));
			const scenes = sceneRetention(render.timeline, data.curve).map((scene) => ({ ...scene, summary: sceneSummary(board.get(scene.id)) }));
			const worst = worstScenes(scenes) as typeof scenes;
			const opening = scenes[0];
			const lines = [
				`${data.views} views; viewers watched ${Math.round(data.averageViewPercent)}% on average (${Math.round(data.averageViewSec)}s).`,
				opening ? `The opening (${opening.summary}) kept ${Math.round(opening.end * 100)}% of viewers to ${opening.endSec}s.` : "",
				...worst.map((scene) => `Scene ${scene.n} (${scene.summary}, ${scene.startSec}-${scene.endSec}s) lost ${Math.round(scene.lossPer10s * 100)} points per 10s${scene.relative !== undefined ? `, ${scene.relative < 0.5 ? "worse" : "better"} than similar videos` : ""}.`),
			].filter(Boolean);
			let noteId: string | undefined;
			if (input.saveLearning) {
				const [note] = await db
					.insert(schema.notes)
					.values({ id: newId("nte"), projectId: upload.projectId, kind: "learning", title: `Retention: ${video.title}`.slice(0, 200), body: lines.join("\n"), pinned: true })
					.returning();
				noteId = note!.id;
			}
			return {
				views: data.views,
				averageViewPercent: Math.round(data.averageViewPercent * 10) / 10,
				averageViewSec: Math.round(data.averageViewSec),
				scenes,
				worst: worst.map((scene) => scene.id),
				summary: lines,
				...(noteId ? { noteId, note: "Saved as a pinned learning note: it is in the project brief from now on." } : {}),
			};
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
