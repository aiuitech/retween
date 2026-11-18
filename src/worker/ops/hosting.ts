import { env } from "cloudflare:workers";
import { and, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { chaptersFor } from "../../../shared/publish.ts";
import { normalizeOrigins } from "../../../shared/hosting.ts";
import { db, schema } from "../db/client.ts";
import { AppError, badRequest, newId } from "../lib/util.ts";
import { assetsById } from "../services/assets.ts";
import { type Hosted, assertMeterable, getHosted, hostedForVideo, hostedView, removeHosted } from "../services/hosting.ts";
import { STREAM } from "../services/pricing.ts";
import { getRender } from "../services/renders.ts";
import { approvedNow } from "../services/reviews.ts";
import { assertBudget } from "../services/usage.ts";
import { getVideo } from "../services/videos.ts";
import { creditsFor } from "../services/youtube.ts";
import { defineOp, waitSeconds } from "./registry.ts";

const hostedId = z.string().describe("A hosted video (hst_…) from hosting.publish or hosting.list");
const origins = z
	.array(z.string().min(1).max(253))
	.max(20)
	.describe('Sites allowed to embed the video, e.g. ["example.com", "*.example.com"]. Empty: any site. The watch page itself is not affected');

const parseOrigins = (entries: string[]) => {
	try {
		return normalizeOrigins(entries);
	} catch (error) {
		throw badRequest(`allowedOrigins: ${error instanceof Error ? error.message : String(error)}`);
	}
};

async function waitForHosted(row: Hosted, seconds: number): Promise<Hosted> {
	const deadline = Date.now() + seconds * 1000;
	let current = row;
	while (!["ready", "failed"].includes(current.status) && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 2500));
		current = (await db.query.hostedVideos.findFirst({ where: eq(schema.hostedVideos.id, row.id) })) ?? current;
	}
	return current;
}

const PRICE_NOTE =
	`Billed to this account at cost plus the published markup: storage at $${STREAM.usdPerMinuteStoredMonth * 1000} per 1,000 minutes of video a month ` +
	`and plays at $${STREAM.usdPerMinuteDelivered * 1000} per 1,000 minutes watched, both before markup.`;

export const hostingOps = [
	defineOp({
		name: "hosting.publish",
		title: "Host a video",
		description:
			"Hosts a finished render on Retween's video hosting (Cloudflare Stream) and returns a watch page link (/v/<id>) to share and an embed code for any website, " +
			"with adaptive streaming, captions timed to the narration, the video's thumbnail as its poster, chapters and required credits. " +
			"Anyone with the link can watch, so it needs the person's approval of the cut (review.request) or personApproved. " +
			`${PRICE_NOTE} Playback stops while the account is over its monthly cap. Follow processing with hosting.get.`,
		input: z.object({
			renderId: z.string().describe("A finished render (rnd_…). Host the shape the page will show: 16:9 for most sites, 9:16 for phones"),
			title: z.string().min(1).max(200).optional().describe("Defaults to the video's title"),
			description: z.string().max(5000).default("").describe("Shown under the video on the watch page"),
			captions: z.boolean().default(true).describe("Add captions timed to the narration"),
			language: z.string().min(2).max(35).optional().describe("BCP 47 language of the captions, e.g. en. Defaults to the brand's narration language, else en"),
			allowedOrigins: origins.default([]),
			allowDuplicate: z.boolean().default(false).describe("Host it again even though this render is already hosted"),
			personApproved: z.boolean().default(false).describe("Set when the person approved this cut some other way than a review"),
			waitSeconds: waitSeconds.default(10),
		}),
		paid: true,
		handler: async (input, { actor }) => {
			assertMeterable();
			await assertBudget(actor);
			const { render, project } = await getRender(actor, input.renderId);
			if (render.status !== "done" || !render.r2Key) throw new AppError(409, `Render ${render.id} is ${render.status}; host it once it is done.`, "not_ready");
			const { video } = await getVideo(actor, render.videoId);
			if (!input.personApproved && !(await approvedNow(video)).approved) {
				throw new AppError(
					409,
					"Nobody has approved this cut, and a hosted video can be watched by anyone with its link. Ask the person with review.request, or pass personApproved: true if they approved it another way.",
					"not_approved",
				);
			}
			if (!input.allowDuplicate) {
				const previous = await db.query.hostedVideos.findFirst({
					where: and(eq(schema.hostedVideos.renderId, render.id), eq(schema.hostedVideos.userId, actor.id), ne(schema.hostedVideos.status, "failed")),
				});
				if (previous) {
					throw new AppError(409, `This render is already hosted (${previous.id}). Pass allowDuplicate: true to host it again.`, "duplicate", { hosted: hostedView(previous) });
				}
			}

			// The video's own thumbnail is the poster when it suits this shape; otherwise the export's opening still.
			const thumbnail = video.thumbnailAssetId ? (await assetsById(project.id, [video.thumbnailAssetId])).get(video.thumbnailAssetId) : undefined;
			const landscape = render.width > render.height;
			const posterKey = thumbnail?.status === "ready" && thumbnail.r2Key && landscape ? thumbnail.r2Key : render.posterKey;

			const [row] = await db
				.insert(schema.hostedVideos)
				.values({
					id: newId("hst"),
					userId: actor.id,
					projectId: project.id,
					videoId: video.id,
					renderId: render.id,
					title: input.title ?? video.title.slice(0, 200),
					description: input.description.trim(),
					captionsLanguage: input.captions && render.timeline.captions.length ? (input.language ?? project.brand.narration?.language ?? "en") : null,
					chapters: chaptersFor(render.timeline, video.storyboard).chapters,
					credits: await creditsFor(project.id, render.timeline),
					posterKey,
					allowedOrigins: parseOrigins(input.allowedOrigins),
					width: render.width,
					height: render.height,
					// The export's length until Stream reports its own.
					durationSec: render.durationMs != null ? render.durationMs / 1000 : render.timeline.durationInFrames / render.timeline.fps,
				})
				.returning();
			await env.HOSTING_WORKFLOW.create({ id: row!.id, params: { hostedId: row!.id } });
			const current = await waitForHosted(row!, input.waitSeconds);
			return {
				hosted: hostedView(current),
				...(["ready", "failed"].includes(current.status) ? {} : { note: `Processing; the links work once it is ready. Follow it with hosting.get (hostedId ${row!.id}).` }),
			};
		},
	}),

	defineOp({
		name: "hosting.get",
		title: "Get a hosted video",
		description: "A hosted video: its status, watch page link and embed code (once ready), captions, chapters and allowed sites. Use waitSeconds to wait for processing.",
		input: z.object({ hostedId, waitSeconds: waitSeconds.default(0) }),
		readOnly: true,
		handler: async (input, { actor }) => ({ hosted: hostedView(await waitForHosted(await getHosted(actor, input.hostedId), input.waitSeconds)) }),
	}),

	defineOp({
		name: "hosting.list",
		title: "List hosted videos",
		description: "Hosted copies of a video, newest first.",
		input: z.object({ videoId: z.string().describe("vid_…") }),
		readOnly: true,
		handler: async (input, { actor }) => {
			const { video } = await getVideo(actor, input.videoId);
			return { hosted: (await hostedForVideo(actor, video.id)).map(hostedView) };
		},
	}),

	defineOp({
		name: "hosting.update",
		title: "Change a hosted video",
		description:
			"Change a hosted video's title, description or the sites allowed to embed it, or pause it (enabled: false) so the watch page and embeds say it is unavailable and nothing plays. " +
			"A paused video is still stored and billed for storage; hosting.delete removes it.",
		input: z.object({
			hostedId,
			title: z.string().min(1).max(200).optional(),
			description: z.string().max(5000).optional(),
			allowedOrigins: origins.optional(),
			enabled: z.boolean().optional(),
		}),
		handler: async (input, { actor }) => {
			const row = await getHosted(actor, input.hostedId);
			const [updated] = await db
				.update(schema.hostedVideos)
				.set({
					...(input.title !== undefined ? { title: input.title } : {}),
					...(input.description !== undefined ? { description: input.description.trim() } : {}),
					...(input.allowedOrigins !== undefined ? { allowedOrigins: parseOrigins(input.allowedOrigins) } : {}),
					...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
				})
				.where(eq(schema.hostedVideos.id, row.id))
				.returning();
			return { hosted: hostedView(updated!) };
		},
	}),

	defineOp({
		name: "hosting.delete",
		title: "Delete a hosted video",
		description: "Stops hosting a video: the watch page and every embed stop working and its storage stops being billed. The export it came from is kept.",
		input: z.object({ hostedId }),
		destructive: true,
		handler: async (input, { actor }) => {
			const row = await getHosted(actor, input.hostedId);
			await removeHosted(row);
			return { deleted: row.id };
		},
	}),
];
