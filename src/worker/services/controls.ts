/**
 * Applies an account's cost controls (shared/controls.ts) to what is about to
 * be generated or rendered.
 */
import { eq } from "drizzle-orm";
import { isOpenRouterModel } from "../../../shared/audio-models.ts";
import { DEFAULTS } from "../../../shared/brand.ts";
import { CLIP_RESOLUTIONS, type CostControls, DEFAULT_CONTROLS, IMAGE_QUALITIES, capAt } from "../../../shared/controls.ts";
import { RESOLUTIONS, type Resolution } from "../../../shared/timeline.ts";
import { db, schema } from "../db/client.ts";
import type { GenerationSpec } from "../db/schema.ts";
import { AppError } from "../lib/util.ts";

export async function getControls(userId: string): Promise<CostControls> {
	const row = await db.query.accountControls.findFirst({ where: eq(schema.accountControls.userId, userId) });
	return { ...DEFAULT_CONTROLS, ...row?.controls };
}

/** Merges a change into the stored controls. A field set to its default is dropped, so later default changes apply. */
export async function updateControls(userId: string, change: Partial<CostControls>): Promise<CostControls> {
	const row = await db.query.accountControls.findFirst({ where: eq(schema.accountControls.userId, userId) });
	const merged: Record<string, unknown> = { ...row?.controls, ...change };
	for (const [key, value] of Object.entries(merged)) {
		if (value === undefined || value === DEFAULT_CONTROLS[key as keyof CostControls]) delete merged[key];
	}
	await db
		.insert(schema.accountControls)
		.values({ userId, controls: merged })
		.onConflictDoUpdate({ target: schema.accountControls.userId, set: { controls: merged, updatedAt: new Date() } });
	return { ...DEFAULT_CONTROLS, ...merged };
}

/** Why a kind of generation is switched off, or undefined when it is allowed. */
export function blockedReason(controls: CostControls, type: GenerationSpec["type"]): string | undefined {
	const off = (what: string) => `${what} are switched off in this account's cost controls`;
	switch (type) {
		case "video":
			return controls.clips ? undefined : off("Generated video clips");
		case "image":
			return controls.images ? undefined : off("Generated images");
		case "vector":
			return controls.vectors ? undefined : off("Vector illustrations");
		case "cutout":
			return controls.cutouts ? undefined : off("Cut-outs");
		case "music":
			return controls.music ? undefined : off("Generated music beds");
		case "sfx":
			return controls.soundEffects ? undefined : off("Generated sound effects");
		default:
			return undefined;
	}
}

/**
 * The spec as it may be sent to the vendor: model, quality, resolution and
 * length brought within the account's limits. Leaves `type` alone.
 */
export function limitSpec<T extends GenerationSpec>(controls: CostControls, spec: T): T {
	switch (spec.type) {
		case "speech":
			if (!controls.narrationModel || controls.narrationModel === spec.modelId) return spec;
			// An OpenRouter voice name means nothing to ElevenLabs: fall back to the default ElevenLabs voice.
			// (The other way round, the OpenRouter model's own default voice is picked when it is generated.)
			return {
				...spec,
				modelId: controls.narrationModel,
				...(isOpenRouterModel(spec.modelId) && !isOpenRouterModel(controls.narrationModel) ? { voiceId: DEFAULTS.voiceId } : {}),
			};
		case "image":
			return { ...spec, quality: capAt(IMAGE_QUALITIES, spec.quality as (typeof IMAGE_QUALITIES)[number], controls.imageMaxQuality) };
		case "vector":
			return controls.vectorPro ? spec : { ...spec, pro: false };
		case "video":
			return {
				...spec,
				seconds: Math.min(spec.seconds, controls.clipMaxSeconds),
				resolution: capAt(CLIP_RESOLUTIONS, spec.resolution as (typeof CLIP_RESOLUTIONS)[number], controls.clipMaxResolution),
			};
		default:
			return spec;
	}
}

/** For direct requests (asset.generate_*): refuses what is switched off, and limits the rest. */
export async function enforceControls<T extends GenerationSpec>(userId: string, spec: T): Promise<T> {
	const controls = await getControls(userId);
	const blocked = blockedReason(controls, spec.type);
	if (blocked) throw new AppError(403, `${blocked}. Change them with account.controls_update.`, "disabled_by_controls");
	return limitSpec(controls, spec);
}

/** The export resolution allowed, with a note when it had to be lowered. */
export function limitResolution(controls: CostControls, resolution: Resolution): { resolution: Resolution; note?: string } {
	const allowed = capAt(RESOLUTIONS, resolution, controls.renderMaxResolution);
	return allowed === resolution
		? { resolution }
		: { resolution: allowed, note: `Rendering at ${allowed} instead of ${resolution}: the account's cost controls cap exports at ${allowed}.` };
}
