/**
 * Runs once per render, in the `calculateMetadata` tab.
 *
 * - Probes every image / video / audio URL so that a missing or broken asset
 *   is known before the first frame: scenes fall back to the brand backdrop,
 *   audio clips are dropped, and the reason is logged.
 * - Resolves the theme fonts to concrete font files.
 *
 * The result travels to every render tab as props, so all tabs make the same
 * decisions and no frame can disagree with its neighbour.
 */
import { ALL_FORMATS, Input, UrlSource } from "mediabunny";
import type { MediaInfo, RenderProps, Resolved, ResolvedFont } from "../types.ts";
import { codepointsOf, collectText, fallbackFamiliesFor, resolveFamily, uncovered, withTimeout } from "./fonts.ts";

const PROBE_TIMEOUT_MS = 20_000;

/** Error text for logs. Query strings are dropped: signed URLs carry credentials. */
const describe = (err: unknown) => (err instanceof Error ? err.message : String(err)).replace(/(https?:\/\/[^\s?"')]+)\?[^\s"')]*/g, "$1").slice(0, 300);

async function probeImage(src: string, opaqueBounds = false): Promise<MediaInfo> {
	const img = new Image();
	img.decoding = "async";
	img.src = src;
	await withTimeout(img.decode(), PROBE_TIMEOUT_MS, "image");
	const info: MediaInfo = { ok: true, kind: "image", width: img.naturalWidth, height: img.naturalHeight };
	if (opaqueBounds) {
		info.bbox = alphaBounds(img) ?? undefined;
		if (!info.bbox) return { ok: false, kind: "image", error: "the cut-out is empty (no subject was found)" };
	}
	return info;
}

/** The box around a picture's visible pixels, as fractions of its size. Null when nothing is visible. */
function alphaBounds(img: HTMLImageElement): MediaInfo["bbox"] | null {
	const scale = Math.min(1, 480 / Math.max(img.naturalWidth, img.naturalHeight));
	const w = Math.max(1, Math.round(img.naturalWidth * scale));
	const h = Math.max(1, Math.round(img.naturalHeight * scale));
	const canvas = document.createElement("canvas");
	canvas.width = w;
	canvas.height = h;
	const ctx = canvas.getContext("2d", { willReadFrequently: true });
	if (!ctx) return { x0: 0, y0: 0, x1: 1, y1: 1 };
	ctx.drawImage(img, 0, 0, w, h);
	let data: Uint8ClampedArray;
	try {
		data = ctx.getImageData(0, 0, w, h).data;
	} catch {
		// A cross-origin picture in the Studio: assume the subject fills it.
		return { x0: 0, y0: 0, x1: 1, y1: 1 };
	}
	let x0 = w;
	let y0 = h;
	let x1 = -1;
	let y1 = -1;
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			if (data[(y * w + x) * 4 + 3]! > 24) {
				if (x < x0) x0 = x;
				if (x > x1) x1 = x;
				if (y < y0) y0 = y;
				if (y > y1) y1 = y;
			}
		}
	}
	if (x1 < 0) return null;
	return { x0: x0 / w, y0: y0 / h, x1: (x1 + 1) / w, y1: (y1 + 1) / h };
}

/** Lottie: fetch and check the JSON. Every render tab fetches it again (see LottieLayer). */
async function probeLottie(src: string): Promise<MediaInfo> {
	const response = await withTimeout(fetch(src), PROBE_TIMEOUT_MS, "animation");
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	const data = (await withTimeout(response.json(), PROBE_TIMEOUT_MS, "animation")) as Record<string, unknown>;
	const [w, h, fr, ip, op] = ["w", "h", "fr", "ip", "op"].map((key) => data[key]);
	if (![w, h, fr, ip, op].every((v) => typeof v === "number") || !Array.isArray(data.layers)) throw new Error("not a Lottie animation");
	return { ok: true, kind: "animation", width: w as number, height: h as number, durationSec: ((op as number) - (ip as number)) / (fr as number) };
}

/** Metadata through an HTML media element: a second opinion when Mediabunny cannot read a file. */
function probeElement(kind: "video" | "audio", src: string): Promise<MediaInfo> {
	return withTimeout(
		new Promise<MediaInfo>((resolve, reject) => {
			const el = document.createElement(kind);
			el.preload = "metadata";
			el.muted = true;
			el.onloadedmetadata = () => {
				const info: MediaInfo = { ok: true, kind, durationSec: Number.isFinite(el.duration) ? el.duration : undefined };
				if (el instanceof HTMLVideoElement) {
					if (!el.videoWidth) return reject(new Error("no video track"));
					info.width = el.videoWidth;
					info.height = el.videoHeight;
				}
				el.removeAttribute("src");
				el.load();
				resolve(info);
			};
			el.onerror = () => reject(new Error(el.error?.message || `could not load ${kind}`));
			el.src = src;
		}),
		PROBE_TIMEOUT_MS,
		kind,
	);
}

async function probeWithMediabunny(kind: "video" | "audio", src: string): Promise<MediaInfo> {
	const input = new Input({ source: new UrlSource(src), formats: ALL_FORMATS });
	try {
		return await withTimeout(
			(async () => {
				if (kind === "video") {
					const track = await input.getPrimaryVideoTrack();
					if (!track) throw new Error("no video track");
					const [width, height, durationSec] = await Promise.all([
						track.getDisplayWidth(),
						track.getDisplayHeight(),
						input.computeDuration(),
					]);
					return { ok: true, kind, width, height, durationSec } satisfies MediaInfo;
				}
				const track = await input.getPrimaryAudioTrack();
				if (!track) throw new Error("no audio track");
				return { ok: true, kind, durationSec: await input.computeDuration() } satisfies MediaInfo;
			})(),
			PROBE_TIMEOUT_MS,
			kind,
		);
	} finally {
		input.dispose();
	}
}

export async function probe(kind: MediaInfo["kind"], src: string, cutout = false): Promise<MediaInfo> {
	try {
		if (!/^(https?:|data:|blob:|\/)/.test(src)) throw new Error("not a fetchable URL");
		if (kind === "image") return await probeImage(src, cutout);
		if (kind === "animation") return await probeLottie(src);
		try {
			return await probeWithMediabunny(kind, src);
		} catch (first) {
			try {
				return await probeElement(kind, src);
			} catch {
				throw first;
			}
		}
	} catch (err) {
		return { ok: false, kind, error: describe(err) };
	}
}

/** Strips the query string: signed URLs carry credentials that do not belong in logs. */
export const redact = (src: string) => src.split("?")[0]!.slice(0, 160);

export async function preflight({ timeline }: RenderProps): Promise<Resolved> {
	const warnings: string[] = [];

	// --- media ---------------------------------------------------------------
	const wanted = new Map<string, { kind: MediaInfo["kind"]; usedBy: string; cutout?: boolean }>();
	const want = (src: string | undefined, kind: MediaInfo["kind"], usedBy: string, cutout = false) => {
		if (src && !wanted.has(src)) wanted.set(src, { kind, usedBy, cutout });
	};
	want(timeline.theme.logo?.src, "image", "theme.logo");
	want(timeline.theme.logo?.darkSrc, "image", "theme.logo.darkSrc");
	want(timeline.theme.watermark?.src, "image", "theme.watermark");
	want(timeline.theme.watermark?.darkSrc, "image", "theme.watermark.darkSrc");
	for (const scene of timeline.scenes) {
		const bg = scene.background;
		if (bg.kind === "image") want(bg.src, "image", `scene "${scene.id}" background`);
		if (bg.kind === "image" && bg.cutout) want(bg.cutout.src, "image", `scene "${scene.id}" cut-out`, true);
		if (bg.kind === "video") want(bg.src, "video", `scene "${scene.id}" background`);
		if (bg.kind === "lottie") want(bg.src, "animation", `scene "${scene.id}" animation`);
		want(scene.content.icon?.src, "image", `scene "${scene.id}" icon`);
		for (const bullet of scene.content.bullets ?? []) want(bullet.icon?.src, "image", `scene "${scene.id}" bullet icon`);
	}
	for (const clip of timeline.audio) want(clip.src, "audio", `audio "${clip.id}" (${clip.kind})`);

	const media: Resolved["media"] = {};
	await Promise.all(
		[...wanted].map(async ([src, { kind, usedBy, cutout }]) => {
			const info = await probe(kind, src, cutout);
			media[src] = info;
			if (!info.ok) warnings.push(`${usedBy}: ${kind} unusable (${info.error}) - ${redact(src)}`);
		}),
	);

	// --- fonts ---------------------------------------------------------------
	const { heading, body } = timeline.theme.fonts;
	const codepoints = codepointsOf(collectText(timeline));
	const sameFamily = heading.family.trim().toLowerCase() === body.family.trim().toLowerCase();
	// Body text also needs a strong cut (captions, kickers, buttons).
	const bodyWeights = [body.weight, Math.max(700, body.weight)];

	let headingFont: ResolvedFont;
	let bodyFont: ResolvedFont;
	if (sameFamily) {
		const res = await resolveFamily(body.family, [heading.weight, ...bodyWeights], codepoints);
		if (res.warning) warnings.push(res.warning);
		headingFont = bodyFont = res.font;
	} else {
		const [h, b] = await Promise.all([
			resolveFamily(heading.family, [heading.weight], codepoints),
			resolveFamily(body.family, bodyWeights, codepoints),
		]);
		if (h.warning) warnings.push(h.warning);
		if (b.warning) warnings.push(b.warning);
		headingFont = h.font;
		bodyFont = b.font;
	}

	// Scripts neither brand font can draw (CJK, Arabic, emoji ...) get a Noto fallback.
	const missing = uncovered(codepoints, [headingFont, bodyFont]);
	const extra: ResolvedFont[] = [];
	for (const family of fallbackFamiliesFor(missing)) {
		const res = await resolveFamily(family, family.includes("Emoji") ? [400] : [400, 700], codepoints);
		if (res.warning) warnings.push(res.warning);
		else extra.push(res.font);
	}

	for (const w of warnings) console.warn(`[retween] ${w}`);
	return { media, fonts: { heading: headingFont, body: bodyFont, extra }, warnings };
}
