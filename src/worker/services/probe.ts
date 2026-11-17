/**
 * Measures media: pixel size for images, duration and size for audio/video.
 * Timing in a finished video is derived from these numbers, so they are read
 * from the file itself rather than trusted from whoever supplied it.
 */
import { env } from "cloudflare:workers";
import { ALL_FORMATS, CustomSource, Input } from "mediabunny";

export interface MediaInfo {
	width?: number;
	height?: number;
	durationMs?: number;
	hasAudio?: boolean;
	hasVideo?: boolean;
}

/** The size an SVG declares: its width and height attributes, else its view box. */
function svgSize(bytes: Uint8Array): { width: number; height: number } | null {
	const head = new TextDecoder().decode(bytes.subarray(0, 4096));
	const tag = /<svg\b[^>]*>/i.exec(head)?.[0];
	if (!tag) return null;
	const attr = (name: string) => new RegExp(`\\s${name}\\s*=\\s*["']([^"']+)["']`, "i").exec(tag)?.[1];
	const px = (value?: string) => (value && /^\s*[\d.]+\s*(px)?\s*$/.test(value) ? Number.parseFloat(value) : undefined);
	const box = attr("viewBox")?.trim().split(/[\s,]+/).map(Number);
	const width = px(attr("width")) ?? (box?.length === 4 ? box[2] : undefined);
	const height = px(attr("height")) ?? (box?.length === 4 ? box[3] : undefined);
	return width && height ? { width: Math.round(width), height: Math.round(height) } : null;
}

/** Reads the pixel size from a PNG, JPEG, GIF, WebP or SVG header. */
export function imageSize(bytes: Uint8Array): { width: number; height: number } | null {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (bytes.length < 30) return null;
	const first = bytes.findIndex((b) => b !== 0x20 && b !== 0x0a && b !== 0x0d && b !== 0x09 && b !== 0xef && b !== 0xbb && b !== 0xbf);
	if (bytes[first] === 0x3c) return svgSize(bytes);
	// PNG
	if (view.getUint32(0) === 0x89504e47) return { width: view.getUint32(16), height: view.getUint32(20) };
	// GIF
	if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
		return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
	}
	// WebP
	if (view.getUint32(0) === 0x52494646 && view.getUint32(8) === 0x57454250) {
		const chunk = String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!);
		if (chunk === "VP8X") {
			return {
				width: 1 + (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16)),
				height: 1 + (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16)),
			};
		}
		if (chunk === "VP8 ") return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
		if (chunk === "VP8L") {
			const bits = view.getUint32(21, true);
			return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
		}
	}
	// JPEG: walk segments to the first start-of-frame marker
	if (bytes[0] === 0xff && bytes[1] === 0xd8) {
		let offset = 2;
		while (offset + 9 < bytes.length) {
			if (bytes[offset] !== 0xff) {
				offset++;
				continue;
			}
			const marker = bytes[offset + 1]!;
			const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
			if (isFrame) return { width: view.getUint16(offset + 7), height: view.getUint16(offset + 5) };
			offset += 2 + view.getUint16(offset + 2);
		}
	}
	return null;
}

/** Largest Lottie file accepted. Real animations are rarely over a few hundred KB. */
export const MAX_LOTTIE_BYTES = 20 * 1024 * 1024;

/** Frame size and length of a Lottie (Bodymovin) animation, or null when the JSON is not one. */
export function lottieInfo(bytes: Uint8Array): { width: number; height: number; durationMs: number } | null {
	try {
		const data = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown> | null;
		const [w, h, fr, ip, op] = ["w", "h", "fr", "ip", "op"].map((key) => data?.[key]);
		const numbers = [w, h, fr, ip, op].every((value) => typeof value === "number" && Number.isFinite(value));
		if (!numbers || !Array.isArray(data?.layers)) return null;
		if ((fr as number) <= 0 || (op as number) <= (ip as number) || (w as number) <= 0 || (h as number) <= 0) return null;
		return {
			width: Math.round(w as number),
			height: Math.round(h as number),
			durationMs: Math.round((((op as number) - (ip as number)) / (fr as number)) * 1000),
		};
	} catch {
		return null;
	}
}

/** Probes an object already stored in R2. Never throws: unknown formats return {}. */
export async function probeObject(key: string, contentType: string, size: number): Promise<MediaInfo> {
	try {
		if (contentType.startsWith("application/json")) {
			if (size > MAX_LOTTIE_BYTES) return {};
			const object = await env.MEDIA.get(key);
			return (object && lottieInfo(new Uint8Array(await object.arrayBuffer()))) ?? {};
		}
		if (contentType.startsWith("image/")) {
			const head = await env.MEDIA.get(key, { range: { offset: 0, length: Math.min(size, 512 * 1024) } });
			if (!head) return {};
			return imageSize(new Uint8Array(await head.arrayBuffer())) ?? {};
		}
		if (!contentType.startsWith("audio/") && !contentType.startsWith("video/")) return {};

		const input = new Input({
			formats: ALL_FORMATS,
			source: new CustomSource({
				getSize: () => size,
				read: async (start, end) => {
					const part = await env.MEDIA.get(key, { range: { offset: start, length: end - start } });
					if (!part) throw new Error("object disappeared while probing");
					return new Uint8Array(await part.arrayBuffer());
				},
				prefetchProfile: "network",
			}),
		});
		try {
			const video = await input.getPrimaryVideoTrack();
			const audio = await input.getPrimaryAudioTrack();
			const duration = (await input.getDurationFromMetadata()) ?? (await input.computeDuration());
			return {
				durationMs: Number.isFinite(duration) ? Math.round(duration * 1000) : undefined,
				width: video ? await video.getDisplayWidth() : undefined,
				height: video ? await video.getDisplayHeight() : undefined,
				hasAudio: Boolean(audio),
				hasVideo: Boolean(video),
			};
		} finally {
			input.dispose();
		}
	} catch (error) {
		console.warn("probe failed", key, error instanceof Error ? error.message : error);
		return {};
	}
}
