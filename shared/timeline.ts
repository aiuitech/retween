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

export const SCENE_TYPES = ["title", "media", "bullets", "quote", "stat", "split", "outro"] as const;
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

export const TimelineBackground = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("image"),
		src: z.string(),
		fit: z.enum(["cover", "contain"]),
		/** Point of interest, 0–1 from the top-left. Kept in frame when cropping. */
		focus: z.object({ x: z.number(), y: z.number() }).optional(),
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
	}),
	z.object({ kind: z.literal("solid"), color }),
	z.object({ kind: z.literal("gradient"), colors: z.array(color).min(2), angle: z.number() }),
	/** The renderer draws its own animated backdrop from the theme colours. */
	z.object({ kind: z.literal("brand") }),
]);
export type TimelineBackground = z.infer<typeof TimelineBackground>;

export const TimelineContent = z.object({
	/** Small label above the heading. */
	kicker: z.string().optional(),
	heading: z.string().optional(),
	subheading: z.string().optional(),
	body: z.string().optional(),
	/** `atFrame` is relative to the scene start: the frame the bullet appears on. */
	bullets: z.array(z.object({ text: z.string(), atFrame: frame })).optional(),
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
		if (scene.background.kind === "image" || scene.background.kind === "video") add(scene.background.src);
	}
	for (const clip of timeline.audio) add(clip.src);
	return [...refs];
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
		scenes: timeline.scenes.map((scene) => ({
			...scene,
			background:
				scene.background.kind === "image" || scene.background.kind === "video"
					? { ...scene.background, src: swap(scene.background.src) }
					: scene.background,
		})),
		audio: timeline.audio.map((clip) => ({ ...clip, src: swap(clip.src) })),
	};
}
