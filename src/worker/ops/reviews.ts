/**
 * Reviews: hand a person a link to watch a cut and leave notes on it, then
 * read their notes back, tied to scenes and moments.
 */
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { round2 } from "../../../shared/inspect.ts";
import { ASPECT_RATIOS, dimensionsFor } from "../../../shared/timeline.ts";
import { db, schema } from "../db/client.ts";
import { AppError, bytesToBase64, notFound } from "../lib/util.ts";
import { type SheetTile, renderSheet } from "../services/inspect.ts";
import {
	type Review,
	latestReview,
	markRead,
	requestReview,
	resolveComments,
	reviewMedia,
	reviewNotes,
	reviewSummary,
	reviewUrl,
} from "../services/reviews.ts";
import { getProject } from "../services/projects.ts";
import { getVideo } from "../services/videos.ts";
import type { Actor } from "../auth/index.ts";
import { INLINE_IMAGE, defineOp } from "./registry.ts";

const videoId = z.string().describe("Video id (vid_…)");

async function getReview(actor: Actor, reviewId: string): Promise<Review> {
	const review = await db.query.reviews.findFirst({ where: eq(schema.reviews.id, reviewId) });
	if (!review) throw notFound("Review");
	await getProject(actor, review.projectId).catch(() => {
		throw notFound("Review");
	});
	return review;
}

/** Polls until the person submits, or the time runs out. */
async function waitForSubmission(review: Review, seconds: number): Promise<Review> {
	const deadline = Date.now() + seconds * 1000;
	let current = review;
	while (current.status === "open" && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 3000));
		current = (await db.query.reviews.findFirst({ where: eq(schema.reviews.id, review.id) })) ?? current;
	}
	return current;
}

/** The frames the person commented on, as they saw them, numbered like the notes. */
async function commentedFrames(actor: Actor, review: Review, notes: Awaited<ReturnType<typeof reviewNotes>>) {
	const timeline = review.timeline;
	const timed = notes.filter((note) => note.atSec !== undefined).slice(0, 12);
	if (!timeline || !timed.length) return undefined;
	const size = dimensionsFor(review.aspect, "720p");
	const tiles: SheetTile[] = timed.map((note, i) => ({
		kind: "frame",
		frame: Math.min(timeline.durationInFrames - 1, Math.round(note.atSec! * timeline.fps)),
		...size,
		label: `${i + 1}. ${note.at}${note.tag ? ` · ${note.tag}` : ""}`,
	}));
	try {
		const sheet = await renderSheet(actor, {
			storeAs: `projects/${review.projectId}/previews/${review.videoId}-review`,
			timeline: { projectId: review.projectId, timeline },
			tiles,
			tileHeight: review.aspect === "16:9" ? 200 : 300,
			maxWidth: 1400,
			quality: 75,
		});
		return { sheet, order: timed.map((note) => note.id) };
	} catch (error) {
		console.warn("could not draw commented frames", review.id, error instanceof Error ? error.message : error);
		return undefined;
	}
}

export const reviewOps = [
	defineOp({
		name: "review.request",
		title: "Ask a person to review",
		description:
			"Get a link for the person to watch the video and leave notes on it: they pause on a moment (and can click the spot on the frame) or pick a scene, " +
			"tag the note (cut, too slow, wrong picture, mispronounced…), write what to change, and submit everything at once with a verdict (approve, or changes). " +
			"The link works without a Retween account, so it can go to a client too. Give the link to the person and say what you would like them to look at (`ask`). " +
			"The current export is used when it is up to date; otherwise a 720p draft of the stretch is cut (up to 5 minutes; export longer videos first). " +
			"Then wait for their notes with review.get (waitSeconds), or carry on: video.get and project.brief flag notes that arrive. " +
			"Asking again starts a new round and closes the old link.",
		input: z.object({
			videoId,
			ask: z.string().max(1000).optional().describe("What you want them to look at or decide, shown at the top of the page"),
			renderId: z.string().optional().describe("Review this export instead of the current cut"),
			sceneIds: z.array(z.string()).min(1).optional().describe("Only this stretch (from the first scene to the last)"),
			fromSeconds: z.number().min(0).optional(),
			toSeconds: z.number().min(0).optional(),
			aspect: z.enum(ASPECT_RATIOS).optional().describe("Defaults to the video's primary aspect ratio"),
			expiresInDays: z.number().int().min(1).max(60).default(14),
		}),
		handler: async (input, { actor }) => {
			const { video, project } = await getVideo(actor, input.videoId);
			const review = await requestReview(actor, video, project, input);
			const media = await reviewMedia(review);
			return {
				review: reviewSummary(review),
				reviewUrl: await reviewUrl(review.id),
				cut: media.status === "ready" ? "ready" : media.status === "rendering" ? "The draft is still rendering; the page shows it as soon as it is done." : media.error,
				next: "Give the person reviewUrl. Then call review.get with this reviewId and waitSeconds to collect their notes, or keep working: video.get shows when notes arrive.",
			};
		},
	}),

	defineOp({
		name: "review.get",
		title: "Read review notes",
		description:
			"The person's notes on a review, once they submit: their verdict and summary, and each note with its moment, the scene it falls in (as it was then, " +
			"and whether that scene still exists), the point they clicked on the frame, its tag, and what was being said there. " +
			"Includes one image of the commented frames, numbered like the notes. Give reviewId, or videoId for the latest round. " +
			"waitSeconds waits for them to submit (ask again to keep waiting). Reading marks the notes as read.",
		input: z.object({
			reviewId: z.string().optional(),
			videoId: z.string().optional(),
			waitSeconds: z.number().min(0).max(50).default(0).describe("Wait this long for the person to submit"),
			frames: z.boolean().default(true).describe("Include the image of the commented frames"),
		}),
		handler: async (input, { actor }) => {
			let review: Review | undefined;
			if (input.reviewId) review = await getReview(actor, input.reviewId);
			else if (input.videoId) {
				const { video } = await getVideo(actor, input.videoId);
				review = await latestReview(video.id);
				if (!review) throw notFound("A review of this video (ask for one with review.request)");
			} else throw new AppError(400, "Give reviewId or videoId", "bad_request");
			const current = await waitForSubmission(review, input.waitSeconds);
			const summary = reviewSummary(current);
			if (current.status !== "submitted") {
				return {
					review: summary,
					reviewUrl: summary.status === "open" ? await reviewUrl(current.id) : undefined,
					note:
						summary.status === "open"
							? "No notes yet: the person has not submitted. Ask again with waitSeconds, or carry on and check video.get later."
							: summary.status === "expired"
								? "The link expired before anyone submitted. Ask for a new round with review.request."
								: "This round was replaced by a newer one.",
				};
			}
			const notes = await reviewNotes(current);
			const frames = input.frames ? await commentedFrames(actor, current, notes) : undefined;
			await markRead(current);
			const numbered = frames ? new Map(frames.order.map((id, i) => [id, i + 1])) : undefined;
			return {
				review: { ...summary, unread: undefined },
				notes: notes.map((note) => (numbered?.has(note.id) ? { frame: numbered.get(note.id), ...note } : note)),
				...(frames ? { framesUrl: frames.sheet.url } : {}),
				next:
					current.verdict === "approved" && !notes.length
						? "Approved with no changes."
						: "Make the changes, mark each note with review.resolve (done or wontfix, with a word on what you did), then ask for another round with review.request so they can check.",
				...(frames ? { [INLINE_IMAGE]: { base64: bytesToBase64(frames.sheet.bytes), mimeType: frames.sheet.contentType } } : {}),
			};
		},
	}),

	defineOp({
		name: "review.resolve",
		title: "Answer review notes",
		description:
			"Say what was done about each note: done (with a few words on the change) or wontfix (with the reason). The next round's page shows these to the person beside their old notes.",
		input: z.object({
			reviewId: z.string(),
			notes: z
				.array(z.object({ commentId: z.string(), status: z.enum(["done", "wontfix"]), note: z.string().max(1000).optional() }))
				.min(1)
				.max(200),
		}),
		handler: async (input, { actor }) => {
			const review = await getReview(actor, input.reviewId);
			await resolveComments(
				review,
				input.notes.map((note) => ({ commentId: note.commentId, status: note.status, note: note.note })),
			);
			return { resolved: input.notes.length };
		},
	}),

	defineOp({
		name: "review.list",
		title: "List reviews",
		description: "Every round of review on a video, newest first, with its status and verdict.",
		input: z.object({ videoId }),
		readOnly: true,
		handler: async (input, { actor }) => {
			const { video } = await getVideo(actor, input.videoId);
			const rows = await db.query.reviews.findMany({ where: eq(schema.reviews.videoId, video.id), orderBy: desc(schema.reviews.round), limit: 50 });
			return {
				reviews: await Promise.all(
					rows.map(async (review) => ({
						...reviewSummary(review),
						comments: (await db.query.reviewComments.findMany({ where: eq(schema.reviewComments.reviewId, review.id), columns: { id: true } })).length,
						...(review.status === "open" ? { reviewUrl: await reviewUrl(review.id) } : {}),
						cutSeconds: review.toSec !== null ? round2(review.toSec - review.fromSec) : undefined,
					})),
				),
			};
		},
	}),
];
