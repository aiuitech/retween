/**
 * fal.ai: subject cut-outs (BiRefNet) and vector illustrations (Recraft V4).
 *
 * Both are optional extras: without FAL_KEY the storyboard still works, the
 * scenes that ask for them just fall back (a whole picture instead of a
 * cut-out) and the reason is reported.
 */
import { env } from "cloudflare:workers";
import type { CostBasis } from "../db/schema.ts";
import { AppError, upstreamError } from "../lib/util.ts";
import { FAL_LIST_USD } from "../services/pricing.ts";

const BASE = "https://fal.run";

export const CUTOUT_MODEL = "fal-ai/birefnet/v2";
export const VECTOR_MODEL = "fal-ai/recraft/v4/text-to-vector";
export const VECTOR_PRO_MODEL = "fal-ai/recraft/v4/pro/text-to-vector";

const key = () => (env as unknown as Record<string, string | undefined>).FAL_KEY || undefined;

export const falConfigured = () => Boolean(key());

/** What one request cost: fal's billable units for it × the endpoint's unit price. */
export interface FalCharge {
	requestId?: string;
	billableUnits?: number;
	unit?: string;
	costUsd: number;
	basis: CostBasis;
}

const unitPrices = new Map<string, { unitPrice: number; unit?: string; at: number }>();

/** An endpoint's current unit price from fal's pricing API, cached for an hour per isolate. */
async function unitPrice(model: string, apiKey: string): Promise<{ unitPrice: number; unit?: string } | undefined> {
	const cached = unitPrices.get(model);
	if (cached && Date.now() - cached.at < 3_600_000) return cached;
	try {
		const response = await fetch(`https://api.fal.ai/v1/models/pricing?endpoint_id=${encodeURIComponent(model)}`, {
			headers: { authorization: `Key ${apiKey}` },
		});
		if (!response.ok) return undefined;
		const json = (await response.json()) as Record<string, unknown>;
		type Price = { endpoint_id?: string; unit_price?: number; unit?: string; currency?: string };
		const list = (json.prices ?? json.data ?? (Array.isArray(json) ? json : [json])) as Price[];
		const price = list.find((entry) => entry.endpoint_id === model) ?? (list.length === 1 ? list[0] : undefined);
		if (typeof price?.unit_price !== "number" || (price.currency && price.currency !== "USD")) return undefined;
		const entry = { unitPrice: price.unit_price, unit: price.unit, at: Date.now() };
		unitPrices.set(model, entry);
		return entry;
	} catch {
		return undefined;
	}
}

async function chargeFor(model: string, apiKey: string, response: Response): Promise<FalCharge> {
	const requestId = response.headers.get("x-fal-request-id") ?? undefined;
	const units = Number(response.headers.get("x-fal-billable-units"));
	const listUsd = FAL_LIST_USD[model] ?? 0;
	if (response.headers.has("x-fal-billable-units") && Number.isFinite(units)) {
		const price = await unitPrice(model, apiKey);
		if (price) return { requestId, billableUnits: units, unit: price.unit, costUsd: units * price.unitPrice, basis: "metered" };
	}
	return { requestId, costUsd: listUsd, basis: "list" };
}

async function run<T>(model: string, what: string, input: Record<string, unknown>): Promise<{ result: T; charge: FalCharge }> {
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
	return { result: (await response.json()) as T, charge: await chargeFor(model, apiKey, response) };
}

type FalFile = { url: string; content_type?: string; width?: number; height?: number };

/** The main subject of an image on a transparent background (PNG). `image` is a data URL or https URL. */
export async function removeBackground(image: string): Promise<{ url: string; model: string; charge: FalCharge }> {
	const { result, charge } = await run<{ image?: FalFile }>(CUTOUT_MODEL, "Background removal", {
		image_url: image,
		model: "General Use (Heavy)",
		operating_resolution: "2048x2048",
		refine_foreground: true,
		output_format: "png",
	});
	if (!result.image?.url) throw new AppError(502, "Background removal returned no image", "upstream_error");
	return { url: result.image.url, model: CUTOUT_MODEL, charge };
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
}): Promise<{ url: string; model: string; charge: FalCharge }> {
	const model = input.pro ? VECTOR_PRO_MODEL : VECTOR_MODEL;
	const { result, charge } = await run<{ images?: FalFile[] }>(model, "Vector illustration", {
		prompt: input.prompt,
		image_size: VECTOR_SIZE[input.aspectRatio] ?? "landscape_16_9",
		colors: input.colors.filter(isHex).slice(0, 6).map(rgb),
		...(input.background && isHex(input.background) ? { background_color: rgb(input.background) } : {}),
		enable_safety_checker: true,
	});
	const file = result.images?.[0];
	if (!file?.url) throw new AppError(502, "Vector illustration returned no image", "upstream_error");
	return { url: file.url, model, charge };
}
