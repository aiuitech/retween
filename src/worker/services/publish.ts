/**
 * Before a video goes to YouTube: everything that decides whether it lands
 * well, checked in one place. Whether it will be a Short, its thumbnail,
 * chapters, credits, the person's approval, whether the export is of the
 * current cut, and what its media suggests for the altered-or-synthetic
 * disclosure YouTube asks for.
 */
import { and, eq, gte, ne } from "drizzle-orm";
import { type Chapter, chaptersFor } from "../../../shared/publish.ts";
import { collectAssetRefs } from "../../../shared/timeline.ts";
import { db, schema } from "../db/client.ts";
import { assetsById } from "./assets.ts";
import type { Render } from "./renders.ts";
import { approvedNow } from "./reviews.ts";
import { THUMBNAIL_MAX_BYTES } from "../../../shared/thumbnail.ts";
import type { Video } from "./videos.ts";
import { creditsFor } from "./youtube.ts";

/** YouTube treats vertical (or square) videos up to three minutes as Shorts. */
export const SHORTS_MAX_SECONDS = 180;
/** Uploads through the YouTube Data API are capped per Google Cloud project per day. */
export const DAILY_UPLOADS = 100;

export interface Check {
	severity: "error" | "warning" | "info" | "ok";
	kind: string;
	message: string;
	fix?: string;
}

/**
 * What the media in an export suggests for YouTube's "altered or synthetic
 * content" question. Only the person can be sure (a stylised still is fine, a
 * photoreal clip of a real place is not), so this is a suggestion with reasons.
 */
export async function syntheticHints(projectId: string, render: Pick<Render, "timeline">) {
	const assets = [...(await assetsById(projectId, collectAssetRefs(render.timeline))).values()];
	const clips = assets.filter((asset) => asset.kind === "video" && asset.source === "generated");
	const stills = assets.filter((asset) => asset.kind === "image" && asset.generation?.type === "image" && !asset.tags.includes("thumbnail"));
	const reasons: string[] = [];
	if (clips.length) reasons.push(`${clips.length} generated video clip${clips.length === 1 ? "" : "s"} (${clips.slice(0, 3).map((clip) => `"${(clip.meta.prompt ?? clip.name).slice(0, 60)}"`).join(", ")}) that may look like real footage`);
	if (stills.length) reasons.push(`${stills.length} generated still${stills.length === 1 ? "" : "s"}: say true if any looks like a real person, place or event`);
	return {
		suggested: clips.length > 0,
		reasons: reasons.length ? reasons : ["No generated clips or photographic stills: stock, graphics, charts, maps and a narrator voice do not need disclosing"],
		note: "Also say true if the narration imitates a real person's voice, or a real person is shown doing or saying something they did not.",
	};
}

/** Everything worth knowing before publishing this export, worst first. */
export async function preflight(render: Render, video: Video, options: { channelId?: string } = {}) {
	const checks: Check[] = [];
	const timeline = render.timeline;
	const seconds = timeline.durationInFrames / timeline.fps;

	if (render.status !== "done" || !render.r2Key) checks.push({ severity: "error", kind: "not-rendered", message: `The export is ${render.status}.`, fix: "Wait for it with render.get." });

	const vertical = render.aspect === "9:16" || render.aspect === "1:1";
	if (vertical && seconds <= SHORTS_MAX_SECONDS) checks.push({ severity: "ok", kind: "short", message: `It will be a Short (${render.aspect}, ${Math.round(seconds)}s).` });
	else if (render.aspect === "9:16") checks.push({ severity: "warning", kind: "not-a-short", message: `At ${Math.round(seconds)}s this vertical video is over the 3-minute limit for Shorts, so it will be a regular video shown with black bars.`, fix: "Cut it to three minutes, or export 16:9 for the regular feed." });

	// The export should be the cut the person last saw.
	if (video.timeline && JSON.stringify(video.timeline) !== JSON.stringify(timeline)) {
		checks.push({ severity: "warning", kind: "outdated-export", message: "The video has changed since this export was made.", fix: "Export it again with video.render if the changes should go up." });
	}

	const approval = await approvedNow(video);
	if (approval.approved) checks.push({ severity: "ok", kind: "approved", message: `Approved by ${approval.review?.reviewerName ?? "the person"} in review round ${approval.review?.round}.` });
	else
		checks.push({
			severity: "warning",
			kind: "not-approved",
			message: approval.outdated ? "The person approved an earlier cut; the video has changed since." : "Nobody has approved this cut.",
			fix: "Ask with review.request before publishing anything but a private upload. youtube.publish refuses unlisted, public or scheduled uploads without an approval unless personApproved is set.",
		});

	if (!vertical) {
		const thumbnail = video.thumbnailAssetId ? (await assetsById(video.projectId, [video.thumbnailAssetId])).get(video.thumbnailAssetId) : undefined;
		if (!thumbnail) checks.push({ severity: "warning", kind: "no-thumbnail", message: "No thumbnail: YouTube will pick a frame, which rarely gets clicked.", fix: "Design one with thumbnail.design (choose one to keep it)." });
		else if ((thumbnail.bytes ?? 0) > THUMBNAIL_MAX_BYTES) checks.push({ severity: "warning", kind: "thumbnail-too-large", message: "The thumbnail is over YouTube's 2 MB limit and will be left out." });
		else checks.push({ severity: "ok", kind: "thumbnail", message: "The video's thumbnail goes up with it (custom thumbnails need a verified channel)." });
	}

	const { chapters, problems } = chaptersFor(timeline, video.storyboard);
	if (chapters.length >= 3 && !problems.length) checks.push({ severity: "ok", kind: "chapters", message: `${chapters.length} chapters go in the description.` });
	else if (problems.length) checks.push({ severity: "info", kind: "chapters", message: problems.join(" "), fix: "Adjust which scenes start a chapter (scene.chapter)." });
	else if (seconds > 240 && !vertical) checks.push({ severity: "info", kind: "no-chapters", message: "A video this long reads better with chapters.", fix: "Give the scenes that start each section a chapter title (scene.chapter)." });

	if (!timeline.captions.length) checks.push({ severity: "info", kind: "no-captions", message: "There is no narration to make captions from." });

	const credits = await creditsFor(video.projectId, timeline);
	if (credits.length) checks.push({ severity: "info", kind: "credits", message: `${credits.length} credit line${credits.length === 1 ? "" : "s"} will be added to the description.` });

	if (options.channelId) {
		const previous = await db.query.youtubeUploads.findFirst({
			where: and(eq(schema.youtubeUploads.renderId, render.id), eq(schema.youtubeUploads.channelId, options.channelId), ne(schema.youtubeUploads.status, "failed")),
		});
		if (previous) checks.push({ severity: "warning", kind: "duplicate", message: `This export was already sent to the channel (${previous.id}).` });
	}

	const today = await db.query.youtubeUploads.findMany({ where: gte(schema.youtubeUploads.createdAt, new Date(Date.now() - 24 * 3600 * 1000)), columns: { id: true } });
	if (today.length >= DAILY_UPLOADS * 0.9) {
		checks.push({ severity: "warning", kind: "quota", message: `${today.length} uploads went out through Retween in the last day; YouTube allows about ${DAILY_UPLOADS} a day, so this one may be refused.`, fix: "Schedule it for tomorrow, or try later." });
	}

	const order = { error: 0, warning: 1, info: 2, ok: 3 };
	checks.sort((a, b) => order[a.severity] - order[b.severity]);
	return {
		ready: !checks.some((check) => check.severity === "error"),
		checks,
		chapters: chapters as Chapter[],
		containsSyntheticMedia: await syntheticHints(video.projectId, render),
		approved: approval.approved,
	};
}
