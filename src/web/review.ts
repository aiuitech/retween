/**
 * Server functions for the review page. It is opened from a link with a
 * token, by someone who may have no Retween account, so these do not go
 * through the operations (which need a signed-in person): the token, or the
 * owner's own session, is what lets a request see and answer one review.
 */
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { actorFromRequest } from "../worker/auth/index.ts";
import { REVIEW_TAGS, REVIEW_VERDICTS, type ReviewTag, type ReviewVerdict } from "../worker/db/schema.ts";
import { AppError } from "../worker/lib/util.ts";
import { type CommentInput, type ReviewPage, reviewFor, reviewMedia, reviewPage, submitReview } from "../worker/services/reviews.ts";

export type { ReviewPage };
export type ReviewReply<T> = { ok: true; value: T } | { ok: false; message: string; status: number };

async function access(reviewId: string, token: string | undefined) {
	const actor = await actorFromRequest(getRequest()).catch(() => null);
	const review = await reviewFor(reviewId, { token, userId: actor?.id });
	if (!review) throw new AppError(404, "This review link is not valid. Ask for a new one.", "not_found");
	return review;
}

async function reply<T>(work: () => Promise<T>): Promise<ReviewReply<T>> {
	try {
		return { ok: true, value: await work() };
	} catch (error) {
		if (error instanceof AppError) return { ok: false, message: error.message, status: error.status };
		console.error("review page", error);
		return { ok: false, message: "Something went wrong. Try again in a moment.", status: 500 };
	}
}

const text = (value: unknown, max: number) => (typeof value === "string" ? value.slice(0, max) : undefined);
const num = (value: unknown, min: number, max: number) => (typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : null);

export const loadReview = createServerFn({ method: "GET" })
	.validator((data: { reviewId: string; token?: string }) => ({ reviewId: String(data.reviewId).slice(0, 40), token: text(data.token, 100) }))
	.handler(({ data }) => reply(async () => reviewPage(await access(data.reviewId, data.token))));

/** Asked again while a draft is still rendering. */
export const reviewCut = createServerFn({ method: "GET" })
	.validator((data: { reviewId: string; token?: string }) => ({ reviewId: String(data.reviewId).slice(0, 40), token: text(data.token, 100) }))
	.handler(({ data }) => reply(async () => reviewMedia(await access(data.reviewId, data.token))));

export interface SubmitInput {
	reviewId: string;
	token?: string;
	verdict: ReviewVerdict;
	summary?: string;
	reviewerName?: string;
	comments: CommentInput[];
}

export const sendReview = createServerFn({ method: "POST" })
	.validator((data: SubmitInput): SubmitInput => {
		const verdict = REVIEW_VERDICTS.includes(data.verdict) ? data.verdict : "changes";
		const comments = (Array.isArray(data.comments) ? data.comments : []).slice(0, 200).flatMap((comment): CommentInput[] => {
			const body = text(comment?.body, 2000)?.trim();
			if (!body) return [];
			const tag = REVIEW_TAGS.includes(comment.tag as ReviewTag) ? (comment.tag as ReviewTag) : null;
			return [{ body, tag, atSec: num(comment.atSec, 0, 86_400), sceneId: text(comment.sceneId, 40) ?? null, x: num(comment.x, 0, 1), y: num(comment.y, 0, 1) }];
		});
		return { reviewId: String(data.reviewId).slice(0, 40), token: text(data.token, 100), verdict, summary: text(data.summary, 4000), reviewerName: text(data.reviewerName, 100), comments };
	})
	.handler(({ data }) =>
		reply(async () => {
			const review = await access(data.reviewId, data.token);
			await submitReview(review, data);
			return reviewPage((await access(data.reviewId, data.token))!);
		}),
	);
