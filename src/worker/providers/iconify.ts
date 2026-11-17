/**
 * Iconify: 200+ open-source icon sets behind one API, no key needed.
 * Every set carries its own licence, which travels with the imported icon so
 * video.credits can list it.
 *
 * Also place lookup (OpenStreetMap Nominatim) for map scenes.
 */
import { env } from "cloudflare:workers";
import type { AssetLicense } from "../db/schema.ts";
import { AppError } from "../lib/util.ts";

const BASE = "https://api.iconify.design";

export interface IconSetInfo {
	prefix: string;
	name: string;
	total?: number;
	author?: { name: string; url?: string };
	license?: { title: string; spdx?: string; url?: string };
	/** True for multi-colour sets (emoji, logos); false for glyphs drawn in one colour. */
	palette: boolean;
	category?: string;
}

async function getJson<T>(what: string, url: string): Promise<T> {
	const response = await fetch(url, { headers: { "user-agent": env.OUTBOUND_USER_AGENT, accept: "application/json" } });
	if (!response.ok) throw new AppError(502, `${what} failed (${response.status})`, "upstream_error");
	return (await response.json()) as T;
}

type RawInfo = Omit<IconSetInfo, "prefix">;
const toInfo = (prefix: string, raw: RawInfo): IconSetInfo => ({
	prefix,
	name: raw.name,
	total: raw.total,
	author: raw.author,
	license: raw.license,
	palette: Boolean(raw.palette),
	category: raw.category,
});

export async function searchIcons(input: { query: string; prefixes?: string[]; limit: number }) {
	const params = new URLSearchParams({ query: input.query, limit: String(Math.max(32, input.limit)) });
	if (input.prefixes?.length) params.set("prefixes", input.prefixes.join(","));
	const json = await getJson<{ icons: string[]; collections?: Record<string, RawInfo> }>("Icon search", `${BASE}/search?${params}`);
	return {
		icons: json.icons.slice(0, input.limit),
		sets: Object.entries(json.collections ?? {}).map(([prefix, raw]) => toInfo(prefix, raw)),
	};
}

/** Information about icon sets, by prefix. Unknown prefixes are absent from the result. */
export async function iconSets(prefixes: string[]): Promise<Map<string, IconSetInfo>> {
	if (!prefixes.length) return new Map();
	const json = await getJson<Record<string, RawInfo>>("Icon set lookup", `${BASE}/collections?prefixes=${encodeURIComponent(prefixes.join(","))}`);
	return new Map(Object.entries(json).map(([prefix, raw]) => [prefix, toInfo(prefix, raw)]));
}

/** Names (without prefix) from `names` that the set does not have. */
export async function missingIcons(prefix: string, names: string[]): Promise<string[]> {
	if (!names.length) return [];
	const json = await getJson<{ not_found?: string[] } | 404>(
		"Icon lookup",
		`${BASE}/${encodeURIComponent(prefix)}.json?icons=${encodeURIComponent(names.join(","))}`,
	);
	return typeof json === "object" ? (json.not_found ?? []) : names;
}

/** The icon as a standalone SVG sized to its own view box. */
export const iconSvgUrl = (name: string) => {
	const [prefix, icon] = name.split(":");
	return `${BASE}/${encodeURIComponent(prefix!)}/${encodeURIComponent(icon!)}.svg?height=auto`;
};

/** Attribution-style licences need a credit; permissive code licences (MIT, ISC, Apache) and public domain do not. */
export function iconLicense(set: IconSetInfo): AssetLicense {
	const spdx = set.license?.spdx ?? "";
	const title = set.license?.title ?? "See icon set";
	const attributionRequired = /^CC-BY/i.test(spdx);
	return {
		provider: "iconify",
		license: title,
		licenseUrl: set.license?.url,
		author: set.author?.name,
		sourceUrl: set.author?.url,
		attributionRequired,
		attribution: `Icons: ${set.name}${set.author?.name ? ` by ${set.author.name}` : ""} (${title})`,
	};
}

// --------------------------------------------------------------------- places

export interface Place {
	name: string;
	lat: number;
	lng: number;
	type?: string;
}

/**
 * Looks a place up by name with OpenStreetMap Nominatim. Its usage policy
 * allows light use (well under one request a second) from an identified client.
 */
export async function searchPlaces(query: string, limit: number): Promise<Place[]> {
	const params = new URLSearchParams({ q: query, format: "jsonv2", limit: String(limit), "accept-language": "en" });
	const rows = await getJson<{ display_name: string; lat: string; lon: string; type?: string; addresstype?: string }[]>(
		"Place search",
		`https://nominatim.openstreetmap.org/search?${params}`,
	);
	return rows.map((row) => ({
		name: row.display_name,
		lat: Math.round(Number(row.lat) * 1e5) / 1e5,
		lng: Math.round(Number(row.lon) * 1e5) / 1e5,
		type: row.addresstype ?? row.type,
	}));
}
