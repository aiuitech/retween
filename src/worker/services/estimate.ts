/**
 * What a preparation run is likely to cost, in billed dollars (vendor cost ×
 * markup), from the same price tables and ledger figures charges are made from.
 *
 * The plan (planMedia in a dry run) says what would be generated; this prices
 * each item with the model, quality and limits it would actually be sent with
 * (the account's cost controls applied). Where a vendor's price is only known
 * after the fact (OpenRouter stills, some voices), the recent average is used
 * and the item is given a range.
 */
import { MUSIC_MODELS, OPENROUTER_VOICE_MODELS, isOpenRouterModel } from "../../../shared/audio-models.ts";
import type { BrandKit } from "../../../shared/brand.ts";
import { DEFAULTS } from "../../../shared/brand.ts";
import { CLIP_RESOLUTIONS, type CostControls, capAt } from "../../../shared/controls.ts";
import type { Storyboard } from "../../../shared/storyboard.ts";
import type { Actor } from "../auth/index.ts";
import { elevenLabsCreditProblem } from "../providers/elevenlabs.ts";
import { LYRIA_USD } from "../providers/openrouter.ts";
import { averages } from "./averages.ts";
import { markup } from "./billing.ts";
import { ELEVENLABS, FAL_LIST_USD, OPENROUTER_CLIP_USD_PER_SECOND } from "./pricing.ts";
import { budgetStatus } from "./usage.ts";
import type { PlannedItem } from "./videos.ts";

/** A still's vendor cost before any have been generated here (gpt-image at high quality is about this). */
const FALLBACK_STILL_USD = 0.2;
/** Generated sound effects are short; a few seconds each. */
const SFX_SECONDS = { low: 2, high: 6 };
/** Speech models with no listed price (billed as OpenRouter reports): a broad range. */
const UNPRICED_VOICE_USD_PER_1K = { low: 0.005, high: 0.08 };

export interface CostLine {
	kind: PlannedItem["kind"];
	count: number;
	/** Billed dollars, markup included. */
	usd: number;
	/** Present when the price is only known after the fact. */
	range?: [number, number];
	basis: string;
}

export interface CostEstimate {
	/** Billed dollars for this run, markup included. */
	totalUsd: number;
	/** Low–high, when some prices are only known after the fact. */
	rangeUsd?: [number, number];
	byKind: CostLine[];
	/** Whether the run fits what is left of this month's cap. */
	budget?: { remainingThisMonthUsd: number; fits: boolean };
	/** Vendors known to be unable to take this work right now, with what to do instead. */
	vendorProblems?: string[];
	note: string;
}

const cents = (usd: number) => Math.round(usd * 100) / 100;

export async function estimateCost(
	todo: PlannedItem[],
	context: { brand: BrandKit; storyboard: Storyboard; controls: CostControls; actor?: Actor },
): Promise<CostEstimate> {
	const { brand, storyboard, controls } = context;
	const factor = markup();
	const lines = new Map<PlannedItem["kind"], { count: number; low: number; mid: number; high: number; basis: string }>();
	const add = (kind: PlannedItem["kind"], low: number, mid: number, high: number, basis: string) => {
		const line = lines.get(kind) ?? { count: 0, low: 0, mid: 0, high: 0, basis };
		line.count += 1;
		line.low += low;
		line.mid += mid;
		line.high += high;
		lines.set(kind, line);
	};

	const needsStillAverage = todo.some((item) => item.kind === "image");
	const stillUsd = needsStillAverage ? ((await averages().catch(() => null))?.usdPerStill ?? FALLBACK_STILL_USD) : FALLBACK_STILL_USD;

	const voiceModel = controls.narrationModel ?? brand.narration?.modelId ?? DEFAULTS.voiceModel;
	const imageQuality = capAt(
		["low", "medium", "high", "xhigh", "max"] as const,
		(brand.visual?.imageStyle?.quality ?? "max") as "max",
		controls.imageMaxQuality,
	);
	const vectorPro = brand.visual?.imageStyle?.quality === "max" && controls.vectorPro;
	const clipResolution = capAt(CLIP_RESOLUTIONS, "720p", controls.clipMaxResolution);
	const musicModel = storyboard.music?.model ?? brand.audio?.musicModel;

	for (const item of todo) {
		const units = item.units ?? 0;
		switch (item.kind) {
			case "narration": {
				const perK = isOpenRouterModel(voiceModel)
					? OPENROUTER_VOICE_MODELS.find((model) => model.id === voiceModel)?.usdPer1kCharacters
					: ELEVENLABS.speechUsdPer1kCharacters(voiceModel);
				if (perK === undefined) {
					const low = (units / 1000) * UNPRICED_VOICE_USD_PER_1K.low;
					const high = (units / 1000) * UNPRICED_VOICE_USD_PER_1K.high;
					add("narration", low, (low + high) / 2, high, `${voiceModel}, priced by the vendor per request`);
				} else {
					const usd = (units / 1000) * perK;
					add("narration", usd, usd, usd, `${voiceModel}, $${perK} per 1,000 characters`);
				}
				break;
			}
			case "image": {
				// The average covers every quality; lower qualities cost a fraction of it.
				const low = imageQuality === "max" ? stillUsd * 0.6 : stillUsd * 0.1;
				const high = stillUsd * 1.5;
				add("image", low, imageQuality === "max" ? stillUsd : (low + stillUsd) / 2, high, `average generated still lately (${imageQuality} quality)`);
				break;
			}
			case "vector": {
				const usd = FAL_LIST_USD[vectorPro ? "fal-ai/recraft/v4/pro/text-to-vector" : "fal-ai/recraft/v4/text-to-vector"]!;
				add("vector", usd, usd, usd, vectorPro ? "Recraft v4 pro" : "Recraft v4");
				break;
			}
			case "cutout": {
				const usd = FAL_LIST_USD["fal-ai/birefnet/v2"]!;
				add("cutout", usd, usd, usd, "BiRefNet");
				break;
			}
			case "clip": {
				const perSecond = OPENROUTER_CLIP_USD_PER_SECOND[clipResolution] ?? OPENROUTER_CLIP_USD_PER_SECOND["720p"]!;
				// Length follows the voice, which may not be recorded yet: the plan's seconds are the best guess.
				const seconds = units || 5;
				const usd = seconds * perSecond;
				add("clip", units ? usd : 3 * perSecond, usd, units ? usd : 15 * perSecond, `${clipResolution}, $${perSecond.toFixed(3)} a second`);
				break;
			}
			case "sfx": {
				const per = ELEVENLABS.sfxUsdPerMinute / 60;
				add("sfx", SFX_SECONDS.low * per, ((SFX_SECONDS.low + SFX_SECONDS.high) / 2) * per, SFX_SECONDS.high * per, "ElevenLabs sound effects, by length");
				break;
			}
			case "music": {
				if (musicModel && musicModel !== "elevenlabs") {
					const usd = LYRIA_USD[musicModel] ?? 0.08;
					add("music", usd, usd, usd, MUSIC_MODELS.find((model) => model.id === musicModel)?.label ?? musicModel);
				} else {
					const seconds = Math.min(300, Math.max(10, units || 60));
					const usd = (seconds / 60) * ELEVENLABS.musicUsdPerMinute;
					add("music", usd, usd, usd, `ElevenLabs Music, ${seconds} s at $${ELEVENLABS.musicUsdPerMinute} a minute`);
				}
				break;
			}
			// Stock downloads and icons are free.
			case "stock":
			case "icon":
				add(item.kind, 0, 0, 0, "free");
				break;
		}
	}

	let low = 0;
	let mid = 0;
	let high = 0;
	const byKind: CostLine[] = [];
	for (const [kind, line] of lines) {
		low += line.low;
		mid += line.mid;
		high += line.high;
		const varies = cents(line.high * factor) - cents(line.low * factor) >= 0.01;
		byKind.push({
			kind,
			count: line.count,
			usd: cents(line.mid * factor),
			...(varies ? { range: [cents(line.low * factor), cents(line.high * factor)] as [number, number] } : {}),
			basis: line.basis,
		});
	}
	byKind.sort((a, b) => b.usd - a.usd);
	const totalUsd = cents(mid * factor);
	const highUsd = cents(high * factor);
	const rangeUsd: [number, number] | undefined = highUsd - cents(low * factor) >= 0.01 ? [cents(low * factor), highUsd] : undefined;

	let budget: CostEstimate["budget"];
	if (context.actor && context.actor.billing !== "exempt") {
		const status = await budgetStatus(context.actor).catch(() => null);
		if (status) budget = { remainingThisMonthUsd: status.remainingUsd, fits: highUsd <= status.remainingUsd };
	}

	// ElevenLabs serves its voices, sound effects and the default music model.
	const elevenLabs = todo.filter(
		(item) =>
			(item.kind === "narration" && !isOpenRouterModel(voiceModel)) ||
			item.kind === "sfx" ||
			(item.kind === "music" && (!musicModel || musicModel === "elevenlabs")),
	);
	const vendorProblems: string[] = [];
	if (elevenLabs.length) {
		const problem = await elevenLabsCreditProblem().catch(() => null);
		if (problem) {
			const music = elevenLabs.some((item) => item.kind === "music");
			vendorProblems.push(
				problem +
					(music ? ' For music, switch to a model outside ElevenLabs first: video.update { music: { model: "google/lyria-3-pro-preview" } } (or google/lyria-3-clip-preview).' : "") +
					(elevenLabs.some((item) => item.kind === "narration") ? ' For narration, an OpenRouter voice such as brand.update { narration: { modelId: "hexgrad/kokoro-82m" } }.' : ""),
			);
		}
	}

	return {
		totalUsd,
		...(rangeUsd ? { rangeUsd } : {}),
		byKind,
		...(budget ? { budget } : {}),
		...(vendorProblems.length ? { vendorProblems } : {}),
		note:
			"An estimate in billed dollars (markup included) for this run's generation only. Rendering, previews and drafts are charged by the minute of machine time on top. " +
			"Reused media costs nothing. A range means some prices are only known once the vendor answers.",
	};
}
