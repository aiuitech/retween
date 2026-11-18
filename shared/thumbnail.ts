/**
 * Thumbnails: what an author asks for, and what the renderer is given.
 *
 * A thumbnail is drawn by the same renderer as the video, so it uses the
 * brand's fonts, colours and logo, and the same pictures the scenes use. Each
 * variant becomes one scene of a small "thumbnail timeline" (its picture,
 * with no text and no motion) and an overlay is drawn over it: the headline,
 * a cut-out subject, a scrim, the logo. Pure, no I/O.
 */
import { z } from "zod";
import { FEED_SIZES, HEADLINE_DESIGN_PX, THUMBNAIL_SIZE } from "./thumbnail-layout.ts";
import { type Timeline, TimelineLook, type TimelineBackground, type TimelineTheme } from "./timeline.ts";

export { FEED_SIZES, HEADLINE_DESIGN_PX, THUMBNAIL_MAX_BYTES, THUMBNAIL_SIZE } from "./thumbnail-layout.ts";

// --- render contract ------------------------------------------------------------------

/** Drawn over a thumbnail's picture. Sources are signed URLs by the time it reaches the renderer. */
export const ThumbnailOverlay = z.object({
	headline: z.string().max(120).optional(),
	kicker: z.string().max(60).optional(),
	/** Words of the headline drawn in the accent colour. */
	highlight: z.array(z.string()).max(8).optional(),
	textSide: z.enum(["left", "center", "right"]),
	textPosition: z.enum(["top", "center", "bottom"]),
	/** A transparent cut-out of the subject, standing on one side, outlined so it separates from the picture. */
	subject: z.object({ src: z.string(), side: z.enum(["left", "center", "right"]), scale: z.number().min(0.4).max(1.5) }).optional(),
	/** Show the brand logo in a top corner. */
	logo: z.boolean(),
	/** How dark the gradient behind the text is, 0–1. */
	scrim: z.number().min(0).max(1),
	uppercase: z.boolean(),
});
export type ThumbnailOverlay = z.infer<typeof ThumbnailOverlay>;

// --- what an author writes ----------------------------------------------------------------

export const ThumbnailDesign = z.object({
	picture: z
		.object({
			sceneId: z.string().optional().describe("Use this scene's picture (without its text)"),
			seconds: z.number().min(0).optional().describe("Or the picture on screen at this moment of the video"),
			assetId: z.string().optional().describe("Or an image or video asset, e.g. one made with asset.generate_image"),
			atSec: z.number().min(0).optional().describe("For a clip or footage: which moment of it"),
		})
		.optional()
		.describe("The background. Defaults to the first scene with a picture, else the brand backdrop"),
	look: TimelineLook.optional().describe("Grade the picture, e.g. { brightness: 0.8, blur: 6 } to push it back behind the text, or { saturation: 1.3 } to make it pop"),
	headline: z.string().max(80).optional().describe("The words on the thumbnail. Two to five words read at feed size; it should add to the title, not repeat it"),
	kicker: z.string().max(40).optional().describe("A small label above the headline, e.g. NEW or PART 2"),
	highlight: z.array(z.string().max(40)).max(8).optional().describe("Words of the headline to draw in the accent colour"),
	textSide: z.enum(["left", "center", "right"]).optional().describe(
			"Where the headline sits (default: opposite the subject, else left). left and right keep it inside that half of the thumbnail, leaving the other half clear, and shrink it to fit there; center spans the width",
		),
	textPosition: z.enum(["top", "center", "bottom"]).optional().describe("Default center"),
	subject: z
		.object({
			assetId: z.string().optional().describe("A transparent image of the subject (asset.generate_image with transparent: true, or an uploaded PNG cut-out)"),
			fromPicture: z.boolean().optional().describe("Or cut the main subject out of the picture (a cent or less; reuses a scene's cut-out when it has one)"),
			side: z.enum(["left", "center", "right"]).optional().describe("Default right"),
			scale: z.number().min(0.4).max(1.5).optional().describe("Height as a share of the thumbnail (default 1)"),
		})
		.optional()
		.describe("A person or object standing in front of the picture, outlined: the strongest thumbnail element there is"),
	logo: z.boolean().optional().describe("Show the brand logo (default false)"),
	scrim: z.number().min(0).max(1).optional().describe("How dark the shade behind the text is (default 0.55)"),
	uppercase: z.boolean().optional(),
});
export type ThumbnailDesign = z.infer<typeof ThumbnailDesign>;

/** The design with its defaults filled in, as stored on the thumbnail asset. */
export function overlayFor(design: ThumbnailDesign, subjectSrc: string | undefined): ThumbnailOverlay {
	const side = design.subject?.side ?? "right";
	const textSide = design.textSide ?? (subjectSrc ? (side === "left" ? "right" : side === "right" ? "left" : "center") : "left");
	return {
		headline: design.headline?.trim() || undefined,
		kicker: design.kicker?.trim() || undefined,
		highlight: design.highlight,
		textSide,
		textPosition: design.textPosition ?? (subjectSrc && side === "center" ? "top" : "center"),
		...(subjectSrc ? { subject: { src: subjectSrc, side, scale: design.subject?.scale ?? 1 } } : {}),
		logo: design.logo ?? false,
		scrim: design.scrim ?? (design.headline ? 0.55 : 0),
		uppercase: design.uppercase ?? false,
	};
}

/**
 * A timeline with one still scene per thumbnail variant (frame i is variant i):
 * the brand theme without captions, watermark or camera motion, so nothing
 * but the picture is drawn under the overlay. Its captions carry the overlay
 * text only so the renderer loads the glyphs the headlines need.
 */
export function thumbnailTimeline(theme: TimelineTheme, backgrounds: TimelineBackground[], texts: string[]): Timeline {
	return {
		version: 1,
		fps: 30,
		durationInFrames: backgrounds.length,
		theme: {
			...theme,
			captions: { ...theme.captions, enabled: false },
			watermark: undefined,
			motion: { ...theme.motion, kenBurns: "none" },
		},
		scenes: backgrounds.map((background, i) => ({
			id: `thumb-${i + 1}`,
			type: "media",
			startFrame: i,
			durationInFrames: 1,
			transition: { type: "cut", durationInFrames: 0 },
			// A clip starts on the chosen moment and does not play on.
			background: background.kind === "video" ? { ...background, loop: false, playbackRate: 1, volume: 0 } : background,
			layout: { align: "left", textPosition: "center", mediaSide: "right" },
			content: {},
		})),
		audio: [],
		captions: texts.filter(Boolean).map((text, i) => ({ startFrame: i, endFrame: i + 1, text, words: [] })),
	};
}

// --- checks -------------------------------------------------------------------------------

const words = (text: string) =>
	text
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s]+/gu, " ")
		.split(/\s+/)
		.filter(Boolean);

export interface ThumbnailNote {
	severity: "warning" | "info";
	kind: string;
	message: string;
	fix?: string;
}

/**
 * Whether a variant will read in a feed. `scale` is how far the renderer had
 * to shrink the headline to fit (1 = not at all).
 */
export function thumbnailNotes(design: ThumbnailDesign, title: string, scale = 1): ThumbnailNote[] {
	const notes: ThumbnailNote[] = [];
	const headline = design.headline?.trim();
	if (!headline) {
		if (!design.subject) notes.push({ severity: "info", kind: "no-hook", message: "No headline and no subject: the picture alone has to make someone click.", fix: "Add a two-to-four-word headline or a cut-out subject." });
		return notes;
	}
	const count = words(headline).length;
	if (count > 6) notes.push({ severity: "warning", kind: "long-headline", message: `The headline has ${count} words; past five or so they shrink until nobody can read them in a feed.`, fix: "Cut it to the two to four words that carry the idea." });
	else if (count > 4) notes.push({ severity: "info", kind: "long-headline", message: `The headline has ${count} words. Fewer read faster.` });

	// Size in CSS px where it is smallest: the up-next column.
	const at720 = HEADLINE_DESIGN_PX * (THUMBNAIL_SIZE.height / 1080) * scale;
	const smallest = FEED_SIZES.at(-1)!;
	const px = Math.round(at720 * (smallest.width / THUMBNAIL_SIZE.width) * 10) / 10;
	if (px < 9) {
		notes.push({
			severity: "warning",
			kind: "headline-too-small",
			message: `The headline had to shrink to ${Math.round(scale * 100)}% to fit, so it is about ${px}px tall in the up-next column: too small to read.`,
			fix: "Use fewer words, or give the text the full width with textSide center.",
		});
	}

	const titleWords = new Set(words(title));
	const shown = words(headline);
	const repeated = shown.filter((word) => titleWords.has(word)).length;
	if (shown.length >= 2 && repeated / shown.length >= 0.75) {
		notes.push({ severity: "info", kind: "repeats-title", message: "The headline mostly repeats the title. The two are seen together, so the thumbnail can say something the title does not.", fix: "Make the headline the hook or the stakes; let the title carry the topic." });
	}
	return notes;
}
