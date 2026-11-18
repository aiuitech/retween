/**
 * ElevenLabs: narration (with character-level timestamps), music and sound effects.
 */
import { env } from "cloudflare:workers";
import { AppError, base64ToBytes, upstreamError } from "../lib/util.ts";

const BASE = "https://api.elevenlabs.io";
const OUTPUT_FORMAT = "mp3_44100_128";

const headers = () => ({ "xi-api-key": env.ELEVENLABS_API_KEY, "content-type": "application/json" });

/** What ElevenLabs says about a request's billing, from its response headers. */
export interface Billing {
	/** `request-id` (speech, sound effects) or `song-id` (music). */
	requestId?: string;
	/** `character-cost`: characters billed, where reported. */
	billedCharacters?: number;
}

function billingOf(response: Response): Billing {
	const cost = Number(response.headers.get("character-cost"));
	return {
		requestId: response.headers.get("request-id") ?? response.headers.get("song-id") ?? undefined,
		billedCharacters: Number.isFinite(cost) && response.headers.has("character-cost") ? cost : undefined,
	};
}

export interface SpeechResult extends Billing {
	audio: Uint8Array;
	/** One entry per character of the text that was sent. */
	characters: string[];
	starts: number[];
	ends: number[];
	durationSec: number;
}

export async function synthesizeSpeech(input: {
	text: string;
	voiceId: string;
	modelId: string;
	language?: string;
	settings: { stability?: number; similarity?: number; style?: number; speed?: number; speakerBoost?: boolean };
}): Promise<SpeechResult> {
	const { stability, similarity, style, speed, speakerBoost } = input.settings;
	const voiceSettings = {
		...(stability !== undefined ? { stability } : {}),
		...(similarity !== undefined ? { similarity_boost: similarity } : {}),
		...(style !== undefined ? { style } : {}),
		...(speed !== undefined ? { speed } : {}),
		...(speakerBoost !== undefined ? { use_speaker_boost: speakerBoost } : {}),
	};
	const response = await fetch(
		`${BASE}/v1/text-to-speech/${encodeURIComponent(input.voiceId)}/with-timestamps?output_format=${OUTPUT_FORMAT}`,
		{
			method: "POST",
			headers: headers(),
			body: JSON.stringify({
				text: input.text,
				model_id: input.modelId,
				...(input.language ? { language_code: input.language } : {}),
				...(Object.keys(voiceSettings).length ? { voice_settings: voiceSettings } : {}),
			}),
		},
	);
	if (!response.ok) throw await upstreamError("Voice", response);
	const json = (await response.json()) as {
		audio_base64: string;
		alignment?: {
			characters: string[];
			character_start_times_seconds: number[];
			character_end_times_seconds: number[];
		};
	};
	if (!json.audio_base64) throw new AppError(502, "Voice returned no audio", "upstream_error");
	const alignment = json.alignment;
	const ends = alignment?.character_end_times_seconds ?? [];
	return {
		...billingOf(response),
		audio: base64ToBytes(json.audio_base64),
		characters: alignment?.characters ?? [],
		starts: alignment?.character_start_times_seconds ?? [],
		ends,
		durationSec: ends.length ? Math.max(...ends) : 0,
	};
}

async function audioOrThrow(provider: string, response: Response): Promise<{ audio: Uint8Array } & Billing> {
	if (!response.ok) throw await upstreamError(provider, response);
	return { audio: new Uint8Array(await response.arrayBuffer()), ...billingOf(response) };
}

/** A music bed, 10 s to 5 min. */
export async function composeMusic(input: { prompt: string; seconds: number; instrumental: boolean }) {
	const response = await fetch(`${BASE}/v1/music?output_format=${OUTPUT_FORMAT}`, {
		method: "POST",
		headers: headers(),
		body: JSON.stringify({
			prompt: input.prompt,
			music_length_ms: Math.round(Math.min(300, Math.max(10, input.seconds)) * 1000),
			force_instrumental: input.instrumental,
		}),
	});
	return audioOrThrow("Music", response);
}

/** A sound effect, 0.5–30 s. Omit `seconds` to let the model decide. */
export async function generateSfx(input: { prompt: string; seconds?: number }) {
	const response = await fetch(`${BASE}/v1/sound-generation?output_format=${OUTPUT_FORMAT}`, {
		method: "POST",
		headers: headers(),
		body: JSON.stringify({
			text: input.prompt,
			...(input.seconds ? { duration_seconds: Math.min(30, Math.max(0.5, input.seconds)) } : {}),
		}),
	});
	return audioOrThrow("Sound effect", response);
}

export interface Voice {
	voiceId: string;
	name: string;
	description?: string;
	category?: string;
	labels?: Record<string, string>;
	previewUrl?: string;
}

/** Well-known stock voices, offered when the API key cannot list voices. */
export const FALLBACK_VOICES: Voice[] = [
	{ voiceId: "JBFqnCBsd6RMkjVDRZzb", name: "George", description: "Warm, measured British male. Good default narrator." },
	{ voiceId: "EXAVITQu4vr4xnSDxMaL", name: "Sarah", description: "Clear, confident American female." },
	{ voiceId: "XrExE9yKIg1WjnnlVkGX", name: "Matilda", description: "Friendly, upbeat American female." },
	{ voiceId: "onwK4e9ZLuTAKqWW03F9", name: "Daniel", description: "Authoritative British male, news-reader style." },
	{ voiceId: "pFZP5JQG7iQjIQuC4Bku", name: "Lily", description: "Soft, warm British female." },
	{ voiceId: "nPczCjzI2devNBz1zQrb", name: "Brian", description: "Deep, resonant American male." },
	{ voiceId: "cgSgspJ2msm6clMCkdW9", name: "Jessica", description: "Bright, conversational American female." },
	{ voiceId: "iP95p4xoKVk53GoZ742B", name: "Chris", description: "Casual, natural American male." },
];

export async function listVoices(search?: string): Promise<{ voices: Voice[]; note?: string }> {
	const query = new URLSearchParams({ page_size: "50" });
	if (search) query.set("search", search);
	const response = await fetch(`${BASE}/v2/voices?${query}`, { headers: headers() });
	if (!response.ok) {
		const needle = search?.toLowerCase();
		return {
			voices: needle
				? FALLBACK_VOICES.filter((v) => `${v.name} ${v.description}`.toLowerCase().includes(needle))
				: FALLBACK_VOICES,
			note:
				"The voice library could not be listed (the ElevenLabs API key lacks the voices_read permission), " +
				"so this is a short list of stock voices. Any ElevenLabs voice ID still works for narration.",
		};
	}
	const json = (await response.json()) as {
		voices: { voice_id: string; name: string; description?: string; category?: string; labels?: Record<string, string>; preview_url?: string }[];
	};
	return {
		voices: json.voices.map((v) => ({
			voiceId: v.voice_id,
			name: v.name,
			description: v.description ?? undefined,
			category: v.category,
			labels: v.labels,
			previewUrl: v.preview_url,
		})),
	};
}

// --- speech to text -----------------------------------------------------------------

export const TRANSCRIBE_MODEL = "scribe_v2";

export interface Transcript {
	/** Words with start and end in seconds. */
	words: [word: string, start: number, end: number][];
	/** Who says each word (`speaker_0`, …), parallel to `words`, when there is more than one speaker. */
	speakers?: string[];
	/** Sounds that are not speech, e.g. "(laughter)". */
	events: [text: string, start: number, end: number][];
	language?: string;
	durationSec?: number;
	transcriptionId?: string;
}

/**
 * Transcribes a recording, with word timings and speakers. Send the file, or
 * a link ElevenLabs downloads it from (a signed link to the voice track).
 */
export async function transcribe(input: { file?: Blob; sourceUrl?: string; language?: string; keyterms?: string[]; speakers?: number }): Promise<Transcript> {
	const form = new FormData();
	form.set("model_id", TRANSCRIBE_MODEL);
	if (input.file) form.set("file", input.file, "voice.m4a");
	else if (input.sourceUrl) form.set("source_url", input.sourceUrl);
	else throw new AppError(500, "Nothing to transcribe", "invalid_state");
	form.set("timestamps_granularity", "word");
	form.set("diarize", "true");
	form.set("tag_audio_events", "true");
	if (input.language) form.set("language_code", input.language);
	if (input.speakers) form.set("num_speakers", String(input.speakers));
	for (const term of input.keyterms ?? []) form.append("keyterms", term);
	const response = await fetch(`${BASE}/v1/speech-to-text`, { method: "POST", headers: { "xi-api-key": env.ELEVENLABS_API_KEY }, body: form });
	if (!response.ok) throw await upstreamError("Transcription", response);
	const json = (await response.json()) as {
		language_code?: string;
		audio_duration_secs?: number;
		transcription_id?: string;
		words?: { text: string; type: "word" | "spacing" | "audio_event"; start?: number; end?: number; speaker_id?: string }[];
	};
	const words: Transcript["words"] = [];
	const speakers: string[] = [];
	const events: Transcript["events"] = [];
	const r = (n: number | undefined) => Math.round((n ?? 0) * 1000) / 1000;
	for (const item of json.words ?? []) {
		if (item.type === "word" && item.text.trim()) {
			words.push([item.text.trim(), r(item.start), r(item.end)]);
			speakers.push(item.speaker_id ?? "speaker_0");
		} else if (item.type === "audio_event") {
			events.push([item.text.trim(), r(item.start), r(item.end)]);
		}
	}
	return {
		words,
		speakers: new Set(speakers).size > 1 ? speakers : undefined,
		events,
		language: json.language_code,
		durationSec: json.audio_duration_secs,
		transcriptionId: json.transcription_id ?? response.headers.get("request-id") ?? undefined,
	};
}
