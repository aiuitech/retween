/**
 * fal.ai: subject cut-outs (BiRefNet) and vector illustrations (Recraft V4).
 *
 * Both are optional extras: without FAL_KEY the storyboard still works, the
 * scenes that ask for them just fall back (a whole picture instead of a
 * cut-out) and the reason is reported.
 */
import { env } from "cloudflare:workers";
import { AppError, upstreamError } from "../lib/util.ts";

const BASE = "https://fal.run";

export const CUTOUT_MODEL = "fal-ai/birefnet/v2";
export const VECTOR_MODEL = "fal-ai/recraft/v4/text-to-vector";
export const VECTOR_PRO_MODEL = "fal-ai/recraft/v4/pro/text-to-vector";

/** Published prices (fal does not report cost per request). BiRefNet bills compute time, a fraction of a cent per image. */
export const ESTIMATED_USD = {
	cutout: 0.003,
	vector: 0.08,
	vectorPro: 0.3,
} as const;

const key = () => (env as unknown as Record<string, string | undefined>).FAL_KEY || undefined;

export const falConfigured = () => Boolean(key());

async function run<T>(model: string, what: string, input: Record<string, unknown>): Promise<T> {
	const apiKey = key();
	if (!apiKey) {
		throw new AppError(422, `${what} needs a fal.ai key: set the FAL_KEY secret to enable it`, "not_configured");
	}
	const response = await fetch(`${BASE}/${model}`, {
		method: "POST",
		headers: { authorization: `Key ${apiKey}`, "content-type": "application/json" },
		body: JSON.stringify(input),
	});
	if (!response.ok) throw await upstreamError(what, response);
	return (await response.json()) as T;
}

type FalFile = { url: string; content_type?: string; width?: number; height?: number };

/** The main subject of an image on a transparent background (PNG). `image` is a data URL or https URL. */
export async function removeBackground(image: string): Promise<{ url: string; model: string }> {
	const result = await run<{ image?: FalFile }>(CUTOUT_MODEL, "Background removal", {
		image_url: image,
		model: "General Use (Heavy)",
		operating_resolution: "2048x2048",
		refine_foreground: true,
		output_format: "png",
	});
	if (!result.image?.url) throw new AppError(502, "Background removal returned no image", "upstream_error");
	return { url: result.image.url, model: CUTOUT_MODEL };
}

/** Recraft's size presets, by the video's aspect ratio. */
const VECTOR_SIZE: Record<string, string> = {
	"16:9": "landscape_16_9",
	"9:16": "portrait_16_9",
	"1:1": "square_hd",
	"4:5": "portrait_4_3",
};

const rgb = (hex: string) => {
	const raw = hex.replace("#", "");
	const full = raw.length === 3 ? [...raw].map((c) => c + c).join("") : raw.slice(0, 6);
	return { r: parseInt(full.slice(0, 2), 16), g: parseInt(full.slice(2, 4), 16), b: parseInt(full.slice(4, 6), 16) };
};
const isHex = (value: string) => /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.test(value.trim());

/** A flat vector illustration as an SVG file URL. */
export async function generateVector(input: {
	prompt: string;
	aspectRatio: string;
	/** Hex colours the illustration should favour (the brand palette). */
	colors: string[];
	background?: string;
	pro: boolean;
}): Promise<{ url: string; model: string; costUsd: number }> {
	const model = input.pro ? VECTOR_PRO_MODEL : VECTOR_MODEL;
	const result = await run<{ images?: FalFile[] }>(model, "Vector illustration", {
		prompt: input.prompt,
		image_size: VECTOR_SIZE[input.aspectRatio] ?? "landscape_16_9",
		colors: input.colors.filter(isHex).slice(0, 6).map(rgb),
		...(input.background && isHex(input.background) ? { background_color: rgb(input.background) } : {}),
		enable_safety_checker: true,
	});
	const file = result.images?.[0];
	if (!file?.url) throw new AppError(502, "Vector illustration returned no image", "upstream_error");
	return { url: file.url, model, costUsd: input.pro ? ESTIMATED_USD.vectorPro : ESTIMATED_USD.vector };
}
