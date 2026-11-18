/**
 * Assets: everything a project keeps in R2, plus the code that produces them.
 *
 * Generated assets are created as `pending` rows that carry a generation
 * spec; a workflow then runs `executeGeneration`, which writes the file and
 * flips the row to `ready` (or `failed`, with the reason).
 */
import { env } from "cloudflare:workers";
import { and, eq, inArray, sql } from "drizzle-orm";
import { buildSpokenText, wordTimings } from "../../../shared/narration.ts";
import type { Actor } from "../auth/index.ts";
import { db, schema } from "../db/client.ts";
import type { AssetKind, AssetLicense, AssetMeta, AssetSource, GenerationSpec } from "../db/schema.ts";
import { AppError, badRequest, bytesToBase64, newId, notFound } from "../lib/util.ts";
import { composeMusic, generateSfx, synthesizeSpeech } from "../providers/elevenlabs.ts";
import { type FalCharge, generateVector, removeBackground } from "../providers/fal.ts";
import { IMAGE_MODEL, generateImage } from "../providers/openrouter.ts";
import { MAX_LOTTIE_BYTES, lottieInfo, probeObject } from "./probe.ts";
import { type Project, getProject } from "./projects.ts";
import { assetKey, contentTypeFor, extensionFor, kindFor, readObject, signedUrl } from "./storage.ts";
import { ELEVENLABS } from "./pricing.ts";
import { recordUsage } from "./usage.ts";

export type Asset = typeof schema.assets.$inferSelect;

const MAX_IMPORT_BYTES = 500 * 1024 * 1024;
const MAX_BUFFERED_IMPORT_BYTES = 100 * 1024 * 1024;
const MAX_REFERENCE_BYTES = 12 * 1024 * 1024;

export async function getAsset(actor: Actor, assetId: string): Promise<{ asset: Asset; project: Project }> {
	const asset = await db.query.assets.findFirst({ where: eq(schema.assets.id, assetId) });
	if (!asset) throw notFound("Asset");
	const project = await getProject(actor, asset.projectId).catch(() => {
		throw notFound("Asset");
	});
	return { asset, project };
}

/** Assets by id within one project; ids that do not exist are simply absent. */
export async function assetsById(projectId: string, ids: string[]): Promise<Map<string, Asset>> {
	const unique = [...new Set(ids)].filter(Boolean);
	if (!unique.length) return new Map();
	const rows: Asset[] = [];
	for (let i = 0; i < unique.length; i += 50) {
		rows.push(
			...(await db.query.assets.findMany({
				where: and(eq(schema.assets.projectId, projectId), inArray(schema.assets.id, unique.slice(i, i + 50))),
			})),
		);
	}
	return new Map(rows.map((row) => [row.id, row]));
}

/** The shape of an asset in API responses. */
export async function assetView(asset: Asset, options: { url?: boolean } = {}) {
	const url = options.url !== false && asset.status === "ready" && asset.r2Key ? await signedUrl(asset.r2Key, { expiresIn: 6 * 3600 }) : undefined;
	return {
		id: asset.id,
		projectId: asset.projectId,
		kind: asset.kind,
		name: asset.name,
		description: asset.description ?? undefined,
		tags: asset.tags,
		status: asset.status,
		source: asset.source,
		contentType: asset.contentType ?? undefined,
		bytes: asset.bytes ?? undefined,
		width: asset.width ?? undefined,
		height: asset.height ?? undefined,
		durationSec: asset.durationMs != null ? asset.durationMs / 1000 : undefined,
		prompt: asset.meta.prompt,
		model: asset.meta.model,
		license: asset.license ?? undefined,
		error: asset.error ?? undefined,
		footage: footageBrief(asset),
		url,
		createdAt: asset.createdAt,
	};
}

/** One line on a recording's processing, for asset listings (footage.get has the detail). */
function footageBrief(asset: Asset) {
	const footage = asset.meta.footage as { status: string; stage?: string; transcribed?: boolean; error?: string } | undefined;
	if (!footage) return undefined;
	const words = Array.isArray(asset.meta.words) ? asset.meta.words.length : 0;
	return {
		status: footage.status,
		...(footage.status === "processing" && footage.stage ? { stage: footage.stage } : {}),
		...(footage.transcribed ? { transcriptWords: words } : {}),
		...(footage.error ? { error: footage.error } : {}),
	};
}

export async function createAsset(values: {
	projectId: string;
	createdBy: string;
	kind: AssetKind;
	name: string;
	source: AssetSource;
	description?: string;
	tags?: string[];
	meta?: AssetMeta;
	license?: AssetLicense;
	generation?: GenerationSpec;
}): Promise<Asset> {
	const [asset] = await db
		.insert(schema.assets)
		.values({
			id: newId("ast"),
			projectId: values.projectId,
			createdBy: values.createdBy,
			kind: values.kind,
			name: values.name.slice(0, 200),
			description: values.description,
			tags: values.tags ?? [],
			status: "pending",
			source: values.source,
			meta: values.meta ?? {},
			license: values.license,
			generation: values.generation,
		})
		.returning();
	return asset!;
}

/** Writes the file for an asset, measures it, and marks the asset ready. */
export async function storeAsset(
	asset: Asset,
	body: Uint8Array | ReadableStream,
	contentType: string,
	extra: { meta?: AssetMeta; durationMs?: number } = {},
): Promise<Asset> {
	if (kindFor(contentType) === "animation") {
		// JSON is only accepted as a Lottie animation, so read it whole and check before keeping it.
		const bytes = body instanceof Uint8Array ? body : await readCapped(body, MAX_LOTTIE_BYTES, "A Lottie file larger than 20 MB");
		if (!lottieInfo(bytes)) {
			throw new AppError(422, "This JSON file is not a Lottie animation (Bodymovin JSON with w, h, fr, ip, op and layers)", "unsupported_media");
		}
		body = bytes;
		contentType = "application/json";
	}
	const key = assetKey(asset.projectId, asset.id, extensionFor(contentType, asset.name));
	const stored = await env.MEDIA.put(key, body, { httpMetadata: { contentType } });
	return finishStoredObject(asset, key, contentType, stored.size, extra);
}

/** Measures a file already written to `key` and marks its asset ready. */
export async function finishStoredObject(
	asset: Asset,
	key: string,
	contentType: string,
	size: number,
	extra: { meta?: AssetMeta; durationMs?: number } = {},
): Promise<Asset> {
	const info = await probeObject(key, contentType, size);
	const kind = asset.kind === "other" ? kindFor(contentType) : asset.kind;
	const [updated] = await db
		.update(schema.assets)
		.set({
			status: "ready",
			kind,
			r2Key: key,
			contentType,
			bytes: size,
			width: info.width,
			height: info.height,
			durationMs: info.durationMs ?? extra.durationMs,
			meta: { ...asset.meta, ...extra.meta },
			generation: null,
			error: null,
		})
		.where(eq(schema.assets.id, asset.id))
		.returning();
	return updated!;
}

/** Reads a stream into memory, refusing to go past `limit` bytes. */
async function readCapped(stream: ReadableStream, limit: number, what: string): Promise<Uint8Array> {
	const chunks: Uint8Array[] = [];
	let total = 0;
	for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
		total += chunk.byteLength;
		if (total > limit) throw new AppError(413, `${what} is too large`, "too_large");
		chunks.push(chunk);
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

export async function failAsset(assetId: string, message: string): Promise<void> {
	await db.update(schema.assets).set({ status: "failed", error: message.slice(0, 1000) }).where(eq(schema.assets.id, assetId));
}

/**
 * Leaves out media generated for individual scenes (tagged "auto"): narration,
 * scene visuals and the like. The Files tab and asset.list hide them by default,
 * so counts use the same rule.
 */
export const notSceneMedia = () => sql`not exists (select 1 from json_each(${schema.assets.tags}) where value = 'auto')`;

export async function deleteAsset(asset: Asset): Promise<void> {
	if (asset.r2Key) await env.MEDIA.delete(asset.r2Key);
	// Processed footage: the upload kept beside the edit master, and its voice track.
	const footage = asset.meta.footage as { originalKey?: string; audioAssetId?: string } | undefined;
	if (footage?.originalKey && footage.originalKey !== asset.r2Key) await env.MEDIA.delete(footage.originalKey);
	if (footage?.audioAssetId) {
		const voice = await db.query.assets.findFirst({ where: eq(schema.assets.id, footage.audioAssetId) });
		if (voice) await deleteAsset(voice);
	}
	await db.delete(schema.assets).where(eq(schema.assets.id, asset.id));
}

/** An image asset inlined as a data URL, for use as a model reference. */
export async function assetDataUrl(asset: Asset): Promise<string | null> {
	if (asset.status !== "ready" || !asset.r2Key || asset.kind !== "image") return null;
	if ((asset.bytes ?? 0) > MAX_REFERENCE_BYTES) return null;
	const { bytes, contentType } = await readObject(asset.r2Key);
	return `data:${contentType};base64,${bytesToBase64(bytes)}`;
}

/** Downloads a URL into an asset. Streams when the size is known. */
export async function importUrl(asset: Asset, url: string, headers: Record<string, string> = {}): Promise<Asset> {
	const target = new URL(url);
	if (target.protocol !== "https:" && target.protocol !== "http:") throw badRequest("Only http(s) URLs can be imported");
	const response = await fetch(target, { headers: { "user-agent": env.OUTBOUND_USER_AGENT, ...headers }, redirect: "follow" });
	if (!response.ok || !response.body) {
		throw new AppError(422, `Could not download ${target.hostname} (${response.status})`, "import_failed");
	}
	const contentType = contentTypeFor(response.headers.get("content-type"), target.pathname);
	if (kindFor(contentType) === "other") {
		const hint = /\.lottie$/i.test(target.pathname) ? " dotLottie (.lottie) files are not supported: import the Lottie JSON instead." : "";
		throw new AppError(422, `Unsupported file type "${contentType}". Import images, video, audio, fonts or Lottie JSON.${hint}`, "unsupported_media");
	}
	const length = Number(response.headers.get("content-length"));
	if (Number.isFinite(length) && length > 0) {
		if (length > MAX_IMPORT_BYTES) throw new AppError(413, "File is larger than 500 MB", "too_large");
		return storeAsset(asset, response.body, contentType);
	}
	// Unknown length: R2 needs a sized body, so buffer (with a cap).
	const bytes = await readCapped(response.body, MAX_BUFFERED_IMPORT_BYTES, "A file without a known size over 100 MB");
	return storeAsset(asset, bytes, contentType);
}

/**
 * Produces the file for a pending asset. Video clips are not handled here:
 * they need to wait on a remote job, which the asset workflow does in steps.
 */
export async function executeGeneration(assetId: string): Promise<Asset> {
	const asset = await db.query.assets.findFirst({ where: eq(schema.assets.id, assetId) });
	if (!asset) throw notFound("Asset");
	if (asset.status === "ready") return asset;
	const spec = asset.generation;
	if (!spec) throw new AppError(409, "Asset has nothing to generate", "invalid_state");
	// Each charge is recorded as soon as the vendor answers, before storing, so a retry after a storage
	// failure (which calls the vendor again) is charged for both calls, as the vendor charges us.
	const usage = { userId: asset.createdBy, projectId: asset.projectId, ref: asset.id };
	const falUsage = (model: string, charge: FalCharge) =>
		recordUsage({
			...usage,
			kind: "image",
			provider: "fal",
			model,
			quantity: charge.billableUnits ?? 1,
			unit: charge.unit ?? "images",
			costUsd: charge.costUsd,
			basis: charge.basis,
			vendorRef: charge.requestId,
			dedupeKey: charge.requestId && `fal:${charge.requestId}`,
		});

	switch (spec.type) {
		case "speech": {
			const spoken = buildSpokenText(spec.text, spec.pronunciations);
			const result = await synthesizeSpeech({
				text: spoken.spoken,
				voiceId: spec.voiceId,
				modelId: spec.modelId,
				language: spec.language,
				settings: spec.settings,
			});
			// Billed per character sent; ElevenLabs' own count is used when it reports one.
			const characters = result.billedCharacters ?? spoken.spoken.length;
			await recordUsage({
				...usage,
				kind: "speech",
				provider: "elevenlabs",
				model: spec.modelId,
				quantity: characters,
				unit: "characters",
				costUsd: (characters / 1000) * ELEVENLABS.speechUsdPer1kCharacters(spec.modelId),
				basis: "metered",
				vendorRef: result.requestId,
				dedupeKey: result.requestId && `elevenlabs:${result.requestId}`,
			});
			const words = wordTimings(spec.text, spoken, { characters: result.characters, starts: result.starts, ends: result.ends });
			return storeAsset(asset, result.audio, "audio/mpeg", {
				meta: { words, spokenText: spoken.spoken, voiceId: spec.voiceId, model: spec.modelId, provider: "elevenlabs" },
				durationMs: Math.round(result.durationSec * 1000),
			});
		}
		case "image": {
			const references = await assetsById(asset.projectId, spec.referenceAssetIds);
			const referenceUrls: string[] = [];
			for (const id of spec.referenceAssetIds) {
				const reference = references.get(id);
				const url = reference && (await assetDataUrl(reference));
				if (url) referenceUrls.push(url);
			}
			const image = await generateImage({
				prompt: spec.prompt,
				aspectRatio: spec.aspectRatio,
				quality: spec.quality,
				references: referenceUrls,
				transparent: spec.transparent,
				model: spec.model,
			});
			if (image.costUsd === undefined) console.warn("OpenRouter reported no cost for an image", image.model, asset.id);
			await recordUsage({
				...usage,
				kind: "image",
				provider: "openrouter",
				model: image.model,
				quantity: 1,
				unit: "images",
				costUsd: image.costUsd ?? 0,
				// Unpriced rows are kept as `list` so they show up as estimates and can be corrected.
				basis: image.costUsd === undefined ? "list" : "vendor",
			});
			return storeAsset(asset, image.bytes, image.contentType, { meta: { model: image.model, provider: "openrouter" } });
		}
		case "music": {
			const music = await composeMusic(spec);
			// The length asked for is the length billed (the API clamps it to 10 s–5 min).
			const seconds = Math.min(300, Math.max(10, spec.seconds));
			await recordUsage({
				...usage,
				kind: "music",
				provider: "elevenlabs",
				model: "music",
				quantity: seconds,
				unit: "seconds",
				costUsd: (seconds / 60) * ELEVENLABS.musicUsdPerMinute,
				basis: "metered",
				vendorRef: music.requestId,
				dedupeKey: music.requestId && `elevenlabs:${music.requestId}`,
			});
			return storeAsset(asset, music.audio, "audio/mpeg", {
				meta: { provider: "elevenlabs", model: "music" },
				durationMs: Math.round(spec.seconds * 1000),
			});
		}
		case "sfx": {
			const sfx = await generateSfx(spec);
			const stored = await storeAsset(asset, sfx.audio, "audio/mpeg", { meta: { provider: "elevenlabs", model: "sound-effects" } });
			// Charged on the measured length, so this one is recorded after storing (which measures it).
			// A retry pays again for the clip, and that charge is lost; sound effects cost a cent or two.
			const seconds = (stored.durationMs ?? (spec.seconds ?? 3) * 1000) / 1000;
			await recordUsage({
				...usage,
				kind: "sfx",
				provider: "elevenlabs",
				model: "sound-effects",
				quantity: seconds,
				unit: "seconds",
				costUsd: (seconds / 60) * ELEVENLABS.sfxUsdPerMinute,
				basis: "list",
				vendorRef: sfx.requestId,
				dedupeKey: sfx.requestId && `elevenlabs:${sfx.requestId}`,
			});
			return stored;
		}
		case "vector": {
			const vector = await generateVector(spec);
			await falUsage(vector.model, vector.charge);
			const { bytes, contentType } = await download(vector.url, "The vector illustration");
			return storeAsset(asset, bytes, contentType.includes("svg") ? "image/svg+xml" : contentType, {
				meta: { model: vector.model, provider: "fal" },
			});
		}
		case "cutout": {
			const source = (await assetsById(asset.projectId, [spec.sourceAssetId])).get(spec.sourceAssetId);
			if (source?.status !== "ready" || source.kind !== "image" || !source.r2Key) {
				throw new AppError(422, "The picture to cut out is missing or is not a still image", "invalid_state");
			}
			// Inline when small enough; otherwise a short-lived link the provider downloads from.
			const image = (await assetDataUrl(source)) ?? (await signedUrl(source.r2Key, { expiresIn: 3600 }));
			const cutout = await removeBackground(image);
			await falUsage(cutout.model, cutout.charge);
			const { bytes } = await download(cutout.url, "The cut-out");
			return storeAsset(asset, bytes, "image/png", { meta: { model: cutout.model, provider: "fal", sourceAssetId: source.id } });
		}
		case "url":
			return importUrl(asset, spec.url, spec.headers);
		case "video":
			throw new AppError(500, "Video clips are generated by the asset workflow", "invalid_state");
	}
}

/** Fetches a generated file from a provider's CDN. */
async function download(url: string, what: string): Promise<{ bytes: Uint8Array; contentType: string }> {
	const response = await fetch(url, { headers: { "user-agent": env.OUTBOUND_USER_AGENT } });
	if (!response.ok) throw new AppError(502, `${what} could not be downloaded (${response.status})`, "upstream_error");
	return { bytes: new Uint8Array(await response.arrayBuffer()), contentType: contentTypeFor(response.headers.get("content-type"), new URL(url).pathname) };
}

/** Starts the background workflow that fills in a pending asset. */
export async function startGeneration(asset: Pick<Asset, "id">): Promise<void> {
	try {
		// One workflow per asset, keyed by its id, so a retried caller cannot start a second one.
		await env.ASSET_WORKFLOW.create({ id: asset.id, params: { assetId: asset.id } });
	} catch (error) {
		if (!/already exists|duplicate/i.test(error instanceof Error ? error.message : "")) throw error;
	}
}

/** Polls until none of the assets is pending, or the time runs out. */
export async function waitForAssets(assetIds: string[], seconds: number): Promise<Asset[]> {
	const deadline = Date.now() + seconds * 1000;
	for (;;) {
		const rows = assetIds.length ? await db.query.assets.findMany({ where: inArray(schema.assets.id, assetIds) }) : [];
		if (rows.every((row) => row.status !== "pending") || Date.now() >= deadline) {
			return assetIds.map((id) => rows.find((row) => row.id === id)).filter((row): row is Asset => Boolean(row));
		}
		await new Promise((resolve) => setTimeout(resolve, 1500));
	}
}

export const DEFAULT_IMAGE_MODEL = IMAGE_MODEL;
