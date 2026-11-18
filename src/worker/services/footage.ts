/**
 * Footage: a person's own recordings (a phone video of them talking, a voice
 * memo) turned into material an agent can edit with.
 *
 * Processing (workflows/footage.ts) makes, on a container with real ffmpeg:
 *   - an edit master: H.264, constant 30 fps, upright, SDR, at most 1080p, a
 *     keyframe every second. It replaces the asset's file (phone HEVC, HDR and
 *     variable frame rates do not play reliably in the renderer); the original
 *     is kept beside it.
 *   - a voice track: mono, levelled to -16 LUFS, as its own audio asset. Scenes
 *     that use the footage play their sound from it.
 *   - shot changes and silences,
 * then transcribes the voice track (ElevenLabs Scribe) into word timings,
 * stored on the asset as `meta.words` like narration, so captions, cues and
 * cuts all work from what the person actually said.
 */
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { type Paragraph, fillers, paragraphs, pauses, retakes, stamp, toSrt } from "../../../shared/footage.ts";
import type { Actor } from "../auth/index.ts";
import { db, schema } from "../db/client.ts";
import { AppError } from "../lib/util.ts";
import type { Asset } from "./assets.ts";
import { ELEVENLABS } from "./pricing.ts";
import { assertBudget } from "./usage.ts";

export interface FootageOptions {
	language?: string;
	/** Names and jargon the transcriber should expect. */
	keyterms?: string[];
	/** How many people speak, when known. */
	speakers?: number;
	/** Light noise reduction on the voice track. */
	denoise?: boolean;
}

/** The shape of `asset.meta.footage`. */
export interface FootageMeta {
	status: "processing" | "ready" | "failed";
	stage?: string;
	progress?: number;
	runId?: string;
	startedAt: number;
	finishedAt?: number;
	error?: string;
	options: FootageOptions;
	durationSec?: number;
	hasVideo?: boolean;
	hasAudio?: boolean;
	/** The levelled voice track (an audio asset). */
	audioAssetId?: string;
	/** The file as it was uploaded, kept beside the edit master. */
	originalKey?: string;
	originalBytes?: number;
	originalContentType?: string;
	video?: { width: number; height: number; fps: number; sourceFps: number; variableFrameRate: boolean; rotation: number; hdr: boolean; sourceCodec: string };
	audio?: { sourceLufs: number | null; lufs: number | null; peakDbfs: number | null };
	shots?: number[];
	silences?: [number, number][];
	language?: string;
	transcribed?: boolean;
	/** Why there is no transcript, when transcribing failed. */
	transcriptError?: string;
	warnings?: string[];
}

export const footageOf = (asset: Pick<Asset, "meta">): FootageMeta | undefined => asset.meta.footage as FootageMeta | undefined;

/** The container instance that processes one asset; the name is how its run time is charged (services/metering.ts). */
export const FOOTAGE_PREFIX = "footage-";
export const footageInstance = (assetId: string) => `${FOOTAGE_PREFIX}${assetId}`;

/** Longest recording that can be processed. */
export const MAX_FOOTAGE_SECONDS = 3 * 3600;

/** Rough cost of processing, for the agent: transcription plus container time (about a third of real time). */
export function footageCostUsd(durationSec: number, options: FootageOptions = {}): number {
	const hours = durationSec / 3600;
	const transcription = hours * (ELEVENLABS.transcriptionUsdPerHour + (options.keyterms?.length ? ELEVENLABS.transcriptionKeytermsUsdPerHour : 0));
	return Math.round((transcription + hours * 0.05) * 1000) / 1000;
}

export async function updateFootage(assetId: string, patch: Partial<FootageMeta>, extra: Partial<typeof schema.assets.$inferInsert> = {}): Promise<void> {
	const asset = await db.query.assets.findFirst({ where: eq(schema.assets.id, assetId) });
	if (!asset) return;
	const current = footageOf(asset);
	await db
		.update(schema.assets)
		.set({ ...extra, meta: { ...asset.meta, ...(extra.meta ?? {}), footage: { ...current, ...patch } } })
		.where(eq(schema.assets.id, assetId));
}

/** Starts (or restarts, with new options) processing a video or recording. */
export async function startFootage(asset: Asset, actor: Actor, options: FootageOptions = {}): Promise<FootageMeta> {
	if (asset.kind !== "video" && asset.kind !== "audio") throw new AppError(422, `Only video and audio can be processed as footage; this is a ${asset.kind}`, "unsupported_media");
	if (asset.status !== "ready" || !asset.r2Key) throw new AppError(409, "This asset is not ready yet", "not_ready");
	if ((asset.durationMs ?? 0) > MAX_FOOTAGE_SECONDS * 1000) throw new AppError(422, `Recordings longer than ${MAX_FOOTAGE_SECONDS / 3600} hours cannot be processed`, "too_long");
	const current = footageOf(asset);
	if (current?.status === "processing" && Date.now() - current.startedAt < 2 * 3600 * 1000) return current;
	await assertBudget(actor);
	const runId = `ftg-${asset.id}-${Date.now().toString(36)}`;
	const footage: FootageMeta = {
		...current,
		status: "processing",
		stage: "queued",
		progress: 0,
		runId,
		startedAt: Date.now(),
		finishedAt: undefined,
		error: undefined,
		options,
	};
	await db.update(schema.assets).set({ meta: { ...asset.meta, footage } }).where(eq(schema.assets.id, asset.id));
	await env.FOOTAGE_WORKFLOW.create({ id: runId, params: { assetId: asset.id, runId } });
	return footage;
}

/**
 * Called once an uploaded file is stored. Uploaded video is processed straight
 * away (it usually needs converting before it renders reliably, and it is
 * usually someone talking). Audio is left alone: it is as likely to be music
 * as speech, so footage.process is asked for explicitly.
 */
export async function afterUpload(asset: Asset, actor: Actor): Promise<void> {
	if (asset.kind !== "video" || asset.status !== "ready") return;
	try {
		await startFootage(asset, actor);
	} catch (error) {
		// Never fail an upload over this; footage.process can be run later.
		console.warn("footage processing not started", asset.id, error instanceof Error ? error.message : error);
	}
}

// --- reading footage -------------------------------------------------------------------

type Word = [string, number, number];

const wordsOf = (asset: Asset) => (Array.isArray(asset.meta.words) ? (asset.meta.words as Word[]) : []);
const speakersOf = (asset: Asset) => (Array.isArray(asset.meta.speakers) ? (asset.meta.speakers as string[]) : undefined);

/** Status and a short summary: what an agent needs to decide what to read next. */
export function footageSummary(asset: Asset) {
	const footage = footageOf(asset);
	if (!footage) {
		return {
			assetId: asset.id,
			status: "unprocessed" as const,
			note: asset.kind === "video" || asset.kind === "audio" ? "Not processed yet. footage.process transcribes it and prepares it for editing." : `A ${asset.kind} cannot be used as footage.`,
		};
	}
	const words = wordsOf(asset);
	const speakers = speakersOf(asset);
	return {
		assetId: asset.id,
		name: asset.name,
		status: footage.status,
		...(footage.status === "processing" ? { stage: footage.stage, progress: footage.progress } : {}),
		...(footage.error ? { error: footage.error } : {}),
		durationSec: footage.durationSec,
		hasVideo: footage.hasVideo,
		hasAudio: footage.hasAudio,
		...(footage.video ? { picture: { width: asset.width, height: asset.height, portrait: (asset.height ?? 0) > (asset.width ?? 0), sourceFps: footage.video.sourceFps, hdr: footage.video.hdr } } : {}),
		...(footage.audio ? { loudness: { asRecordedLufs: footage.audio.sourceLufs, levelledToLufs: footage.audio.lufs } } : {}),
		voiceAssetId: footage.audioAssetId,
		...(footage.transcribed
			? {
					transcript: {
						language: footage.language,
						words: words.length,
						speakers: speakers ? new Set(speakers).size : words.length ? 1 : 0,
						paragraphs: paragraphs(words, speakers).length,
						retakes: retakes(words).length,
						fillers: fillers(words).length,
					},
				}
			: {}),
		...(footage.transcriptError
			? { transcriptError: `${footage.transcriptError.replace(/[.\s]+$/, "")}. The footage can still be cut by seconds; footage.process tries again.` }
			: {}),
		shots: footage.shots?.length,
		...(footage.warnings?.length ? { warnings: footage.warnings } : {}),
	};
}

export interface TranscriptRequest {
	format: "paragraphs" | "srt" | "words";
	fromSec?: number;
	toSec?: number;
	search?: string;
	maxParagraphs: number;
}

/** The transcript (or a part of it) in a form an agent can read and quote from, with edit marks. */
export function footageTranscript(asset: Asset, request: TranscriptRequest) {
	const footage = footageOf(asset);
	if (footage?.status !== "ready" || !footage.transcribed) {
		throw new AppError(
			409,
			footage?.status === "processing"
				? "Still processing: try again shortly (footage.get shows progress)"
				: footage?.transcriptError
					? `Transcribing failed: ${footage.transcriptError.replace(/[.\s]+$/, "")}. Run footage.process to try again`
					: "This recording has no transcript yet: run footage.process",
			"not_ready",
		);
	}
	const all = wordsOf(asset);
	const allSpeakers = speakersOf(asset);
	const from = request.fromSec ?? 0;
	const to = request.toSec ?? Number.POSITIVE_INFINITY;
	const keep = all.map((word, i) => [word, i] as const).filter(([[, start]]) => start >= from && start < to);
	const words = keep.map(([word]) => word);
	const speakers = allSpeakers ? keep.map(([, i]) => allSpeakers[i]!) : undefined;
	const base = { assetId: asset.id, durationSec: footage.durationSec, language: footage.language };

	if (request.search) {
		const needle = request.search.toLowerCase().replace(/[^\p{L}\p{N}\s]+/gu, "").trim();
		const text = words.map(([w]) => w.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ""));
		const tokens = needle.split(/\s+/).filter(Boolean);
		const hits: { atSec: number; context: string }[] = [];
		for (let i = 0; i <= text.length - tokens.length && hits.length < 50; i++) {
			if (tokens.every((token, j) => text[i + j]!.startsWith(token) && (j < tokens.length - 1 ? text[i + j] === token : true))) {
				hits.push({ atSec: words[i]![1], context: words.slice(Math.max(0, i - 8), i + tokens.length + 8).map(([w]) => w).join(" ") });
			}
		}
		return { ...base, search: request.search, hits };
	}

	// SRT times stay absolute (seconds into the recording), which is what scenes cut by.
	if (request.format === "srt") return { ...base, srt: toSrt(words) };
	if (request.format === "words") return { ...base, words: words.map(([text, start, end]) => ({ text, start, end })) };

	const ps = paragraphs(words, speakers);
	const shown = ps.slice(0, request.maxParagraphs);
	const marks = {
		retakes: retakes(words).map((r) => ({ ...r, note: `Restarted at ${stamp(r.keepStartSec)}; cut ${stamp(r.dropStartSec)}–${stamp(r.dropEndSec)}` })),
		fillers: fillers(words),
		pauses: pauses(words),
		shots: footage.shots?.filter((sec) => sec >= from && sec < to),
		events: (Array.isArray(asset.meta.events) ? (asset.meta.events as Word[]) : []).filter(([, start]) => start >= from && start < to).map(([text, start]) => ({ atSec: start, text })),
	};
	return {
		...base,
		paragraphs: shown.map((p: Paragraph) => ({ at: `${stamp(p.startSec)}–${stamp(p.endSec)}`, ...p })),
		...(ps.length > shown.length ? { more: { paragraphs: ps.length - shown.length, continueFromSec: ps[shown.length]!.startSec } } : {}),
		marks,
		howToCut: 'Quote the words: a scene with footage { assetId, from: "first words", to: "last words" }. Cuts land in the pauses around them.',
	};
}

/** Frames worth looking at, with what is being said at each: paragraph starts, shot changes or even spacing. */
export function footageFrames(asset: Asset, request: { fromSec?: number; toSec?: number; count: number; by?: "paragraphs" | "shots" | "even"; at?: number[] }): { atSec: number; label: string }[] {
	const footage = footageOf(asset);
	const duration = footage?.durationSec ?? (asset.durationMs ?? 0) / 1000;
	const from = Math.max(0, request.fromSec ?? 0);
	const to = Math.min(duration, request.toSec ?? duration);
	const words = wordsOf(asset);
	const saying = (sec: number) => {
		const i = words.findIndex(([, , end]) => end >= sec);
		if (i < 0 || words[i]![1] - sec > 2) return "";
		return `"${words.slice(i, i + 7).map(([w]) => w).join(" ")}…"`;
	};
	let times: number[];
	if (request.at?.length) times = request.at.filter((sec) => sec >= 0 && sec < duration);
	else {
		const by = request.by ?? (words.length ? "paragraphs" : footage?.shots?.length ? "shots" : "even");
		if (by === "paragraphs" && words.length) {
			// Half a second in: mid-word faces read better than the frame before the first word.
			times = paragraphs(words.filter(([, start]) => start >= from && start < to), speakersOf(asset)).map((p) => Math.min(p.endSec, p.startSec + 0.5));
		} else if (by === "shots" && footage?.shots?.length) {
			times = [from, ...footage.shots.filter((sec) => sec > from && sec < to)].map((sec) => Math.min(to - 0.05, sec + 0.3));
		} else times = [];
		if (times.length > request.count) {
			const step = times.length / request.count;
			times = Array.from({ length: request.count }, (_, i) => times[Math.floor(i * step)]!);
		}
		if (!times.length) times = Array.from({ length: request.count }, (_, i) => from + ((to - from) * (i + 0.5)) / request.count);
	}
	return times.slice(0, request.count).map((sec) => {
		const atSec = Math.round(sec * 10) / 10;
		const said = saying(atSec);
		return { atSec, label: `${stamp(atSec)}${said ? ` ${said}` : ""}` };
	});
}

/** Waits up to `seconds` for processing to finish, then returns the asset as it is. */
export async function waitForFootage(assetId: string, seconds: number): Promise<Asset> {
	const deadline = Date.now() + seconds * 1000;
	for (;;) {
		const asset = await db.query.assets.findFirst({ where: eq(schema.assets.id, assetId) });
		if (!asset) throw new AppError(404, "Asset not found", "not_found");
		if (footageOf(asset)?.status !== "processing" || Date.now() >= deadline) return asset;
		await new Promise((resolve) => setTimeout(resolve, 2000));
	}
}
