/**
 * The storyboard: what the author (usually an agent) writes.
 *
 * A storyboard says what each scene shows and says. It deliberately contains
 * no frame numbers: timing is worked out by the compose step once narration
 * and footage exist, so scenes are exactly as long as their audio needs.
 */
import { z } from "zod";
import { BrandCaptions } from "./brand.ts";
import { SCENE_TYPES, TRANSITIONS } from "./timeline.ts";

const short = z.string().max(300);

export const SceneVisual = z
	.object({
		source: z
			.enum(["asset", "image", "video", "stock", "solid", "gradient", "brand"])
			.describe(
				"asset: use an existing project asset. image: generate a still. video: generate a short clip (expensive, use sparingly). " +
					"stock: find free stock media. solid/gradient: flat colour. brand: the animated brand backdrop.",
			),
		assetId: z.string().optional().describe("source=asset: the image or video asset to show"),
		prompt: z
			.string()
			.max(4000)
			.optional()
			.describe("source=image|video: what to generate. Describe the subject and framing; the project's style lock is added for you"),
		cast: z
			.array(z.string())
			.max(6)
			.optional()
			.describe("source=image: ids of brand cast members who appear, so their descriptions and reference images are used"),
		referenceAssetIds: z.array(z.string()).max(8).optional().describe("source=image: extra reference images for this scene"),
		firstFrameAssetId: z.string().optional().describe("source=video: an image asset to animate from"),
		seconds: z.number().min(3).max(15).optional().describe("source=video: clip length. Defaults to the scene's narration length"),
		query: short.optional().describe("source=stock: search terms"),
		media: z.enum(["image", "video"]).optional().describe("source=stock: what kind of stock to look for (default image)"),
		color: z.string().optional().describe("source=solid: hex colour (defaults to the brand background)"),
		colors: z.array(z.string()).min(2).max(4).optional().describe("source=gradient: hex colours"),
		angle: z.number().optional().describe("source=gradient: angle in degrees"),
		fit: z.enum(["cover", "contain"]).optional(),
		focus: z
			.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) })
			.optional()
			.describe("Point of interest (0–1 from the top-left) kept in frame when the media is cropped to other aspect ratios"),
		startFromSec: z.number().min(0).optional().describe("Video: where in the clip to start"),
		loop: z.boolean().optional().describe("Video: loop if the scene outlasts the clip (default true)"),
		volume: z.number().min(0).max(1).optional().describe("Video: volume of the clip's own audio (default 0, muted)"),
	})
	.superRefine((visual, ctx) => {
		const need = (field: "assetId" | "prompt" | "query") => {
			if (!visual[field]) ctx.addIssue({ code: "custom", path: [field], message: `source "${visual.source}" needs ${field}` });
		};
		if (visual.source === "asset") need("assetId");
		if (visual.source === "image" || visual.source === "video") need("prompt");
		if (visual.source === "stock") need("query");
	});
export type SceneVisual = z.infer<typeof SceneVisual>;

export const SceneText = z.object({
	kicker: short.optional().describe("Small label above the heading"),
	heading: short.optional(),
	subheading: short.optional(),
	body: z.string().max(1200).optional(),
	bullets: z
		.array(
			z.object({
				text: short,
				cue: short
					.optional()
					.describe("A few words from the narration; the bullet appears as they are spoken. Omit to space bullets evenly"),
			}),
		)
		.max(8)
		.optional(),
	quote: z.string().max(600).optional(),
	attribution: short.optional(),
	stat: z
		.object({
			value: short.describe('The figure as shown, e.g. "42%" or "3.2M"'),
			numeric: z.number().optional().describe("Set to count up to this number"),
			decimals: z.number().int().min(0).max(4).optional(),
			prefix: z.string().max(8).optional(),
			suffix: z.string().max(8).optional(),
			label: short.optional(),
		})
		.optional(),
	cta: z.object({ text: short, url: short.optional() }).optional(),
	lowerThird: z.object({ title: short, subtitle: short.optional() }).optional(),
	showLogo: z.boolean().optional(),
});
export type SceneText = z.infer<typeof SceneText>;

export const SceneSfx = z.object({
	assetId: z.string().optional().describe("An existing audio asset"),
	prompt: short.optional().describe("Or describe a sound effect to generate"),
	at: z
		.union([z.enum(["start", "end"]), z.number().min(0)])
		.optional()
		.describe('"start", "end", or seconds from the start of the scene (default start)'),
	volume: z.number().min(0).max(1).optional(),
});

export const Scene = z.object({
	id: z
		.string()
		.regex(/^[a-z0-9][a-z0-9-]{0,39}$/, "lowercase letters, digits and dashes")
		.describe("Stable id. Keep it when editing a scene so its generated media is reused"),
	type: z
		.enum(SCENE_TYPES)
		.describe(
			"title: big opening headline. media: full-frame visual with optional caption text. bullets: list revealed in time with narration. " +
				"quote: pull quote. stat: one big number. split: visual beside text. outro: logo and call to action.",
		),
	label: short.optional().describe("Working title for the scene, never shown"),
	narration: z.string().max(3000).optional().describe("What the voice says. The scene lasts as long as this takes to say"),
	visual: SceneVisual.optional().describe("What is on screen behind or beside the text. Defaults to the brand backdrop"),
	text: SceneText.optional().describe("On-screen text"),
	layout: z
		.object({
			align: z.enum(["left", "center"]).optional(),
			textPosition: z.enum(["top", "center", "bottom"]).optional(),
			mediaSide: z.enum(["left", "right"]).optional(),
		})
		.optional(),
	transition: z
		.object({ type: z.enum(TRANSITIONS), ms: z.number().min(0).max(2000).optional() })
		.optional()
		.describe("How this scene enters. Defaults to the brand transition"),
	timing: z
		.object({
			seconds: z.number().min(0.5).max(120).optional().describe("Force an exact length (narration is not stretched to fit)"),
			minSeconds: z.number().min(0.5).max(120).optional(),
			leadInMs: z.number().min(0).max(5000).optional().describe("Silence before narration starts"),
			tailMs: z.number().min(0).max(8000).optional().describe("Hold after narration ends"),
		})
		.optional(),
	voice: z
		.object({ voiceId: short.optional(), speed: z.number().min(0.7).max(1.2).optional() })
		.optional()
		.describe("Narrate this scene with a different voice or pace"),
	sfx: z.array(SceneSfx).max(4).optional(),
	notes: z.string().max(2000).optional().describe("Director's notes, never shown"),
});
export type Scene = z.infer<typeof Scene>;

export const StoryboardMusic = z.object({
	enabled: z.boolean().optional().describe("Set false for no music. Defaults to on when the brand has a music bed or prompt"),
	assetId: z.string().optional().describe("An existing audio asset to use as the bed"),
	prompt: z.string().max(2000).optional().describe("Or describe music to generate for this video"),
	volume: z.number().min(0).max(1).optional(),
	duckedVolume: z.number().min(0).max(1).optional().describe("Volume while narration is speaking"),
});

export const Storyboard = z
	.object({
		scenes: z.array(Scene).max(80),
		music: StoryboardMusic.optional(),
		captions: BrandCaptions.optional().describe("Override the brand's caption settings for this video"),
	})
	.superRefine((board, ctx) => {
		const seen = new Set<string>();
		board.scenes.forEach((scene, index) => {
			if (seen.has(scene.id)) {
				ctx.addIssue({ code: "custom", path: ["scenes", index, "id"], message: `duplicate scene id "${scene.id}"` });
			}
			seen.add(scene.id);
		});
	});
export type Storyboard = z.infer<typeof Storyboard>;

export const EMPTY_STORYBOARD: Storyboard = { scenes: [] };
