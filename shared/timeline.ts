/**
 * The render contract.
 *
 * A Timeline is the *output* of the compose step and the *input* of the
 * Remotion renderer. It is produced only after every audio/video asset has
 * landed, so every frame number in here is derived from measured media
 * durations (narration length, word timestamps, clip length) rather than from
 * guesses made while storyboarding.
 *
 * A timeline is resolution independent: all frame numbers are absolute at
 * `fps`, and every size in the theme is expressed against a 1080px short side.
 * The renderer receives `{ timeline, width, height }` and lays itself out for
 * whatever aspect ratio it is given.
 *
 * `src` values are stored as `asset://<assetId>` and swapped for short-lived
 * signed URLs just before a render starts.
 */
import { z } from "zod";

export const TIMELINE_VERSION = 1;

export const ASPECT_RATIOS = ["16:9", "9:16", "1:1", "4:5"] as const;
export type AspectRatio = (typeof ASPECT_RATIOS)[number];

/** Named by the length of the short side, in pixels. */
export const RESOLUTIONS = ["480p", "720p", "1080p", "1440p", "2160p"] as const;
export type Resolution = (typeof RESOLUTIONS)[number];

const SHORT_SIDE: Record<Resolution, number> = {
	"480p": 480,
	"720p": 720,
	"1080p": 1080,
	"1440p": 1440,
	"2160p": 2160,
};

/** Pixel dimensions for an aspect ratio + resolution. Always even (h264 requires it). */
export function dimensionsFor(aspect: AspectRatio, resolution: Resolution): { width: number; height: number } {
	const [w, h] = aspect.split(":").map(Number) as [number, number];
	const short = SHORT_SIDE[resolution];
	const even = (n: number) => Math.round(n / 2) * 2;
	return w >= h
		? { width: even((short * w) / h), height: short }
		: { width: short, height: even((short * h) / w) };
}

export const SCENE_TYPES = ["title", "media", "bullets", "quote", "stat", "split", "chart", "map", "outro"] as const;
export type SceneType = (typeof SCENE_TYPES)[number];

export const TRANSITIONS = ["cut", "fade", "slide-left", "slide-up", "wipe", "zoom"] as const;
export type TransitionType = (typeof TRANSITIONS)[number];

const color = z.string();
const frame = z.number().int().nonnegative();

export const TimelineTheme = z.object({
	colors: z.object({
		primary: color,
		secondary: color,
		accent: color,
		background: color,
		surface: color,
		text: color,
		mutedText: color,
	}),
	/** Google Fonts family names. The renderer loads them before the first frame. */
	fonts: z.object({
		heading: z.object({ family: z.string(), weight: z.number() }),
		body: z.object({ family: z.string(), weight: z.number() }),
	}),
	/** Corner radius in px, at a 1080px short side. */
	radius: z.number(),
	motion: z.object({
		energy: z.enum(["calm", "balanced", "punchy"]),
		textAnimation: z.enum(["fade", "rise", "pop", "typewriter"]),
		kenBurns: z.enum(["none", "subtle", "strong"]),
	}),
	captions: z.object({
		enabled: z.boolean(),
		/** `phrase` shows a line at a time; `karaoke` also highlights the spoken word. */
		mode: z.enum(["phrase", "karaoke"]),
		position: z.enum(["top", "center", "bottom"]),
		uppercase: z.boolean(),
		highlightColor: color,
		background: z.enum(["none", "box", "pill"]),
	}),
	/** How dark the scrim over media is when text sits on top of it (0–1). */
	scrim: z.number().min(0).max(1),
	logo: z.object({ src: z.string(), darkSrc: z.string().optional() }).optional(),
	watermark: z
		.object({
			src: z.string(),
			position: z.enum(["top-left", "top-right", "bottom-left", "bottom-right"]),
			opacity: z.number().min(0).max(1),
			/** Width as a fraction of the short side. */
			scale: z.number().min(0.02).max(0.5),
		})
		.optional(),
});
export type TimelineTheme = z.infer<typeof TimelineTheme>;

/**
 * A grade applied to a picture or footage. Neutral values (1, or 0 for the
 * rest) leave it untouched; `temperature` and `tint` are -1…1.
 */
export const TimelineLook = z.object({
	brightness: z.number().min(0).max(2).optional(),
	contrast: z.number().min(0).max(2).optional(),
	saturation: z.number().min(0).max(3).optional(),
	/** Warm (+) or cool (-). */
	temperature: z.number().min(-1).max(1).optional(),
	/** Black and white, 0–1. */
	grayscale: z.number().min(0).max(1).optional(),
	/** Pixels of blur at a 1080px short side. */
	blur: z.number().min(0).max(40).optional(),
	/** Darkened corners, 0–1. */
	vignette: z.number().min(0).max(1).optional(),
});
export type TimelineLook = z.infer<typeof TimelineLook>;

export const TimelineBackground = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("image"),
		src: z.string(),
		fit: z.enum(["cover", "contain"]),
		/** Point of interest, 0–1 from the top-left. Kept in frame when cropping. */
		focus: z.object({ x: z.number(), y: z.number() }).optional(),
		/** SVG only: trace the outlines, then fill the shapes in. */
		draw: z.boolean().optional(),
		/**
		 * The picture's main subject on a transparent background. `parallax` moves it
		 * in front of the picture for depth; `isolate` shows it alone on the brand backdrop.
		 */
		cutout: z.object({ src: z.string(), mode: z.enum(["parallax", "isolate"]) }).optional(),
		look: TimelineLook.optional(),
	}),
	z.object({
		kind: z.literal("video"),
		src: z.string(),
		fit: z.enum(["cover", "contain"]),
		startFromSec: z.number().nonnegative(),
		loop: z.boolean(),
		/** 0 mutes the clip's own audio. */
		volume: z.number().min(0).max(1),
		playbackRate: z.number().positive(),
		focus: z.object({ x: z.number(), y: z.number() }).optional(),
		/** Scale around the focus point (1 = as framed). Used to punch in on footage. */
		zoom: z.number().min(1).max(3).optional(),
		look: TimelineLook.optional(),
	}),
	z.object({ kind: z.literal("solid"), color }),
	z.object({ kind: z.literal("gradient"), colors: z.array(color).min(2), angle: z.number() }),
	/** The renderer draws its own animated backdrop from the theme colours. */
	z.object({ kind: z.literal("brand") }),
	/** A Lottie (Bodymovin JSON) animation, played over the brand backdrop. */
	z.object({ kind: z.literal("lottie"), src: z.string(), loop: z.boolean() }),
]);
export type TimelineBackground = z.infer<typeof TimelineBackground>;

/** An icon file. `mono` icons are drawn in the scene's text colours; others keep their own. */
export const TimelineIcon = z.object({ src: z.string(), mono: z.boolean() });
export type TimelineIcon = z.infer<typeof TimelineIcon>;

export const TimelineChart = z.object({
	kind: z.enum(["column", "bar", "line", "donut"]),
	/** `atFrame` is relative to the scene start: the frame the item appears on. */
	points: z.array(z.object({ label: z.string(), value: z.number(), atFrame: frame, highlight: z.boolean().optional() })).min(1),
	prefix: z.string().optional(),
	suffix: z.string().optional(),
	decimals: z.number().int().min(0).max(4).optional(),
	max: z.number().optional(),
	showValues: z.boolean(),
});
export type TimelineChart = z.infer<typeof TimelineChart>;

export const TimelineMap = z.object({
	/** `atFrame` is relative to the scene start: the frame the pin drops (or, on a tour, the camera arrives). */
	places: z.array(z.object({ name: z.string(), lat: z.number(), lng: z.number(), atFrame: frame })).min(1),
	camera: z.enum(["overview", "tour"]),
	route: z.boolean(),
	zoom: z.number().optional(),
	style: z.enum(["light", "dark"]),
});
export type TimelineMap = z.infer<typeof TimelineMap>;

export const TimelineContent = z.object({
	/** Small label above the heading. */
	kicker: z.string().optional(),
	/** Badge above the heading (or the stat). */
	icon: TimelineIcon.optional(),
	heading: z.string().optional(),
	subheading: z.string().optional(),
	body: z.string().optional(),
	/** `atFrame` is relative to the scene start: the frame the bullet appears on. */
	bullets: z.array(z.object({ text: z.string(), atFrame: frame, icon: TimelineIcon.optional() })).optional(),
	quote: z.string().optional(),
	attribution: z.string().optional(),
	stat: z
		.object({
			/** Shown as-is unless `numeric` is set, in which case the renderer counts up to it. */
			value: z.string(),
			numeric: z.number().optional(),
			decimals: z.number().int().min(0).max(4).optional(),
			prefix: z.string().optional(),
			suffix: z.string().optional(),
			label: z.string().optional(),
		})
		.optional(),
	cta: z.object({ text: z.string(), url: z.string().optional() }).optional(),
	lowerThird: z.object({ title: z.string(), subtitle: z.string().optional() }).optional(),
	showLogo: z.boolean().optional(),
	chart: TimelineChart.optional(),
	map: TimelineMap.optional(),
});
export type TimelineContent = z.infer<typeof TimelineContent>;

export const TimelineScene = z.object({
	id: z.string(),
	type: z.enum(SCENE_TYPES),
	startFrame: frame,
	durationInFrames: z.number().int().positive(),
	/**
	 * How this scene enters. The previous scene stays on screen underneath for
	 * `durationInFrames`, so transitions never shift the timing of anything else.
	 */
	transition: z.object({ type: z.enum(TRANSITIONS), durationInFrames: frame }),
	background: TimelineBackground,
	layout: z.object({
		align: z.enum(["left", "center"]),
		textPosition: z.enum(["top", "center", "bottom"]),
		/** For `split` scenes: which side the media sits on in landscape (it stacks on top in portrait). */
		mediaSide: z.enum(["left", "right"]),
	}),
	content: TimelineContent,
});
export type TimelineScene = z.infer<typeof TimelineScene>;

export const TimelineAudio = z.object({
	id: z.string(),
	kind: z.enum(["narration", "music", "sfx"]),
	src: z.string(),
	startFrame: frame,
	durationInFrames: z.number().int().positive(),
	/** Seconds to skip at the start of the source file. */
	trimStartSec: z.number().nonnegative(),
	volume: z.number().min(0).max(2),
	loop: z.boolean(),
	fadeInFrames: frame,
	fadeOutFrames: frame,
	/** Drop to `volume` (absolute) inside each [start, end] absolute frame range, ramping over `rampFrames`. */
	duck: z
		.object({
			volume: z.number().min(0).max(2),
			ranges: z.array(z.tuple([frame, frame])),
			rampFrames: frame,
		})
		.optional(),
});
export type TimelineAudio = z.infer<typeof TimelineAudio>;

export const TimelineCaption = z.object({
	startFrame: frame,
	endFrame: frame,
	text: z.string(),
	words: z.array(z.object({ text: z.string(), startFrame: frame, endFrame: frame })),
});
export type TimelineCaption = z.infer<typeof TimelineCaption>;

export const Timeline = z.object({
	version: z.literal(TIMELINE_VERSION),
	fps: z.number().int().min(12).max(60),
	durationInFrames: z.number().int().positive(),
	theme: TimelineTheme,
	scenes: z.array(TimelineScene).min(1),
	audio: z.array(TimelineAudio),
	captions: z.array(TimelineCaption),
});
export type Timeline = z.infer<typeof Timeline>;

/** Props handed to the Remotion composition. */
export const RenderProps = z.object({
	timeline: Timeline,
	width: z.number().int().positive(),
	height: z.number().int().positive(),
});
export type RenderProps = z.infer<typeof RenderProps>;

/** Every `asset://<id>` reference in a timeline. */
export function collectAssetRefs(timeline: Timeline): string[] {
	const refs = new Set<string>();
	const add = (src?: string) => {
		if (src?.startsWith("asset://")) refs.add(src.slice("asset://".length));
	};
	add(timeline.theme.logo?.src);
	add(timeline.theme.logo?.darkSrc);
	add(timeline.theme.watermark?.src);
	for (const scene of timeline.scenes) {
		const bg = scene.background;
		if (bg.kind === "image" || bg.kind === "video" || bg.kind === "lottie") add(bg.src);
		if (bg.kind === "image") add(bg.cutout?.src);
		add(scene.content.icon?.src);
		for (const bullet of scene.content.bullets ?? []) add(bullet.icon?.src);
	}
	for (const clip of timeline.audio) add(clip.src);
	return [...refs];
}

/**
 * Returns a copy of the timeline without the `asset://` references `available`
 * rejects (media deleted since the timeline was composed). A background falls
 * back to the brand backdrop, an audio clip is removed, and a logo, dark logo,
 * watermark, cutout or icon is left out. Other URLs are kept as they are.
 */
export function dropMissingAssetRefs(timeline: Timeline, available: (assetId: string) => boolean): Timeline {
	const ok = (src: string) => !src.startsWith("asset://") || available(src.slice("asset://".length));
	const icon = (value?: TimelineIcon) => (value && ok(value.src) ? value : undefined);
	const { logo, watermark } = timeline.theme;
	return {
		...timeline,
		theme: {
			...timeline.theme,
			logo: logo && ok(logo.src) ? { src: logo.src, darkSrc: logo.darkSrc && ok(logo.darkSrc) ? logo.darkSrc : undefined } : undefined,
			watermark: watermark && ok(watermark.src) ? watermark : undefined,
		},
		scenes: timeline.scenes.map((scene) => {
			const bg = scene.background;
			let background: TimelineBackground = bg;
			if ((bg.kind === "image" || bg.kind === "video" || bg.kind === "lottie") && !ok(bg.src)) background = { kind: "brand" };
			else if (bg.kind === "image" && bg.cutout && !ok(bg.cutout.src)) background = { ...bg, cutout: undefined };
			return {
				...scene,
				background,
				content: {
					...scene.content,
					icon: icon(scene.content.icon),
					bullets: scene.content.bullets?.map((bullet) => ({ ...bullet, icon: icon(bullet.icon) })),
				},
			};
		}),
		audio: timeline.audio.filter((clip) => ok(clip.src)),
	};
}

/** Returns a copy of the timeline with each `asset://<id>` replaced by `resolve(id)`. */
export function resolveAssetRefs(timeline: Timeline, resolve: (assetId: string) => string): Timeline {
	const swap = (src: string) => (src.startsWith("asset://") ? resolve(src.slice("asset://".length)) : src);
	return {
		...timeline,
		theme: {
			...timeline.theme,
			logo: timeline.theme.logo && {
				src: swap(timeline.theme.logo.src),
				darkSrc: timeline.theme.logo.darkSrc && swap(timeline.theme.logo.darkSrc),
			},
			watermark: timeline.theme.watermark && { ...timeline.theme.watermark, src: swap(timeline.theme.watermark.src) },
		},
		scenes: timeline.scenes.map((scene) => {
			const bg = scene.background;
			const icon = (value?: TimelineIcon) => value && { ...value, src: swap(value.src) };
			return {
				...scene,
				background:
					bg.kind === "image"
						? { ...bg, src: swap(bg.src), cutout: bg.cutout && { ...bg.cutout, src: swap(bg.cutout.src) } }
						: bg.kind === "video" || bg.kind === "lottie"
							? { ...bg, src: swap(bg.src) }
							: bg,
				content: {
					...scene.content,
					icon: icon(scene.content.icon),
					bullets: scene.content.bullets?.map((bullet) => ({ ...bullet, icon: icon(bullet.icon) })),
				},
			};
		}),
		audio: timeline.audio.map((clip) => ({ ...clip, src: swap(clip.src) })),
	};
}
