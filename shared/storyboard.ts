/**
 * The storyboard: what the author (usually an agent) writes.
 *
 * A storyboard says what each scene shows and says. It deliberately contains
 * no frame numbers: timing is worked out by the compose step once narration
 * and footage exist, so scenes are exactly as long as their audio needs.
 */
import { z } from "zod";
import { MUSIC_MODEL_IDS } from "./audio-models.ts";
import { BrandCaptions } from "./brand.ts";
import { SCENE_TYPES, TRANSITIONS, TimelineLook } from "./timeline.ts";

const short = z.string().max(300);

/** An Iconify icon: `prefix:name`, or a bare name from the brand's icon set. */
export const ICON_NAME = /^(?:[a-z0-9]+(?:-[a-z0-9]+)*:)?[a-z0-9]+(?:-[a-z0-9]+)*$/;
const icon = z
	.string()
	.max(80)
	.regex(ICON_NAME, 'an Iconify icon such as "lucide:rocket", or "rocket" for the brand\'s icon set')
	.describe('Iconify icon, e.g. "lucide:rocket" or "ph:lightning". A bare name such as "rocket" uses the brand\'s icon set (lucide unless the brand kit says otherwise). Find names with icon.search');

/** The icon set used when a scene names an icon without a prefix. */
export const DEFAULT_ICON_SET = "lucide";

/** `rocket` → `lucide:rocket`; names that already carry a prefix are kept. */
export function iconName(name: string, iconSet?: string): string {
	const trimmed = name.trim().toLowerCase();
	return trimmed.includes(":") ? trimmed : `${(iconSet ?? DEFAULT_ICON_SET).trim().toLowerCase()}:${trimmed}`;
}

/** Every icon a storyboard uses, with the brand's set applied. */
export function storyboardIcons(board: Storyboard, iconSet?: string): string[] {
	const names = new Set<string>();
	for (const scene of board.scenes) {
		if (scene.text?.icon) names.add(iconName(scene.text.icon, iconSet));
		for (const bullet of scene.text?.bullets ?? []) if (bullet.icon) names.add(iconName(bullet.icon, iconSet));
	}
	return [...names];
}

/** A colour grade and effects for a picture or footage. */
export const SceneLook = TimelineLook.describe(
	"Grade the picture: brightness, contrast (1 = unchanged, 0–2), saturation (0 = black and white, 1 = unchanged), temperature (-1 cool … 1 warm), " +
		"grayscale (0–1), blur (px, e.g. 8 to push a busy background back behind text) and vignette (0–1 darker corners)",
);

export const SceneVisual = z
	.object({
		source: z
			.enum(["asset", "image", "vector", "video", "stock", "solid", "gradient", "brand"])
			.describe(
				"asset: use an existing project asset (an image, a video or a Lottie animation). image: generate a still. " +
					"vector: generate a flat vector illustration in the brand colours that draws itself on. video: generate a short clip (expensive, use sparingly). " +
					"stock: find free stock media. solid/gradient: flat colour. brand: the animated brand backdrop.",
			),
		assetId: z.string().optional().describe("source=asset: the image, video or Lottie animation to show"),
		prompt: z
			.string()
			.max(4000)
			.optional()
			.describe("source=image|vector|video: what to generate. Describe the subject and framing; the project's style lock is added for you"),
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
		draw: z
			.boolean()
			.optional()
			.describe("source=vector, or an SVG asset: trace the outlines first, then fill the shapes in (default true for vector)"),
		cutout: z
			.enum(["parallax", "isolate"])
			.optional()
			.describe(
				"Still images only. Cuts the main subject out of the picture. parallax: the subject floats in front of its own background " +
					"for a 2.5D camera push (motion without paying for a clip). isolate: the subject alone on the brand backdrop, like a product shot",
			),
		fit: z.enum(["cover", "contain"]).optional(),
		focus: z
			.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) })
			.optional()
			.describe("Point of interest (0–1 from the top-left) kept in frame when the media is cropped to other aspect ratios"),
		startFromSec: z.number().min(0).optional().describe("Video: where in the clip to start"),
		loop: z.boolean().optional().describe("Video or Lottie: loop if the scene outlasts it (default true)"),
		volume: z.number().min(0).max(1).optional().describe("Video: volume of the clip's own audio (default 0, muted)"),
		speed: z.number().min(0.25).max(4).optional().describe("Video: playback speed, e.g. 0.5 for slow motion or 2 for a time-lapse feel (default 1)"),
		look: SceneLook.optional(),
	})
	.superRefine((visual, ctx) => {
		const need = (field: "assetId" | "prompt" | "query") => {
			if (!visual[field]) ctx.addIssue({ code: "custom", path: [field], message: `source "${visual.source}" needs ${field}` });
		};
		if (visual.source === "asset") need("assetId");
		if (visual.source === "image" || visual.source === "vector" || visual.source === "video") need("prompt");
		if (visual.source === "stock") need("query");
	});
export type SceneVisual = z.infer<typeof SceneVisual>;

export const SceneText = z.object({
	kicker: short.optional().describe("Small label above the heading"),
	icon: icon.optional().describe("An icon badge above the heading (or the stat)"),
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
				icon: icon.optional().describe("Shown in place of the bullet number"),
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

const cue = short
	.optional()
	.describe("A few words from the narration; this item appears as they are spoken. Omit to reveal items one after another");

export const SceneChart = z
	.object({
		kind: z
			.enum(["column", "bar", "line", "donut"])
			.default("column")
			.describe("column: vertical bars. bar: horizontal bars (best for long labels and portrait videos). line: a trend over time. donut: parts of a whole"),
		data: z
			.array(
				z.object({
					label: short.describe("Category, period or share name"),
					value: z.number(),
					cue,
					highlight: z.boolean().optional().describe("Draw this one in the accent colour; the rest are muted"),
				}),
			)
			.min(1)
			.max(24),
		prefix: z.string().max(8).optional().describe('Shown before values, e.g. "$"'),
		suffix: z.string().max(8).optional().describe('Shown after values, e.g. "%" or "k"'),
		decimals: z.number().int().min(0).max(4).optional(),
		max: z.number().optional().describe("Top of the value axis (defaults to the largest value)"),
		showValues: z.boolean().optional().describe("Print each value on the chart (default true)"),
	})
	.superRefine((chart, ctx) => {
		const limit = chart.kind === "line" ? 24 : chart.kind === "donut" ? 8 : 12;
		if (chart.data.length > limit) ctx.addIssue({ code: "custom", path: ["data"], message: `a ${chart.kind} chart takes at most ${limit} items` });
		if (chart.kind === "line" && chart.data.length < 2) ctx.addIssue({ code: "custom", path: ["data"], message: "a line chart needs at least 2 points" });
		if (chart.kind === "donut" && chart.data.some((item) => item.value < 0)) {
			ctx.addIssue({ code: "custom", path: ["data"], message: "donut values cannot be negative" });
		}
	});
export type SceneChart = z.infer<typeof SceneChart>;

export const SceneMap = z.object({
	places: z
		.array(
			z.object({
				name: short.describe("Label shown on the map"),
				lat: z.number().min(-85).max(85),
				lng: z.number().min(-180).max(180),
				cue,
			}),
		)
		.min(1)
		.max(8)
		.describe("Coordinates in decimal degrees. Look them up with place.search if you are not sure"),
	camera: z
		.enum(["overview", "tour"])
		.optional()
		.describe("overview: frame every place and pin them one by one (default). tour: fly from place to place, arriving at each on its cue"),
	route: z.boolean().optional().describe("Draw a line through the places in order"),
	zoom: z.number().min(1).max(16).optional().describe("Zoom when there is one place (default 11: a city). 3 is a continent, 14 a neighbourhood"),
	style: z.enum(["light", "dark"]).optional().describe("Defaults to match the brand background"),
});
export type SceneMap = z.infer<typeof SceneMap>;

export const SceneFootage = z.object({
	assetId: z
		.string()
		.describe("A recording of the person: a video or audio asset with a transcript (uploaded videos get one automatically; otherwise run footage.process)"),
	from: z
		.union([z.number().min(0), short])
		.optional()
		.describe('Where the stretch starts: the first few words spoken, quoted from footage.transcript (e.g. "so here is the thing"), or seconds into the recording. Default: the beginning'),
	to: z
		.union([z.number().min(0), short])
		.optional()
		.describe('Where it ends: the last few words spoken (e.g. "every single time"), or seconds. Default: the end. Cuts are placed in the pauses around words, so none is clipped'),
	after: z.number().min(0).optional().describe("When the `from` words are said more than once: use the first time after this many seconds"),
	show: z
		.enum(["speaker", "voice"])
		.optional()
		.describe(
			"speaker: the footage is the scene's picture (full frame in a media scene, beside the text in a split scene). " +
				"voice: only its sound, over the scene's own visual (b-roll, a chart, a still). Default speaker for video, voice for audio",
		),
	volume: z.number().min(0).max(2).optional().describe("Loudness of the recording (default 1; it is levelled when processed)"),
	zoom: z
		.number()
		.min(1)
		.max(2)
		.optional()
		.describe("Punch in on the picture, e.g. 1.15. Back-to-back cuts from the same recording alternate between 1 and 1.12 on their own, which hides jump cuts"),
	focus: z
		.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) })
		.optional()
		.describe("The point kept in frame when cropping, usually the face (0–1 from the top-left)"),
	look: SceneLook.optional(),
});
export type SceneFootage = z.infer<typeof SceneFootage>;

export const Scene = z.object({
	id: z
		.string()
		.regex(/^[a-z0-9][a-z0-9-]{0,39}$/, "lowercase letters, digits and dashes")
		.describe("Stable id. Keep it when editing a scene so its generated media is reused"),
	type: z
		.enum(SCENE_TYPES)
		.describe(
			"title: big opening headline. media: full-frame visual with optional caption text. bullets: list revealed in time with narration. " +
				"quote: pull quote. stat: one big number. split: visual beside text. chart: an animated chart (set chart). " +
				"map: an animated map with pinned places (set map). outro: logo and call to action.",
		),
	label: short.optional().describe("Working title for the scene, never shown"),
	narration: z.string().max(3000).optional().describe("What the voice says. The scene lasts as long as this takes to say"),
	footage: SceneFootage.optional().describe(
		"Use a stretch of the person's own recording instead of generated narration: the scene lasts as long as the stretch, and captions, cues and music ducking follow what they say",
	),
	visual: SceneVisual.optional().describe("What is on screen behind or beside the text. Defaults to the brand backdrop"),
	text: SceneText.optional().describe("On-screen text"),
	chart: SceneChart.optional().describe("type=chart: the data to plot. Values reveal in time with the narration"),
	map: SceneMap.optional().describe("type=map: the places to show. The map is drawn in the brand colours"),
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
	model: z.enum(MUSIC_MODEL_IDS).optional().describe("Who composes it. Defaults to the brand's audio.musicModel, else elevenlabs"),
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
			if (scene.footage && scene.narration?.trim()) {
				ctx.addIssue({ code: "custom", path: ["scenes", index, "footage"], message: `scene "${scene.id}" has both narration and footage; use one` });
			}
			if (scene.type === "chart" && !scene.chart) {
				ctx.addIssue({ code: "custom", path: ["scenes", index, "chart"], message: `chart scene "${scene.id}" needs chart data` });
			}
			if (scene.type === "map" && !scene.map) {
				ctx.addIssue({ code: "custom", path: ["scenes", index, "map"], message: `map scene "${scene.id}" needs map places` });
			}
		});
	});
export type Storyboard = z.infer<typeof Storyboard>;

export const EMPTY_STORYBOARD: Storyboard = { scenes: [] };
