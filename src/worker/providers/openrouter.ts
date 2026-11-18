/**
 * OpenRouter: still images, short video clips, narration, transcription and music.
 * Images use the synchronous /images endpoint; video is a submit-then-poll job;
 * speech and transcription have their own audio endpoints; music comes from
 * Lyria through streamed chat completions.
 */
import { env } from "cloudflare:workers";
import { OPENROUTER_VOICE_MODELS } from "../../../shared/audio-models.ts";
import { AppError, base64ToBytes, isRateLimited, upstreamError, withRetry } from "../lib/util.ts";
import { musicTimeout } from "./elevenlabs.ts";

const BASE = "https://openrouter.ai/api/v1";

/** Detail-first image model. Used at `max` quality unless the brand kit says otherwise. */
export const IMAGE_MODEL = "openai/gpt-image-2.6-sunburst";
/** Fast clip model. Clips are 3–15 s, 16:9 or 9:16 only. */
export const VIDEO_MODEL = "google/gemini-omni-1.2-flash";

export const IMAGE_ASPECTS = ["1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16", "21:9", "4:5", "5:4"] as const;
export const VIDEO_ASPECTS = ["16:9", "9:16"] as const;
export const VIDEO_RESOLUTIONS = ["360p", "720p", "1080p"] as const;

const headers = () => ({
	authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
	"content-type": "application/json",
});

export interface GeneratedImage {
	bytes: Uint8Array;
	contentType: string;
	/** USD as reported by OpenRouter. Missing when it did not report one. */
	costUsd?: number;
	model: string;
}

export async function generateImage(input: {
	prompt: string;
	aspectRatio: string;
	quality: string;
	/** Reference images as data URLs or https URLs. */
	references: string[];
	transparent?: boolean;
	model?: string;
}): Promise<GeneratedImage> {
	const model = input.model ?? IMAGE_MODEL;
	const response = await fetch(`${BASE}/images`, {
		method: "POST",
		headers: headers(),
		body: JSON.stringify({
			model,
			prompt: input.prompt,
			n: 1,
			quality: input.quality,
			aspect_ratio: input.aspectRatio,
			// PNG keeps an alpha channel; WebP keeps opaque frames small for the renderer.
			output_format: input.transparent ? "png" : "webp",
			...(input.transparent ? { background: "transparent" } : { output_compression: 92 }),
			...(input.references.length
				? { input_references: input.references.map((url) => ({ type: "image_url", image_url: { url } })) }
				: {}),
		}),
	});
	if (!response.ok) throw await upstreamError("Image generation", response);
	const json = (await response.json()) as {
		data?: { b64_json?: string; media_type?: string }[];
		usage?: { cost?: number };
	};
	const image = json.data?.[0];
	if (!image?.b64_json) throw new AppError(502, "Image generation returned no image", "upstream_error");
	return {
		bytes: base64ToBytes(image.b64_json),
		contentType: image.media_type ?? (input.transparent ? "image/png" : "image/webp"),
		costUsd: json.usage?.cost,
		model,
	};
}

export interface VideoJob {
	id: string;
	status: "pending" | "in_progress" | "completed" | "failed" | "cancelled" | "expired";
	error?: string;
	costUsd?: number;
	/** OpenRouter's generation id, for looking the charge up later. */
	generationId?: string;
}

export async function submitVideo(input: {
	prompt: string;
	seconds: number;
	aspectRatio: string;
	resolution: string;
	withAudio: boolean;
	/** First frame as a data URL or https URL. */
	firstFrame?: string;
	model?: string;
}): Promise<VideoJob> {
	const response = await fetch(`${BASE}/videos`, {
		method: "POST",
		headers: headers(),
		body: JSON.stringify({
			model: input.model ?? VIDEO_MODEL,
			prompt: input.prompt,
			duration: Math.round(input.seconds),
			aspect_ratio: input.aspectRatio,
			resolution: input.resolution,
			// Some clip models always produce sound and reject an explicit `false`, so the flag is only
			// sent when sound is wanted. An unwanted soundtrack is muted at compose time.
			...(input.withAudio ? { generate_audio: true } : {}),
			...(input.firstFrame
				? { frame_images: [{ type: "image_url", image_url: { url: input.firstFrame }, frame_type: "first_frame" }] }
				: {}),
		}),
	});
	if (!response.ok) throw await upstreamError("Video generation", response);
	const json = (await response.json()) as { id: string; status: VideoJob["status"] };
	return { id: json.id, status: json.status };
}

export async function getVideoJob(jobId: string): Promise<VideoJob> {
	const response = await fetch(`${BASE}/videos/${encodeURIComponent(jobId)}`, { headers: headers() });
	if (!response.ok) throw await upstreamError("Video generation", response);
	const json = (await response.json()) as {
		id: string;
		status: VideoJob["status"];
		error?: string | { message?: string };
		usage?: { cost?: number };
		generation_id?: string;
	};
	return {
		id: json.id,
		generationId: json.generation_id,
		status: json.status,
		error: typeof json.error === "string" ? json.error : json.error?.message,
		costUsd: json.usage?.cost,
	};
}

/** The finished clip as a stream with a known length. */
export async function downloadVideo(jobId: string): Promise<Response> {
	const response = await fetch(`${BASE}/videos/${encodeURIComponent(jobId)}/content?index=0`, {
		headers: { authorization: `Bearer ${env.OPENROUTER_API_KEY}` },
	});
	if (!response.ok) throw await upstreamError("Video download", response);
	return response;
}

// --- audio ---------------------------------------------------------------------------

/** Rate limits and provider hiccups on OpenRouter's audio routes clear quickly; try a few times. */
async function audioCall(provider: string, url: string, init: RequestInit): Promise<Response> {
	return withRetry(
		async () => {
			const response = await fetch(url, init);
			if (!response.ok) throw await upstreamError(provider, response);
			return response;
		},
		{ attempts: 5, baseDelayMs: 2_000, maxDelayMs: 20_000, retryIf: isRateLimited },
	);
}

export interface SpeechModelInfo {
	id: string;
	name: string;
	description?: string;
	/** USD per character of input, when the model is priced that way. */
	usdPerCharacter?: number;
	voices: string[];
}

let speechCatalog: { at: number; models: SpeechModelInfo[] } | undefined;

/** OpenRouter's speech models with their voices and prices (cached for an hour per isolate). */
export async function speechModels(): Promise<SpeechModelInfo[]> {
	if (speechCatalog && Date.now() - speechCatalog.at < 3600_000) return speechCatalog.models;
	const response = await fetch(`${BASE}/models?output_modalities=speech`, { headers: { authorization: `Bearer ${env.OPENROUTER_API_KEY}` } });
	if (!response.ok) throw await upstreamError("OpenRouter models", response);
	const json = (await response.json()) as {
		data: { id: string; name: string; description?: string; pricing?: { prompt?: string; completion?: string }; supported_voices?: string[] | null }[];
	};
	const models = json.data.map((model) => {
		const prompt = Number(model.pricing?.prompt);
		const completion = Number(model.pricing?.completion);
		return {
			id: model.id,
			name: model.name,
			description: model.description,
			// Character-priced models charge nothing per output token; token-priced ones are left unpriced here.
			usdPerCharacter: Number.isFinite(prompt) && completion === 0 ? prompt : undefined,
			voices: model.supported_voices ?? [],
		};
	});
	speechCatalog = { at: Date.now(), models };
	return models;
}

/** The voice to use with a model: the one asked for if the model has it, else the model's usual default. */
export async function voiceFor(modelId: string, voiceId: string): Promise<{ voice: string; substituted: boolean }> {
	const model = (await speechModels().catch(() => [])).find((candidate) => candidate.id === modelId);
	if (!model?.voices.length || model.voices.includes(voiceId)) return { voice: voiceId, substituted: false };
	const lower = model.voices.find((voice) => voice.toLowerCase() === voiceId.toLowerCase());
	if (lower) return { voice: lower, substituted: false };
	const preferred = OPENROUTER_VOICE_MODELS.find((candidate) => candidate.id === modelId)?.defaultVoice;
	return { voice: preferred && model.voices.includes(preferred) ? preferred : model.voices[0]!, substituted: true };
}

/** 16-bit little-endian PCM wrapped in a WAV header, so it can be stored and played. */
function pcmToWav(pcm: Uint8Array, sampleRate: number, channels: number): Uint8Array {
	const header = new DataView(new ArrayBuffer(44));
	const text = (offset: number, value: string) => [...value].forEach((char, i) => header.setUint8(offset + i, char.charCodeAt(0)));
	text(0, "RIFF");
	header.setUint32(4, 36 + pcm.byteLength, true);
	text(8, "WAVE");
	text(12, "fmt ");
	header.setUint32(16, 16, true);
	header.setUint16(20, 1, true);
	header.setUint16(22, channels, true);
	header.setUint32(24, sampleRate, true);
	header.setUint32(28, sampleRate * channels * 2, true);
	header.setUint16(32, channels * 2, true);
	header.setUint16(34, 16, true);
	text(36, "data");
	header.setUint32(40, pcm.byteLength, true);
	const out = new Uint8Array(44 + pcm.byteLength);
	out.set(new Uint8Array(header.buffer), 0);
	out.set(pcm, 44);
	return out;
}

export interface OpenRouterSpeech {
	audio: Uint8Array;
	contentType: "audio/mpeg" | "audio/wav";
	generationId?: string;
}

/**
 * Narration from an OpenRouter speech model. MP3 is asked for; models that only
 * return raw PCM (Gemini, HeyGen) are asked again for PCM, which is wrapped as WAV.
 */
export async function synthesizeSpeechOpenRouter(input: { text: string; model: string; voice: string; speed?: number; instructions?: string }): Promise<OpenRouterSpeech> {
	const request = (format: "mp3" | "pcm") =>
		audioCall("Voice", `${BASE}/audio/speech`, {
			method: "POST",
			headers: headers(),
			body: JSON.stringify({
				model: input.model,
				input: input.text,
				voice: input.voice,
				response_format: format,
				...(input.speed !== undefined && input.speed !== 1 ? { speed: input.speed } : {}),
				...(input.instructions ? { instructions: input.instructions } : {}),
			}),
		});
	let response: Response;
	try {
		response = await request("mp3");
	} catch (error) {
		if (!(error instanceof AppError && /pcm/i.test(error.message))) throw error;
		response = await request("pcm");
	}
	const bytes = new Uint8Array(await response.arrayBuffer());
	if (bytes.byteLength < 512) throw new AppError(502, "Voice returned no audio", "upstream_error");
	const generationId = response.headers.get("x-generation-id") ?? undefined;
	const type = response.headers.get("content-type") ?? "";
	if (/pcm/i.test(type)) {
		const rate = Number(/rate=(\d+)/.exec(type)?.[1] ?? 24000);
		const channels = Number(/channels=(\d+)/.exec(type)?.[1] ?? 1);
		return { audio: pcmToWav(bytes, rate, channels), contentType: "audio/wav", generationId };
	}
	return { audio: bytes, contentType: "audio/mpeg", generationId };
}

/** Cheap and quick, with word timestamps: used to time narration from voices that report none. */
export const TIMING_MODEL = "openai/whisper-large-v3-turbo";

/** Word timestamps of a recording, in seconds. */
export async function transcribeWords(input: { audio: Uint8Array; contentType: string; language?: string }) {
	const form = new FormData();
	form.set("file", new Blob([input.audio as Uint8Array<ArrayBuffer>], { type: input.contentType }), input.contentType === "audio/wav" ? "voice.wav" : "voice.mp3");
	form.set("model", TIMING_MODEL);
	form.set("response_format", "verbose_json");
	form.append("timestamp_granularities[]", "word");
	if (input.language) form.set("language", input.language);
	const response = await audioCall("Narration timing", `${BASE}/audio/transcriptions`, {
		method: "POST",
		headers: { authorization: `Bearer ${env.OPENROUTER_API_KEY}` },
		body: form,
	});
	const json = (await response.json()) as {
		duration?: number;
		words?: { word: string; start: number; end: number }[];
		usage?: { cost?: number; seconds?: number };
	};
	return {
		words: (json.words ?? []).map((word) => ({ word: word.word.trim(), start: word.start, end: word.end })).filter((word) => word.word),
		durationSec: json.duration,
		costUsd: json.usage?.cost,
		seconds: json.usage?.seconds ?? json.duration,
		generationId: response.headers.get("x-generation-id") ?? undefined,
	};
}

/**
 * What OpenRouter charged for a generation. The figure appears a moment after
 * the request, so this asks a few times; undefined when it is not there yet.
 */
export async function generationCost(generationId: string): Promise<number | undefined> {
	for (let attempt = 0; attempt < 4; attempt++) {
		if (attempt) await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
		const response = await fetch(`${BASE}/generation?id=${encodeURIComponent(generationId)}`, { headers: { authorization: `Bearer ${env.OPENROUTER_API_KEY}` } }).catch(() => null);
		if (!response?.ok) continue;
		const json = (await response.json().catch(() => null)) as { data?: { usage?: number; total_cost?: number } } | null;
		const cost = json?.data?.total_cost ?? json?.data?.usage;
		if (typeof cost === "number") return cost;
	}
	return undefined;
}

/** Lyria list prices, used if a stream ends without reporting its cost. */
export const LYRIA_USD: Record<string, number> = { "google/lyria-3-pro-preview": 0.08, "google/lyria-3-clip-preview": 0.04 };

/**
 * A piece of music from Lyria. Audio output only comes streamed: the base64
 * audio arrives in `delta.audio.data` chunks and the cost in the last chunk.
 * Clip makes 30 s; Pro makes a full piece whose length follows the prompt.
 */
export async function composeMusicOpenRouter(input: { prompt: string; seconds: number; instrumental: boolean; model: string }) {
	return musicTimeout(() => lyria(input));
}

async function lyria(input: { prompt: string; seconds: number; instrumental: boolean; model: string }) {
	const length = input.model.includes("clip") ? "" : ` Make it about ${Math.round(input.seconds)} seconds long.`;
	const vocals = input.instrumental ? " Instrumental only, no vocals." : "";
	const response = await audioCall("Music", `${BASE}/chat/completions`, {
		method: "POST",
		headers: headers(),
		body: JSON.stringify({
			model: input.model,
			messages: [{ role: "user", content: `${input.prompt.trim()}${length}${vocals} A music bed to sit under narration.` }],
			modalities: ["text", "audio"],
			audio: { format: "mp3" },
			stream: true,
		}),
		signal: AbortSignal.timeout(9 * 60_000),
	});
	const generationId = response.headers.get("x-generation-id") ?? undefined;
	const decoder = new TextDecoder();
	let buffer = "";
	let base64 = "";
	let costUsd: number | undefined;
	let error: string | undefined;
	const take = (line: string) => {
		if (!line.startsWith("data:")) return;
		const data = line.slice(5).trim();
		if (!data || data === "[DONE]") return;
		const chunk = JSON.parse(data) as {
			error?: { message?: string };
			choices?: { delta?: { audio?: { data?: string } } }[];
			usage?: { cost?: number };
		};
		if (chunk.error) error = chunk.error.message ?? "Music generation failed";
		base64 += chunk.choices?.[0]?.delta?.audio?.data ?? "";
		if (typeof chunk.usage?.cost === "number") costUsd = chunk.usage.cost;
	};
	for await (const part of response.body as unknown as AsyncIterable<Uint8Array>) {
		buffer += decoder.decode(part, { stream: true });
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";
		for (const line of lines) take(line);
	}
	take(buffer);
	if (error) throw new AppError(502, `Music error: ${error}`, "upstream_error");
	if (!base64) throw new AppError(502, "Music returned no audio", "upstream_error");
	return { audio: base64ToBytes(base64), costUsd, generationId };
}
