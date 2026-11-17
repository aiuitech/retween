/**
 * Free stock media. Every result carries its licence so that an imported
 * asset knows whether, and how, it has to be credited.
 *
 * Openverse and Wikimedia Commons need no key. Pexels and Pixabay are used
 * when their (free) API keys are configured.
 */
import { env } from "cloudflare:workers";
import type { AssetLicense } from "../db/schema.ts";
import { AppError, badRequest } from "../lib/util.ts";

export const STOCK_PROVIDERS = ["pexels", "pixabay", "openverse", "wikimedia"] as const;
export type StockProvider = (typeof STOCK_PROVIDERS)[number];
export type StockMedia = "image" | "video" | "audio";
export type Orientation = "landscape" | "portrait" | "square";

export interface StockItem {
	provider: StockProvider;
	id: string;
	media: StockMedia;
	title: string;
	previewUrl?: string;
	downloadUrl: string;
	pageUrl?: string;
	width?: number;
	height?: number;
	durationSec?: number;
	license: AssetLicense;
}

const optionalSecret = (name: string) => (env as unknown as Record<string, string | undefined>)[name] || undefined;
const userAgent = () => env.OUTBOUND_USER_AGENT;

/** Which providers can serve which media, given the keys that are configured. */
export function availableProviders(media: StockMedia): StockProvider[] {
	const out: StockProvider[] = [];
	if (optionalSecret("PEXELS_API_KEY") && media !== "audio") out.push("pexels");
	if (optionalSecret("PIXABAY_API_KEY") && media !== "audio") out.push("pixabay");
	out.push("openverse");
	out.push("wikimedia");
	return media === "video" ? out.filter((p) => p !== "openverse") : out;
}

async function getJson<T>(provider: string, url: string, headers: Record<string, string> = {}): Promise<T> {
	const response = await fetch(url, { headers: { "user-agent": userAgent(), accept: "application/json", ...headers } });
	if (!response.ok) {
		throw new AppError(502, `${provider} search failed (${response.status})`, "upstream_error");
	}
	return (await response.json()) as T;
}

const stripHtml = (html: string | undefined) =>
	html
		?.replace(/<[^>]*>/g, "")
		.replace(/&amp;/g, "&")
		.replace(/&quot;/g, '"')
		.replace(/&#0?39;/g, "'")
		.replace(/\s+/g, " ")
		.trim() || undefined;

// ---------------------------------------------------------------- Pexels

interface PexelsPhoto {
	id: number;
	width: number;
	height: number;
	url: string;
	photographer: string;
	alt?: string;
	src: { original: string; large2x: string; large: string; medium: string };
}
interface PexelsVideo {
	id: number;
	width: number;
	height: number;
	url: string;
	image: string;
	duration: number;
	user: { name: string };
	video_files: { quality: string; file_type: string; width: number | null; height: number | null; link: string }[];
}

const pexelsLicense = (author: string, sourceUrl: string): AssetLicense => ({
	provider: "pexels",
	license: "Pexels License",
	licenseUrl: "https://www.pexels.com/license/",
	author,
	sourceUrl,
	attributionRequired: false,
	attribution: `${author} / Pexels`,
});

function pexelsPhoto(photo: PexelsPhoto): StockItem {
	return {
		provider: "pexels",
		id: String(photo.id),
		media: "image",
		title: photo.alt || `Photo by ${photo.photographer}`,
		previewUrl: photo.src.medium,
		downloadUrl: photo.src.large2x || photo.src.original,
		pageUrl: photo.url,
		width: photo.width,
		height: photo.height,
		license: pexelsLicense(photo.photographer, photo.url),
	};
}

function pexelsVideo(video: PexelsVideo): StockItem | null {
	// Prefer the largest MP4 that is at most 1080 on its short side.
	const files = video.video_files
		.filter((f) => f.file_type === "video/mp4" && f.width && f.height)
		.sort((a, b) => Math.min(b.width!, b.height!) - Math.min(a.width!, a.height!));
	const file = files.find((f) => Math.min(f.width!, f.height!) <= 1080) ?? files.at(-1);
	if (!file) return null;
	return {
		provider: "pexels",
		id: String(video.id),
		media: "video",
		title: `Video by ${video.user.name}`,
		previewUrl: video.image,
		downloadUrl: file.link,
		pageUrl: video.url,
		width: file.width ?? video.width,
		height: file.height ?? video.height,
		durationSec: video.duration,
		license: pexelsLicense(video.user.name, video.url),
	};
}

async function pexelsSearch(query: string, media: StockMedia, limit: number, orientation?: Orientation): Promise<StockItem[]> {
	const key = optionalSecret("PEXELS_API_KEY");
	if (!key || media === "audio") return [];
	const params = new URLSearchParams({ query, per_page: String(limit) });
	if (orientation) params.set("orientation", orientation);
	if (media === "image") {
		const json = await getJson<{ photos: PexelsPhoto[] }>("Pexels", `https://api.pexels.com/v1/search?${params}`, { authorization: key });
		return json.photos.map(pexelsPhoto);
	}
	const json = await getJson<{ videos: PexelsVideo[] }>("Pexels", `https://api.pexels.com/videos/search?${params}`, { authorization: key });
	return json.videos.map(pexelsVideo).filter((item): item is StockItem => item !== null);
}

async function pexelsGet(id: string, media: StockMedia): Promise<StockItem | null> {
	const key = optionalSecret("PEXELS_API_KEY");
	if (!key) throw badRequest("Pexels is not configured");
	if (media === "image") return pexelsPhoto(await getJson<PexelsPhoto>("Pexels", `https://api.pexels.com/v1/photos/${encodeURIComponent(id)}`, { authorization: key }));
	return pexelsVideo(await getJson<PexelsVideo>("Pexels", `https://api.pexels.com/videos/videos/${encodeURIComponent(id)}`, { authorization: key }));
}

// --------------------------------------------------------------- Pixabay

interface PixabayImage {
	id: number;
	pageURL: string;
	tags: string;
	webformatURL: string;
	largeImageURL: string;
	imageWidth: number;
	imageHeight: number;
	user: string;
}
interface PixabayVideo {
	id: number;
	pageURL: string;
	tags: string;
	duration: number;
	user: string;
	videos: Record<"large" | "medium" | "small" | "tiny", { url: string; width: number; height: number; thumbnail?: string }>;
}

const pixabayLicense = (author: string, sourceUrl: string): AssetLicense => ({
	provider: "pixabay",
	license: "Pixabay Content License",
	licenseUrl: "https://pixabay.com/service/license-summary/",
	author,
	sourceUrl,
	attributionRequired: false,
	attribution: `${author} / Pixabay`,
});

const pixabayImage = (hit: PixabayImage): StockItem => ({
	provider: "pixabay",
	id: String(hit.id),
	media: "image",
	title: hit.tags,
	previewUrl: hit.webformatURL,
	downloadUrl: hit.largeImageURL,
	pageUrl: hit.pageURL,
	width: hit.imageWidth,
	height: hit.imageHeight,
	license: pixabayLicense(hit.user, hit.pageURL),
});

function pixabayVideo(hit: PixabayVideo): StockItem | null {
	const file = [hit.videos.large, hit.videos.medium, hit.videos.small].find((f) => f?.url && Math.min(f.width, f.height) <= 1080);
	if (!file) return null;
	return {
		provider: "pixabay",
		id: String(hit.id),
		media: "video",
		title: hit.tags,
		previewUrl: file.thumbnail,
		downloadUrl: file.url,
		pageUrl: hit.pageURL,
		width: file.width,
		height: file.height,
		durationSec: hit.duration,
		license: pixabayLicense(hit.user, hit.pageURL),
	};
}

async function pixabayQuery(media: StockMedia, params: URLSearchParams): Promise<StockItem[]> {
	const key = optionalSecret("PIXABAY_API_KEY");
	if (!key || media === "audio") return [];
	params.set("key", key);
	params.set("safesearch", "true");
	if (media === "image") {
		const json = await getJson<{ hits: PixabayImage[] }>("Pixabay", `https://pixabay.com/api/?${params}`);
		return json.hits.map(pixabayImage);
	}
	const json = await getJson<{ hits: PixabayVideo[] }>("Pixabay", `https://pixabay.com/api/videos/?${params}`);
	return json.hits.map(pixabayVideo).filter((item): item is StockItem => item !== null);
}

function pixabaySearch(query: string, media: StockMedia, limit: number, orientation?: Orientation) {
	const params = new URLSearchParams({ q: query, per_page: String(Math.max(3, limit)) });
	if (media === "image") params.set("image_type", "photo");
	if (orientation === "landscape") params.set("orientation", "horizontal");
	if (orientation === "portrait") params.set("orientation", "vertical");
	return pixabayQuery(media, params).then((items) => items.slice(0, limit));
}

// ------------------------------------------------------------- Openverse

interface OpenverseResult {
	id: string;
	title?: string;
	creator?: string;
	url: string;
	thumbnail?: string;
	width?: number;
	height?: number;
	duration?: number;
	license: string;
	license_version?: string;
	license_url?: string;
	foreign_landing_url?: string;
	attribution?: string;
}

function openverseItem(result: OpenverseResult, media: StockMedia): StockItem {
	const publicDomain = result.license === "cc0" || result.license === "pdm";
	const name = publicDomain
		? result.license === "cc0"
			? "CC0 1.0"
			: "Public Domain Mark"
		: `CC ${result.license.toUpperCase()} ${result.license_version ?? ""}`.trim();
	return {
		provider: "openverse",
		id: result.id,
		media,
		title: result.title || "Untitled",
		previewUrl: result.thumbnail,
		downloadUrl: result.url,
		pageUrl: result.foreign_landing_url,
		width: result.width,
		height: result.height,
		durationSec: result.duration ? result.duration / 1000 : undefined,
		license: {
			provider: "openverse",
			license: name,
			licenseUrl: result.license_url,
			author: result.creator,
			sourceUrl: result.foreign_landing_url,
			attributionRequired: !publicDomain,
			attribution: result.attribution,
		},
	};
}

async function openverseSearch(query: string, media: StockMedia, limit: number, orientation?: Orientation): Promise<StockItem[]> {
	if (media === "video") return [];
	// Public domain and attribution-only licences. NonCommercial and NoDerivatives are unusable in a
	// brand video, and ShareAlike would oblige the finished video to carry the same licence.
	const params = new URLSearchParams({ q: query, page_size: String(limit), license: "cc0,pdm,by", mature: "false" });
	// Small images look soft full-frame.
	if (media === "image") params.set("size", "large");
	if (media === "image" && orientation) {
		params.set("aspect_ratio", orientation === "landscape" ? "wide" : orientation === "portrait" ? "tall" : "square");
	}
	const path = media === "image" ? "images" : "audio";
	const json = await getJson<{ results: OpenverseResult[] }>("Openverse", `https://api.openverse.org/v1/${path}/?${params}`);
	return json.results.map((result) => openverseItem(result, media));
}

async function openverseGet(id: string, media: StockMedia): Promise<StockItem | null> {
	if (media === "video") return null;
	const path = media === "image" ? "images" : "audio";
	return openverseItem(await getJson<OpenverseResult>("Openverse", `https://api.openverse.org/v1/${path}/${encodeURIComponent(id)}/`), media);
}

// ------------------------------------------------------ Wikimedia Commons

interface CommonsPage {
	pageid: number;
	title: string;
	imageinfo?: {
		url: string;
		thumburl?: string;
		descriptionurl?: string;
		width?: number;
		height?: number;
		duration?: number;
		mime: string;
		extmetadata?: Record<string, { value?: string }>;
	}[];
}

function commonsItem(page: CommonsPage, media: StockMedia): StockItem | null {
	const info = page.imageinfo?.[0];
	if (!info) return null;
	const kind = info.mime.split("/")[0];
	const matches = media === "image" ? kind === "image" && info.mime !== "image/svg+xml" : kind === media || (media === "audio" && info.mime === "application/ogg");
	if (!matches) return null;
	const meta = info.extmetadata ?? {};
	const license = meta.LicenseShortName?.value ?? "See source";
	// Skip anything that forbids commercial use or derivatives, or that requires the video to share its licence.
	if (/\b(NC|ND|SA)\b/i.test(license) || /GFDL|GNU Free/i.test(license)) return null;
	const author = stripHtml(meta.Artist?.value);
	const publicDomain = /public domain|cc0|pd-/i.test(license);
	const title = page.title.replace(/^File:/, "").replace(/\.[a-z0-9]+$/i, "");
	return {
		provider: "wikimedia",
		id: String(page.pageid),
		media,
		title,
		previewUrl: info.thumburl,
		downloadUrl: info.url,
		pageUrl: info.descriptionurl,
		width: info.width,
		height: info.height,
		durationSec: info.duration,
		license: {
			provider: "wikimedia",
			license,
			licenseUrl: meta.LicenseUrl?.value,
			author,
			sourceUrl: info.descriptionurl,
			attributionRequired: !publicDomain && meta.AttributionRequired?.value !== "false",
			attribution: `${title}${author ? ` by ${author}` : ""}, ${license}, via Wikimedia Commons`,
		},
	};
}

async function commonsQuery(params: URLSearchParams, media: StockMedia): Promise<StockItem[]> {
	params.set("action", "query");
	params.set("format", "json");
	params.set("prop", "imageinfo");
	params.set("iiprop", "url|size|mime|extmetadata");
	params.set("iiurlwidth", "640");
	const json = await getJson<{ query?: { pages?: Record<string, CommonsPage> } }>(
		"Wikimedia Commons",
		`https://commons.wikimedia.org/w/api.php?${params}`,
	);
	return Object.values(json.query?.pages ?? {})
		.map((page) => commonsItem(page, media))
		.filter((item): item is StockItem => item !== null);
}

function commonsSearch(query: string, media: StockMedia, limit: number) {
	const filetype = media === "image" ? "bitmap" : media;
	return commonsQuery(
		new URLSearchParams({
			generator: "search",
			gsrnamespace: "6",
			gsrlimit: String(Math.min(50, limit * 2)),
			gsrsearch: `${query} filetype:${filetype}`,
		}),
		media,
	).then((items) => items.slice(0, limit));
}

// ------------------------------------------------------------------ API

export async function searchStock(input: {
	query: string;
	media: StockMedia;
	provider?: StockProvider;
	orientation?: Orientation;
	limit: number;
}): Promise<{ items: StockItem[]; searched: StockProvider[]; failed: string[] }> {
	const providers = input.provider ? [input.provider] : availableProviders(input.media);
	const perProvider = Math.max(3, Math.ceil(input.limit / providers.length) + 2);
	const failed: string[] = [];
	const lists = await Promise.all(
		providers.map(async (provider) => {
			try {
				if (provider === "pexels") return await pexelsSearch(input.query, input.media, perProvider, input.orientation);
				if (provider === "pixabay") return await pixabaySearch(input.query, input.media, perProvider, input.orientation);
				if (provider === "openverse") return await openverseSearch(input.query, input.media, perProvider, input.orientation);
				return await commonsSearch(input.query, input.media, perProvider);
			} catch (error) {
				failed.push(`${provider}: ${error instanceof Error ? error.message : "failed"}`);
				return [];
			}
		}),
	);
	// Interleave so one provider does not crowd out the rest.
	const items: StockItem[] = [];
	for (let i = 0; items.length < input.limit && lists.some((list) => i < list.length); i++) {
		for (const list of lists) if (list[i] && items.length < input.limit) items.push(list[i]!);
	}
	return { items, searched: providers, failed };
}

/** Looks an item up again by id, so imports never trust a URL supplied by the caller. */
export async function getStockItem(provider: StockProvider, id: string, media: StockMedia): Promise<StockItem> {
	let item: StockItem | null | undefined;
	if (provider === "pexels") item = await pexelsGet(id, media);
	else if (provider === "pixabay") item = (await pixabayQuery(media, new URLSearchParams({ id })))[0];
	else if (provider === "openverse") item = await openverseGet(id, media);
	else item = (await commonsQuery(new URLSearchParams({ pageids: id }), media))[0];
	if (!item) throw new AppError(404, `No ${media} with id ${id} on ${provider}`, "not_found");
	return item;
}
