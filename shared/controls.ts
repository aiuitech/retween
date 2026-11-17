/**
 * Cost controls: what an account lets Retween spend money on, and how much.
 *
 * They govern new spending only. Media that has already been paid for keeps
 * being used, and changing a control never makes `video.prepare` regenerate
 * anything: limits apply to what is sent to the vendor, not to what counts as
 * "changed" in a storyboard.
 *
 * When a storyboard asks for something that is switched off, preparing still
 * succeeds with a cheaper stand-in, and the reason is reported:
 * - a generated clip becomes its first-frame image, else a generated still, else the brand backdrop
 * - a generated still or vector illustration becomes the brand backdrop
 * - music, sound effects and cut-outs are left out
 * Asking for one directly (asset.generate_video etc.) is refused instead.
 */
import { z } from "zod";
import { RESOLUTIONS } from "./timeline.ts";

export const IMAGE_QUALITIES = ["low", "medium", "high", "xhigh", "max"] as const;
export type ImageQuality = (typeof IMAGE_QUALITIES)[number];
export const CLIP_RESOLUTIONS = ["360p", "720p", "1080p"] as const;

/** ElevenLabs narration models, cheapest first. Flash and Turbo cost half as much per character. */
export const VOICE_MODELS = [
	{ id: "eleven_flash_v2_5", label: "Flash v2.5 (half price, fastest)" },
	{ id: "eleven_turbo_v2_5", label: "Turbo v2.5 (half price)" },
	{ id: "eleven_multilingual_v2", label: "Multilingual v2 (default)" },
	{ id: "eleven_v3", label: "Eleven v3 (most expressive)" },
] as const;
const voiceModelIds = VOICE_MODELS.map((model) => model.id) as [string, ...string[]];

export const CostControls = z.object({
	clips: z.boolean().describe("Generate video clips (by far the most expensive media)"),
	clipMaxResolution: z.enum(CLIP_RESOLUTIONS).describe("Highest resolution a generated clip may have; price rises steeply with it"),
	clipMaxSeconds: z.number().int().min(3).max(15).describe("Longest a generated clip may be"),
	images: z.boolean().describe("Generate still images"),
	imageMaxQuality: z.enum(IMAGE_QUALITIES).describe("Highest image quality; lower quality costs less"),
	vectors: z.boolean().describe("Generate vector illustrations (fal.ai)"),
	vectorPro: z.boolean().describe("Allow the pro vector model (about 4× the price)"),
	cutouts: z.boolean().describe("Cut subjects out of pictures (fal.ai)"),
	music: z.boolean().describe("Compose music beds"),
	soundEffects: z.boolean().describe("Generate sound effects"),
	narrationModel: z
		.enum(voiceModelIds)
		.nullable()
		.describe("Voice every narration with this ElevenLabs model, whatever the brand kit says. null follows the brand kit"),
	renderMaxResolution: z.enum(RESOLUTIONS).describe("Highest export resolution; larger exports take longer to render"),
	monthlyLimitUsd: z
		.number()
		.min(0)
		.max(100000)
		.nullable()
		.describe("Stop paid work once this month's spend reaches this, if lower than the allowance an administrator set. null for no own limit"),
});
export type CostControls = z.infer<typeof CostControls>;

/** Everything on: the behaviour before cost controls existed. */
export const DEFAULT_CONTROLS: CostControls = {
	clips: true,
	clipMaxResolution: "1080p",
	clipMaxSeconds: 15,
	images: true,
	imageMaxQuality: "max",
	vectors: true,
	vectorPro: true,
	cutouts: true,
	music: true,
	soundEffects: true,
	narrationModel: null,
	renderMaxResolution: "2160p",
	monthlyLimitUsd: null,
};

/** The lower of two values from an ordered list. */
export function capAt<T extends string>(order: readonly T[], value: T, cap: T): T {
	return order.indexOf(value) > order.indexOf(cap) ? cap : value;
}

/** Plain-language list of what the controls switch off or limit, for agents planning a storyboard. Empty when nothing is. */
export function describeControls(controls: CostControls): string[] {
	const lines: string[] = [];
	const off = [
		!controls.clips && "generated video clips",
		!controls.images && "generated images",
		!controls.vectors && "vector illustrations",
		!controls.cutouts && "cut-outs",
		!controls.music && "generated music",
		!controls.soundEffects && "generated sound effects",
	].filter(Boolean);
	if (off.length) lines.push(`Switched off: ${off.join(", ")}. Plan scenes around stock, uploaded assets, charts, maps, icons and the brand backdrop instead.`);
	if (controls.clips && (controls.clipMaxResolution !== "1080p" || controls.clipMaxSeconds < 15)) {
		lines.push(`Generated clips are limited to ${controls.clipMaxResolution} and ${controls.clipMaxSeconds} s.`);
	}
	if (controls.images && controls.imageMaxQuality !== "max") lines.push(`Image quality is capped at ${controls.imageMaxQuality}.`);
	if (controls.vectors && !controls.vectorPro) lines.push("Vector illustrations use the standard model, not pro.");
	if (controls.narrationModel) lines.push(`Narration is voiced with ${controls.narrationModel}.`);
	if (controls.renderMaxResolution !== "2160p") lines.push(`Exports are capped at ${controls.renderMaxResolution}.`);
	if (controls.monthlyLimitUsd !== null) lines.push(`Own monthly spending limit: $${controls.monthlyLimitUsd.toFixed(2)}.`);
	return lines;
}
