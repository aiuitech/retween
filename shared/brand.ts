/**
 * The brand kit: everything a project remembers so that every video made in
 * it looks, sounds and reads like the same brand.
 *
 * Every field is optional. A project starts empty and is filled in over time,
 * by a person or by the agent. `brand.update` deep-merges a partial kit
 * (arrays replace, `null` clears a field), and `resolveTheme` turns whatever is
 * there into the concrete theme the renderer needs.
 */
import { z } from "zod";
import { DEFAULT_MASTER_LUFS, MASTER_TRUE_PEAK, MUSIC_MODELS, MUSIC_MODEL_IDS } from "./audio-models.ts";
import { ASPECT_RATIOS, RESOLUTIONS, TRANSITIONS, type TimelineTheme } from "./timeline.ts";

const hexColor = z
	.string()
	.regex(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/, "Use a hex colour such as #1A2B3C");
const assetId = z.string().describe("ID of an asset in this project");
const text = z.string().max(4000);
const short = z.string().max(300);

export const BrandIdentity = z
	.object({
		name: short.describe("Brand or product name as it should be written"),
		tagline: short,
		description: text.describe("What the brand is and does, in a paragraph"),
		mission: text,
		industry: short,
		website: short,
		values: z.array(short).max(12).describe("What the brand stands for"),
		differentiators: z.array(short).max(12).describe("Why this over the alternatives"),
	})
	.partial();

export const BrandAudience = z
	.object({
		summary: text.describe("Who the videos are for"),
		personas: z
			.array(
				z.object({
					name: short,
					description: text.optional(),
					painPoints: z.array(short).optional(),
					goals: z.array(short).optional(),
				}),
			)
			.max(8),
		desiredFeeling: short.describe("How a viewer should feel at the end of a video"),
		readingLevel: short.describe('e.g. "plain English, no jargon" or "expert practitioner"'),
		platforms: z.array(short).max(12).describe("Where the videos are published, e.g. YouTube Shorts, LinkedIn"),
	})
	.partial();

export const BrandMessaging = z
	.object({
		tone: z.array(short).max(10).describe('Adjectives for the writing voice, e.g. ["direct","warm","dry"]'),
		pointOfView: z.enum(["we", "you", "i", "third-person"]),
		pillars: z.array(short).max(10).describe("Themes the brand keeps returning to"),
		doSay: z.array(short).max(30).describe("Phrases and framings to use"),
		dontSay: z.array(short).max(30).describe("Phrases, claims and clichés to avoid"),
		hooks: z.array(short).max(20).describe("Opening-line patterns that have worked"),
		ctas: z.array(z.object({ label: short, text: short, url: short.optional() })).max(10),
		disclaimers: z.array(text).max(10).describe("Legal or compliance lines that must appear when relevant"),
		glossary: z
			.array(z.object({ term: short, definition: text.optional() }))
			.max(60)
			.describe("Product names and terms, spelled exactly as they should appear on screen"),
	})
	.partial();

export const BrandNarration = z
	.object({
		voiceId: short.describe("Narration voice: an ElevenLabs voice ID, or for an OpenRouter model one of its voice names (voice.list with that model)"),
		voiceName: short,
		modelId: short.describe(
			"Voice model: ElevenLabs (eleven_multilingual_v2, eleven_flash_v2_5, eleven_v3) or a much cheaper OpenRouter speech model named vendor/model, e.g. hexgrad/kokoro-82m or google/gemini-3.8-flash-tts (voice.list with models: true lists them with prices)",
		),
		language: short.describe("ISO 639-1 code, e.g. en"),
		stability: z.number().min(0).max(1),
		similarity: z.number().min(0).max(1),
		style: z.number().min(0).max(1),
		speed: z.number().min(0.7).max(1.2),
		speakerBoost: z.boolean(),
		direction: text.describe("How the read should feel: pace, energy, where to pause"),
		wordsPerMinute: z.number().min(80).max(220).describe("Target pace, used when estimating script length"),
		pronunciations: z
			.array(z.object({ term: short, say: short.describe("Respelling the voice will read correctly") }))
			.max(80)
			.describe("Applied to narration text before synthesis; on-screen text is never changed"),
	})
	.partial();

export const BrandVisual = z
	.object({
		palette: z
			.object({
				primary: hexColor,
				secondary: hexColor,
				accent: hexColor,
				background: hexColor,
				surface: hexColor,
				text: hexColor,
				mutedText: hexColor,
			})
			.partial(),
		fonts: z
			.object({
				heading: short.describe("Google Fonts family for headings"),
				headingWeight: z.number().min(100).max(900),
				body: short.describe("Google Fonts family for body text"),
				bodyWeight: z.number().min(100).max(900),
			})
			.partial(),
		logo: z
			.object({
				assetId: assetId.describe("Logo for light backgrounds"),
				darkAssetId: assetId.describe("Logo for dark backgrounds"),
			})
			.partial(),
		cornerRadius: z.number().min(0).max(120).describe("Corner radius in px at 1080p"),
		scrim: z.number().min(0).max(1).describe("How much footage is darkened behind text (0–1)"),
		imageStyle: z
			.object({
				prompt: text.describe("Style lock appended to every image prompt: medium, lighting, lens, palette, mood"),
				avoid: text.describe("What generated images must not contain"),
				referenceAssetIds: z
					.array(assetId)
					.max(8)
					.describe("Reference images passed to the image model so new images match"),
				quality: z.enum(["low", "medium", "high", "xhigh", "max"]),
			})
			.partial(),
		videoStyle: z
			.object({
				prompt: text.describe("Style lock appended to every generated-video prompt: camera movement, grade, pace"),
			})
			.partial(),
		stockStyle: text.describe("What stock footage should look like, and what to skip (e.g. no handshake clichés)"),
		iconSet: z
			.string()
			.max(40)
			.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
			.describe('Iconify icon set used for icons named without a prefix, so every video uses one consistent style. e.g. "lucide" (default), "tabler", "ph", "mdi", "fluent-emoji-flat"'),
	})
	.partial();

export const BrandMotion = z
	.object({
		energy: z.enum(["calm", "balanced", "punchy"]),
		textAnimation: z.enum(["fade", "rise", "pop", "typewriter"]),
		kenBurns: z.enum(["none", "subtle", "strong"]).describe("Movement applied to still images"),
		transition: z.enum(TRANSITIONS).describe("Default transition between scenes"),
		transitionMs: z.number().min(0).max(2000),
	})
	.partial();

export const BrandCaptions = z
	.object({
		enabled: z.boolean(),
		mode: z.enum(["phrase", "karaoke"]),
		position: z.enum(["top", "center", "bottom"]),
		uppercase: z.boolean(),
		highlightColor: hexColor,
		background: z.enum(["none", "box", "pill"]),
		maxWordsPerLine: z.number().int().min(1).max(12),
	})
	.partial();

export const BrandAudio = z
	.object({
		musicPrompt: text.describe("Genre, tempo, instrumentation and mood for generated music beds"),
		musicModel: z
			.enum(MUSIC_MODEL_IDS)
			.describe(`Who composes generated music beds. ${MUSIC_MODELS.map((model) => `${model.id}: ${model.label}`).join(". ")}`),
		musicAssetId: assetId.describe("Default music bed used when a video does not name one"),
		musicVolume: z.number().min(0).max(1),
		duckedVolume: z.number().min(0).max(1).describe("Music volume while narration is speaking"),
		introStingAssetId: assetId.describe("Sonic logo played over the first scene"),
		outroStingAssetId: assetId.describe("Sonic logo played over the last scene"),
		sfxPolicy: text.describe("When sound effects are welcome and when they are not"),
		loudness: z
			.union([z.number().min(-30).max(-9), z.literal("off")])
			.describe(
				`Integrated loudness every export is levelled to, in LUFS, with peaks held under ${MASTER_TRUE_PEAK} dBTP. Default ${DEFAULT_MASTER_LUFS} (YouTube and most platforms); -16 suits podcasts and Apple. "off" leaves the mix as it is`,
			),
	})
	.partial();

export const BrandFormat = z
	.object({
		aspectRatios: z.array(z.enum(ASPECT_RATIOS)).describe("Aspect ratios every video should be exported in"),
		resolution: z.enum(RESOLUTIONS),
		fps: z.union([z.literal(24), z.literal(25), z.literal(30), z.literal(50), z.literal(60)]),
		targetSeconds: z.number().min(3).max(1800).describe("Typical finished length"),
		minSceneSeconds: z.number().min(0.5).max(30),
		maxSceneSeconds: z.number().min(1).max(120),
		leadInMs: z.number().min(0).max(3000).describe("Silence before narration starts in a scene"),
		tailMs: z.number().min(0).max(5000).describe("Silence held after narration ends in a scene"),
		watermark: z
			.object({
				enabled: z.boolean(),
				assetId,
				position: z.enum(["top-left", "top-right", "bottom-left", "bottom-right"]),
				opacity: z.number().min(0).max(1),
				scale: z.number().min(0.02).max(0.5),
			})
			.partial(),
		structure: text.describe("The shape videos usually take, e.g. hook → problem → proof → CTA"),
	})
	.partial();

export const BrandCastMember = z.object({
	id: z.string().max(60).describe("Short handle used to refer to this subject in scenes"),
	name: short,
	kind: z.enum(["person", "character", "product", "place", "object"]).optional(),
	description: text.describe("Exactly how this subject looks, in words an image model can follow"),
	referenceAssetIds: z.array(assetId).max(6).optional(),
});

export const BrandKit = z
	.object({
		identity: BrandIdentity,
		audience: BrandAudience,
		messaging: BrandMessaging,
		narration: BrandNarration,
		visual: BrandVisual,
		motion: BrandMotion,
		captions: BrandCaptions,
		audio: BrandAudio,
		format: BrandFormat,
		cast: z.array(BrandCastMember).max(40).describe("Recurring people, characters, products and places"),
		instructions: z
			.string()
			.max(20000)
			.describe("Standing instructions for whoever makes videos in this project. Read before every job."),
	})
	.partial();
export type BrandKit = z.infer<typeof BrandKit>;

/**
 * Deep-merges `patch` into `base`. Objects merge, arrays and scalars replace,
 * and an explicit `null` removes the key.
 */
export function mergeBrand<T>(base: T, patch: unknown): T {
	if (patch === undefined) return base;
	if (patch === null || typeof patch !== "object" || Array.isArray(patch)) return patch as T;
	const out: Record<string, unknown> =
		base && typeof base === "object" && !Array.isArray(base) ? { ...(base as Record<string, unknown>) } : {};
	for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
		if (value === null) delete out[key];
		else out[key] = mergeBrand(out[key], value);
	}
	return out as T;
}

export const DEFAULT_PALETTE = {
	primary: "#111418",
	secondary: "#3B4252",
	accent: "#F2B33D",
	background: "#0E1013",
	surface: "#1A1D22",
	text: "#F5F3EE",
	mutedText: "#A8A49B",
};

export const DEFAULTS = {
	fps: 30 as const,
	leadInMs: 250,
	tailMs: 450,
	minSceneSeconds: 1.5,
	maxSceneSeconds: 30,
	transition: "fade" as const,
	transitionMs: 400,
	musicVolume: 0.5,
	duckedVolume: 0.12,
	captionWords: 6,
	voiceId: "JBFqnCBsd6RMkjVDRZzb",
	voiceModel: "eleven_multilingual_v2",
};

/**
 * The concrete render theme for a brand kit. `assetSrc` maps an asset ID to
 * the `src` the timeline should carry, and returns undefined for assets that
 * no longer exist.
 */
/** Blends two hex colours: 0 gives `a`, 1 gives `b`. */
function mix(a: string, b: string, amount: number): string {
	const parse = (hex: string) => {
		const value = hex.replace("#", "");
		const full = value.length === 3 ? [...value].map((c) => c + c).join("") : value.slice(0, 6);
		return [0, 2, 4].map((i) => Number.parseInt(full.slice(i, i + 2), 16));
	};
	const [x, y] = [parse(a), parse(b)];
	return `#${x.map((channel, i) => Math.round(channel + (y[i]! - channel) * amount).toString(16).padStart(2, "0")).join("")}`;
}

const isLight = (hex: string) => {
	const value = hex.replace("#", "");
	const full = value.length === 3 ? [...value].map((c) => c + c).join("") : value;
	const [r, g, b] = [0, 2, 4].map((i) => Number.parseInt(full.slice(i, i + 2), 16));
	return (r! * 299 + g! * 587 + b! * 114) / 1000 > 150;
};

/**
 * A full palette from whatever the brand has set. Colours that were not given
 * are derived from the ones that were, so a brand that only names a background
 * and an accent still gets a palette that belongs together.
 */
export function resolvePalette(given: NonNullable<NonNullable<BrandKit["visual"]>["palette"]> = {}) {
	if (!Object.keys(given).length) return DEFAULT_PALETTE;
	const background = given.background ?? DEFAULT_PALETTE.background;
	const text = given.text ?? (isLight(background) ? "#15130F" : "#F5F3EE");
	const primary = given.primary ?? mix(background, text, 0.12);
	return {
		background,
		text,
		primary,
		secondary: given.secondary ?? mix(primary, background, 0.45),
		accent: given.accent ?? DEFAULT_PALETTE.accent,
		surface: given.surface ?? mix(background, text, 0.08),
		mutedText: given.mutedText ?? mix(text, background, 0.4),
	};
}

export function resolveTheme(brand: BrandKit, assetSrc: (assetId: string) => string | undefined): TimelineTheme {
	const palette = resolvePalette(brand.visual?.palette);
	const fonts = brand.visual?.fonts ?? {};
	const logoSrc = brand.visual?.logo?.assetId ? assetSrc(brand.visual.logo.assetId) : undefined;
	const darkLogoSrc = brand.visual?.logo?.darkAssetId ? assetSrc(brand.visual.logo.darkAssetId) : undefined;
	const mark = brand.format?.watermark;
	const markSrc = mark?.enabled !== false && mark?.assetId ? assetSrc(mark.assetId) : undefined;
	return {
		colors: palette,
		fonts: {
			heading: { family: fonts.heading ?? "Inter", weight: fonts.headingWeight ?? 700 },
			body: { family: fonts.body ?? fonts.heading ?? "Inter", weight: fonts.bodyWeight ?? 400 },
		},
		radius: brand.visual?.cornerRadius ?? 16,
		motion: {
			energy: brand.motion?.energy ?? "balanced",
			textAnimation: brand.motion?.textAnimation ?? "rise",
			kenBurns: brand.motion?.kenBurns ?? "subtle",
		},
		captions: {
			enabled: brand.captions?.enabled ?? true,
			mode: brand.captions?.mode ?? "karaoke",
			position: brand.captions?.position ?? "bottom",
			uppercase: brand.captions?.uppercase ?? false,
			highlightColor: brand.captions?.highlightColor ?? palette.accent,
			background: brand.captions?.background ?? "none",
		},
		scrim: brand.visual?.scrim ?? 0.45,
		logo: logoSrc || darkLogoSrc ? { src: (logoSrc ?? darkLogoSrc)!, darkSrc: darkLogoSrc } : undefined,
		watermark: markSrc
			? {
					src: markSrc,
					position: mark?.position ?? "top-right",
					opacity: mark?.opacity ?? 0.7,
					scale: mark?.scale ?? 0.1,
				}
			: undefined,
	};
}
