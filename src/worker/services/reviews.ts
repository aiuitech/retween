/**
 * Reviews: a person watches a cut and leaves notes on it.
 *
 * The agent asks for a review (review.request) and hands the person a link.
 * The link opens the review page in the web app, which needs no account: it
 * carries a token derived from the review id, so it can be shown again later
 * without being stored. The person pauses on moments, clicks a point on the
 * frame or picks a scene, tags and writes notes, and submits them all at once
 * with a verdict. The agent picks the notes up with review.get (waiting on it,
 * or finding them flagged on video.get and in the project brief), mapped to
 * scenes, with what was on screen and said at each moment.
 */
import { env } from "cloudflare:workers";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { clock, round2, sceneAt } from "../../../shared/inspect.ts";
import type { Scene } from "../../../shared/storyboard.ts";
import { type Timeline, dimensionsFor } from "../../../shared/timeline.ts";
import type { Actor } from "../auth/index.ts";
import { db, schema } from "../db/client.ts";
import type { ReviewScene, ReviewTag, ReviewVerdict } from "../db/schema.ts";
import { AppError, badRequest, bytesToBase64, newId, notFound, sha256Hex } from "../lib/util.ts";
import { draftKey, draftStatus, inspectTimeline, startDraft } from "./inspect.ts";
import type { Project } from "./projects.ts";
import { signedUrl } from "./storage.ts";
import { posterFor } from "./thumbnails.ts";
import type { Video } from "./videos.ts";

export type Review = typeof schema.reviews.$inferSelect;
export type ReviewComment = typeof schema.reviewComments.$inferSelect;

/** Longest stretch a review cuts as a draft. Longer videos are reviewed from an export. */
export const MAX_REVIEW_DRAFT_SECONDS = 300;

// --- the link --------------------------------------------------------------------------

let tokenKey: Promise<CryptoKey> | undefined;
const key = () =>
	(tokenKey ??= crypto.subtle
		.digest("SHA-256", new TextEncoder().encode(`retween-review-link:${env.BETTER_AUTH_SECRET}`))
		.then((raw) => crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"])));

/** The token in a review's link: the same every time for the same review, and useless for any other. */
export async function reviewToken(reviewId: string): Promise<string> {
	const signature = await crypto.subtle.sign("HMAC", await key(), new TextEncoder().encode(`review:${reviewId}`));
	return bytesToBase64(new Uint8Array(signature).slice(0, 24)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export const reviewUrl = async (reviewId: string) => `${env.APP_URL}/review/${reviewId}?t=${await reviewToken(reviewId)}`;

/** Constant-time comparison of two short strings. */
function same(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

/**
 * The review a page is asking for, if the asker may see it: they hold the
 * link's token, or they are the signed-in owner.
 */
export async function reviewFor(reviewId: string, access: { token?: string; userId?: string }): Promise<Review | null> {
	const review = await db.query.reviews.findFirst({ where: eq(schema.reviews.id, reviewId) });
	if (!review) return null;
	if (access.userId && access.userId === review.userId) return review;
	if (access.token && same(access.token, await reviewToken(review.id))) return review;
	return null;
}

// --- asking for one -------------------------------------------------------------------

/** What a scene shows or says, in a line, for people who cannot see the storyboard. */
export function sceneSummary(scene: Scene | undefined): string {
	if (!scene) return "";
	const text = scene.text ?? {};
	const shown =
		text.heading ??
		text.quote ??
		(text.stat ? [text.stat.value, text.stat.label].filter(Boolean).join(" ") : undefined) ??
		text.bullets?.map((bullet) => bullet.text).join(", ") ??
		text.cta?.text ??
		scene.map?.places.map((place) => place.name).join(", ") ??
		scene.chart?.data.map((item) => item.label).join(", ");
	const said = scene.narration?.trim();
	const line = shown ?? said ?? scene.label ?? scene.type;
	return line.length > 110 ? `${line.slice(0, 108).trimEnd()}…` : line;
}

function snapshot(timeline: Timeline, scenes: Scene[]): ReviewScene[] {
	const byId = new Map(scenes.map((scene) => [scene.id, scene]));
	return timeline.scenes.map((scene, i) => ({
		id: scene.id,
		n: i + 1,
		type: scene.type,
		startSec: round2(scene.startFrame / timeline.fps),
		endSec: round2((scene.startFrame + scene.durationInFrames) / timeline.fps),
		summary: sceneSummary(byId.get(scene.id)),
	}));
}

export interface RequestOptions {
	ask?: string;
	aspect?: Video["aspect"];
	renderId?: string;
	sceneIds?: string[];
	fromSeconds?: number;
	toSeconds?: number;
	expiresInDays: number;
}

/**
 * Opens a new round of review on a video: the current export when it is up
 * to date (or the one named), otherwise a draft cut of the stretch asked for.
 * Earlier rounds still open are closed.
 */
export async function requestReview(actor: Actor, video: Video, project: Project, options: RequestOptions): Promise<Review> {
	const previous = await db.query.reviews.findMany({ where: eq(schema.reviews.videoId, video.id), orderBy: desc(schema.reviews.round), limit: 1 });
	const round = (previous[0]?.round ?? 0) + 1;
	const id = newId("rev");
	const expiresAt = new Date(Date.now() + options.expiresInDays * 24 * 3600 * 1000);
	const inspected = await inspectTimeline(video, project);
	let timeline = inspected.timeline;
	let aspect = options.aspect ?? video.aspect;
	let mediaKey: string | null = null;
	let draftId: string | null = null;
	let renderId: string | null = null;
	let fromSec = 0;
	let toSec: number | null = null;

	// An export of the current cut is better than a draft, and costs nothing more.
	const ranged = options.sceneIds?.length || options.fromSeconds !== undefined || options.toSeconds !== undefined;
	const render = options.renderId
		? await db.query.renders.findFirst({ where: and(eq(schema.renders.id, options.renderId), eq(schema.renders.videoId, video.id)) })
		: !ranged && !inspected.draft
			? (
					await db.query.renders.findMany({
						where: and(eq(schema.renders.videoId, video.id), eq(schema.renders.status, "done"), eq(schema.renders.aspect, aspect)),
						orderBy: desc(schema.renders.createdAt),
						limit: 5,
					})
				).find((candidate) => JSON.stringify(candidate.timeline) === JSON.stringify(timeline))
			: undefined;
	if (options.renderId && !render) throw notFound(`Render ${options.renderId} of this video`);
	if (render) {
		if (render.status !== "done" || !render.r2Key) throw new AppError(409, `Render ${render.id} is ${render.status}; review it once it is done.`, "not_ready");
		timeline = render.timeline;
		aspect = render.aspect;
		mediaKey = render.r2Key;
		renderId = render.id;
		toSec = round2(timeline.durationInFrames / timeline.fps);
	} else {
		const last = timeline.durationInFrames - 1;
		let first = 0;
		let end = last;
		if (options.sceneIds?.length) {
			const picked = timeline.scenes.filter((scene) => options.sceneIds!.includes(scene.id));
			if (picked.length !== new Set(options.sceneIds).size) throw notFound(`Scene "${options.sceneIds.find((sceneId) => !picked.some((scene) => scene.id === sceneId))}"`);
			first = picked[0]!.startFrame;
			end = picked.at(-1)!.startFrame + picked.at(-1)!.durationInFrames - 1;
		} else {
			if (options.fromSeconds !== undefined) first = Math.min(last, Math.round(options.fromSeconds * timeline.fps));
			if (options.toSeconds !== undefined) end = Math.min(last, Math.round(options.toSeconds * timeline.fps));
		}
		if (end <= first) throw badRequest("The stretch to review is empty");
		const seconds = (end - first + 1) / timeline.fps;
		if (seconds > MAX_REVIEW_DRAFT_SECONDS) {
			throw badRequest(
				`A review draft is at most ${MAX_REVIEW_DRAFT_SECONDS / 60} minutes and this stretch is ${clock(seconds)}. Export the video (video.render) and review that (renderId), or pick scenes.`,
			);
		}
		draftId = newId("drf");
		await startDraft(actor, project, draftId, timeline, dimensionsFor(aspect, "720p"), [first, end]);
		fromSec = round2(first / timeline.fps);
		toSec = round2((end + 1) / timeline.fps);
	}

	await db
		.update(schema.reviews)
		.set({ status: "closed" })
		.where(and(eq(schema.reviews.videoId, video.id), eq(schema.reviews.status, "open")));
	const [review] = await db
		.insert(schema.reviews)
		.values({
			id,
			videoId: video.id,
			projectId: project.id,
			userId: actor.id,
			tokenHash: await sha256Hex(await reviewToken(id)),
			round,
			status: "open",
			ask: options.ask,
			aspect,
			draftId,
			renderId,
			mediaKey,
			fromSec,
			toSec,
			scenes: snapshot(timeline, video.storyboard.scenes),
			timeline,
			storyboardHash: await sha256Hex(JSON.stringify(video.storyboard)),
			expiresAt,
		})
		.returning();
	return review!;
}

/**
 * The file the review page plays. A draft is collected from the preview
 * renderer the first time it is finished (and kept in R2 from then on).
 */
export async function reviewMedia(review: Review): Promise<{ status: "ready" | "rendering" | "failed"; url?: string; progress?: number; error?: string }> {
	if (review.mediaKey) return { status: "ready", url: await signedUrl(review.mediaKey, { expiresIn: 12 * 3600 }) };
	if (!review.draftId) return { status: "failed", error: "This review has no cut to show." };
	const status = await draftStatus({ id: review.userId }, { id: review.projectId }, review.videoId, review.draftId);
	if (status.status === "done") {
		const key = draftKey(review.projectId, review.videoId, review.draftId);
		await db.update(schema.reviews).set({ mediaKey: key }).where(eq(schema.reviews.id, review.id));
		return { status: "ready", url: await signedUrl(key, { expiresIn: 12 * 3600 }) };
	}
	return status.status === "failed" ? { status: "failed", error: status.error } : { status: "rendering", progress: status.progress };
}

// --- the person's side ----------------------------------------------------------------

export interface CommentInput {
	atSec?: number | null;
	sceneId?: string | null;
	x?: number | null;
	y?: number | null;
	tag?: ReviewTag | null;
	body: string;
}

/** What the review page shows. */
export async function reviewPage(review: Review) {
	const video = await db.query.videos.findFirst({ where: eq(schema.videos.id, review.videoId) });
	const project = await db.query.projects.findFirst({ where: eq(schema.projects.id, review.projectId), columns: { name: true, brand: true } });
	const [comments, earlier, media, poster] = await Promise.all([
		db.query.reviewComments.findMany({ where: eq(schema.reviewComments.reviewId, review.id), orderBy: schema.reviewComments.createdAt }),
		review.round > 1
			? db.query.reviews.findFirst({ where: and(eq(schema.reviews.videoId, review.videoId), eq(schema.reviews.round, review.round - 1)) })
			: Promise.resolve(undefined),
		reviewMedia(review),
		video ? posterFor(video, 12 * 3600, review.aspect) : Promise.resolve(undefined),
	]);
	const earlierComments = earlier ? await db.query.reviewComments.findMany({ where: eq(schema.reviewComments.reviewId, earlier.id), orderBy: schema.reviewComments.atSec }) : [];
	const expired = review.expiresAt.getTime() < Date.now();
	return {
		id: review.id,
		round: review.round,
		status: expired && review.status === "open" ? ("expired" as const) : review.status,
		title: video?.title ?? "Video",
		project: project?.name ?? "",
		brand: project?.brand.identity?.name,
		ask: review.ask ?? undefined,
		aspect: review.aspect,
		fromSec: review.fromSec,
		toSec: review.toSec ?? undefined,
		scenes: review.scenes,
		media,
		posterUrl: poster?.url,
		verdict: review.verdict ?? undefined,
		summary: review.summary ?? undefined,
		reviewerName: review.reviewerName ?? undefined,
		submittedAt: review.submittedAt ?? undefined,
		comments: comments.map(commentView),
		/** Notes from the round before, with what was done about each. */
		earlier: earlierComments.length ? earlierComments.map(commentView) : undefined,
		/** True when the storyboard changed after this cut was made. */
		outdated: video ? (await sha256Hex(JSON.stringify(video.storyboard))) !== review.storyboardHash : false,
	};
}
export type ReviewPage = Awaited<ReturnType<typeof reviewPage>>;

const commentView = (comment: ReviewComment) => ({
	id: comment.id,
	atSec: comment.atSec ?? undefined,
	sceneId: comment.sceneId ?? undefined,
	x: comment.x ?? undefined,
	y: comment.y ?? undefined,
	tag: comment.tag ?? undefined,
	body: comment.body,
	resolution: comment.resolution ?? undefined,
});

/** The person sends their notes and verdict. A review is submitted once; a new round is a new link. */
export async function submitReview(review: Review, input: { comments: CommentInput[]; verdict: ReviewVerdict; summary?: string; reviewerName?: string }) {
	if (review.status !== "open") throw new AppError(409, review.status === "submitted" ? "These notes were already sent." : "This review has been replaced by a newer one.", "closed");
	if (review.expiresAt.getTime() < Date.now()) throw new AppError(410, "This review link has expired. Ask for a new one.", "expired");
	if (!input.comments.length && input.verdict === "changes" && !input.summary?.trim()) throw badRequest("Say what should change: add a note, or a few words in the summary.");
	const known = new Set(review.scenes.map((scene) => scene.id));
	const timeline = review.timeline;
	const rows = input.comments.slice(0, 200).map((comment) => {
		const atSec = comment.atSec ?? null;
		// A note on a moment belongs to the scene on screen then; a note on a scene card names it.
		const sceneId =
			comment.sceneId && known.has(comment.sceneId)
				? comment.sceneId
				: atSec !== null && timeline
					? sceneAt(timeline, Math.min(timeline.durationInFrames - 1, Math.max(0, Math.round(atSec * timeline.fps)))).id
					: null;
		return {
			id: newId("rvc"),
			reviewId: review.id,
			atSec: atSec === null ? null : round2(Math.max(0, atSec)),
			sceneId,
			x: comment.x ?? null,
			y: comment.y ?? null,
			tag: comment.tag ?? null,
			body: comment.body.trim().slice(0, 2000),
		};
	});
	if (rows.length) await db.insert(schema.reviewComments).values(rows);
	await db
		.update(schema.reviews)
		.set({
			status: "submitted",
			verdict: input.verdict,
			summary: input.summary?.trim().slice(0, 4000) || null,
			reviewerName: input.reviewerName?.trim().slice(0, 100) || null,
			submittedAt: new Date(),
		})
		.where(and(eq(schema.reviews.id, review.id), eq(schema.reviews.status, "open")));
}

// --- the agent's side -----------------------------------------------------------------

/** The words being spoken around a moment, from the cut's own captions. */
function saidAt(timeline: Timeline, atSec: number): string | undefined {
	const frame = Math.round(atSec * timeline.fps);
	const near = timeline.captions.filter((cue) => cue.endFrame >= frame - timeline.fps && cue.startFrame <= frame + timeline.fps);
	const text = near.map((cue) => cue.text).join(" ").trim();
	return text || undefined;
}

/** A review as the agent reads it: every note tied to a scene, a moment and what was seen and heard there. */
export async function reviewNotes(review: Review) {
	const comments = await db.query.reviewComments.findMany({ where: eq(schema.reviewComments.reviewId, review.id), orderBy: schema.reviewComments.atSec });
	const video = await db.query.videos.findFirst({ where: eq(schema.videos.id, review.videoId), columns: { storyboard: true } });
	const current = new Set(video?.storyboard.scenes.map((scene) => scene.id));
	const byScene = new Map(review.scenes.map((scene) => [scene.id, scene]));
	return comments.map((comment) => {
		const scene = comment.sceneId ? byScene.get(comment.sceneId) : undefined;
		return {
			id: comment.id,
			...(comment.atSec !== null ? { atSec: comment.atSec, at: clock(comment.atSec) } : {}),
			sceneId: comment.sceneId ?? undefined,
			...(scene ? { scene: `#${scene.n} ${scene.type}: ${scene.summary}` } : {}),
			...(comment.sceneId && !current.has(comment.sceneId) ? { sceneGone: true } : {}),
			...(comment.x !== null && comment.y !== null ? { point: { x: comment.x, y: comment.y } } : {}),
			tag: comment.tag ?? undefined,
			body: comment.body,
			...(comment.atSec !== null && review.timeline ? { said: saidAt(review.timeline, comment.atSec) } : {}),
			...(comment.resolution ? { resolution: comment.resolution } : {}),
		};
	});
}

export function reviewSummary(review: Review) {
	const expired = review.status === "open" && review.expiresAt.getTime() < Date.now();
	return {
		reviewId: review.id,
		round: review.round,
		status: expired ? "expired" : review.status,
		...(review.verdict ? { verdict: review.verdict } : {}),
		...(review.summary ? { summary: review.summary } : {}),
		...(review.reviewerName ? { reviewer: review.reviewerName } : {}),
		...(review.submittedAt ? { submittedAt: review.submittedAt } : {}),
		...(review.status === "submitted" && !review.readAt ? { unread: true } : {}),
		cut: review.renderId ? { renderId: review.renderId } : { draft: true, fromSec: review.fromSec, toSec: review.toSec ?? undefined },
		expiresAt: review.expiresAt,
	};
}

/** Notes the person sent that the agent has not read yet, for one video or a whole project. */
export async function unreadReviews(where: { videoId?: string; projectId?: string }) {
	return db.query.reviews.findMany({
		where: and(
			eq(schema.reviews.status, "submitted"),
			isNull(schema.reviews.readAt),
			where.videoId ? eq(schema.reviews.videoId, where.videoId) : eq(schema.reviews.projectId, where.projectId!),
		),
		orderBy: desc(schema.reviews.submittedAt),
		limit: 20,
	});
}

/** The latest round on a video, if any. */
export const latestReview = (videoId: string) => db.query.reviews.findFirst({ where: eq(schema.reviews.videoId, videoId), orderBy: desc(schema.reviews.round) });

/** Whether the person has approved the video as it stands now. */
export async function approvedNow(video: Pick<Video, "id" | "storyboard">): Promise<{ approved: boolean; review?: Review; outdated?: boolean }> {
	const review = await db.query.reviews.findFirst({
		where: and(eq(schema.reviews.videoId, video.id), eq(schema.reviews.verdict, "approved")),
		orderBy: desc(schema.reviews.round),
	});
	if (!review) return { approved: false };
	const latest = await latestReview(video.id);
	const outdated = (await sha256Hex(JSON.stringify(video.storyboard))) !== review.storyboardHash;
	return { approved: latest?.id === review.id && !outdated, review, outdated };
}

export async function markRead(review: Review) {
	if (review.status === "submitted" && !review.readAt) await db.update(schema.reviews).set({ readAt: new Date() }).where(eq(schema.reviews.id, review.id));
}

export async function resolveComments(review: Review, items: { commentId: string; status: "done" | "wontfix"; note?: string }[]) {
	const ids = items.map((item) => item.commentId);
	const found = await db.query.reviewComments.findMany({ where: and(eq(schema.reviewComments.reviewId, review.id), inArray(schema.reviewComments.id, ids)) });
	const known = new Set(found.map((comment) => comment.id));
	const missing = ids.filter((id) => !known.has(id));
	if (missing.length) throw notFound(`Comment ${missing[0]} on this review`);
	for (const item of items) {
		await db
			.update(schema.reviewComments)
			.set({ resolution: { status: item.status, note: item.note?.slice(0, 1000), at: Date.now() } })
			.where(eq(schema.reviewComments.id, item.commentId));
	}
}
