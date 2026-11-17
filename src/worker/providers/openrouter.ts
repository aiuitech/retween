/**
 * OpenRouter: still images and short video clips.
 * Images use the synchronous /images endpoint; video is a submit-then-poll job.
 */
import { env } from "cloudflare:workers";
import { AppError, base64ToBytes, upstreamError } from "../lib/util.ts";

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
