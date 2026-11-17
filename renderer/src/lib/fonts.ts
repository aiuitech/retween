/**
 * Runtime Google Fonts loading by family name.
 *
 * The CSS API is asked for the family, the `@font-face` rules are parsed, and
 * only the subsets that contain characters actually used in the timeline are
 * loaded through the FontFace API. Nothing here can throw or hang a render:
 * an unknown family, a network error or a timeout all degrade to the bundled
 * fallback (Inter) and a warning.
 */
import type { FontFaceSpec, ResolvedFont, Timeline } from "../types.ts";

const CSS_API = "https://fonts.googleapis.com/css2";

/** Bundled with the Remotion bundle (see Root.tsx), so it is always available offline. */
export const FALLBACK_FAMILY = "Inter Variable";
const GENERIC = new Set(["serif", "sans-serif", "monospace", "system-ui", "cursive", "fantasy", "ui-sans-serif", "ui-serif", "ui-monospace"]);

export const withTimeout = <T>(promise: Promise<T>, ms: number, label: string): Promise<T> =>
	new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
		promise.then(
			(v) => {
				clearTimeout(timer);
				resolve(v);
			},
			(e) => {
				clearTimeout(timer);
				reject(e);
			},
		);
	});

/** "'Playfair Display', serif" -> "Playfair Display" */
export const cleanFamily = (family: string) =>
	(family.split(",")[0] ?? "")
		.trim()
		.replace(/^['"]|['"]$/g, "")
		.trim();

/** Every character the timeline can put on screen. */
export function collectText(timeline: Timeline): string {
	const parts: string[] = ["0123456789.,%$-+ "];
	for (const scene of timeline.scenes) {
		const c = scene.content;
		parts.push(c.kicker ?? "", c.heading ?? "", c.subheading ?? "", c.body ?? "", c.quote ?? "", c.attribution ?? "");
		for (const b of c.bullets ?? []) parts.push(b.text);
		if (c.stat) parts.push(c.stat.value, c.stat.prefix ?? "", c.stat.suffix ?? "", c.stat.label ?? "");
		if (c.cta) parts.push(c.cta.text, c.cta.url ?? "");
		if (c.lowerThird) parts.push(c.lowerThird.title, c.lowerThird.subtitle ?? "");
		if (c.chart) parts.push(c.chart.prefix ?? "", c.chart.suffix ?? "", ...c.chart.points.map((point) => point.label));
		for (const place of c.map?.places ?? []) parts.push(place.name);
	}
	for (const cue of timeline.captions) parts.push(cue.text, ...cue.words.map((w) => w.text));
	const text = parts.join("");
	// Captions and kickers may be upper-cased; typographic quotes are added to quotes.
	return [...new Set([...text, ...text.toUpperCase(), ..."“”‘’—–…"])].join("");
}

export const codepointsOf = (text: string) => new Set([...text].map((ch) => ch.codePointAt(0)!));

function parseUnicodeRange(range: string): [number, number][] {
	const out: [number, number][] = [];
	for (const part of range.split(",")) {
		const m = /U\+([0-9a-f?]+)(?:-([0-9a-f]+))?/i.exec(part.trim());
		if (!m) continue;
		const a = m[1]!;
		if (a.includes("?")) out.push([parseInt(a.replace(/\?/g, "0"), 16), parseInt(a.replace(/\?/g, "f"), 16)]);
		else out.push([parseInt(a, 16), parseInt(m[2] ?? a, 16)]);
	}
	return out;
}

const covers = (ranges: [number, number][], cp: number) => ranges.some(([a, b]) => cp >= a && cp <= b);

export function parseFontFaces(css: string): FontFaceSpec[] {
	const faces: FontFaceSpec[] = [];
	for (const block of css.matchAll(/@font-face\s*{([^}]*)}/g)) {
		const body = block[1]!;
		const get = (prop: string) => new RegExp(`${prop}\\s*:\\s*([^;]+);`).exec(body)?.[1]?.trim();
		const url = /url\(\s*['"]?([^'")]+)['"]?\s*\)/.exec(get("src") ?? "")?.[1];
		const family = get("font-family")?.replace(/^['"]|['"]$/g, "");
		if (!url || !family) continue;
		faces.push({
			family,
			url,
			weight: get("font-weight") ?? "400",
			style: get("font-style") ?? "normal",
			unicodeRange: get("unicode-range"),
		});
	}
	return faces;
}

type CssResult = { status: "ok"; css: string } | { status: "unknown" } | { status: "error"; message: string };

async function fetchCss(family: string, weights: number[] | null): Promise<CssResult> {
	const name = encodeURIComponent(family).replace(/%20/g, "+");
	const axis = weights ? `:wght@${[...weights].sort((a, b) => a - b).join(";")}` : "";
	const url = `${CSS_API}?family=${name}${axis}&display=block`;
	let lastError = "";
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			const res = await withTimeout(fetch(url), 6000, "Google Fonts CSS");
			// The API answers 400 for a family or weight it does not have.
			if (res.status === 400 || res.status === 404) return { status: "unknown" };
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			return { status: "ok", css: await res.text() };
		} catch (err) {
			lastError = err instanceof Error ? err.message : String(err);
		}
	}
	return { status: "error", message: lastError };
}

const loaded = new Map<string, Promise<void>>();

/** Loads font files and registers them with the document. Rejects if any face fails. */
export function loadFaces(faces: FontFaceSpec[], timeoutMs: number): Promise<void[]> {
	return Promise.all(
		faces.map((face) => {
			const key = `${face.family}|${face.weight}|${face.style}|${face.url}`;
			let pending = loaded.get(key);
			if (!pending) {
				const ff = new FontFace(face.family, `url(${JSON.stringify(face.url)})`, {
					weight: face.weight,
					style: face.style,
					unicodeRange: face.unicodeRange,
					display: "block",
				});
				pending = withTimeout(ff.load(), timeoutMs, `font ${face.family}`).then(() => {
					document.fonts.add(ff);
				});
				loaded.set(key, pending);
				pending.catch(() => loaded.delete(key));
			}
			return pending;
		}),
	);
}

/**
 * Finds the font files for `family` at `weights` that are needed to draw
 * `codepoints`, and proves they load. Never rejects.
 */
export async function resolveFamily(
	requestedRaw: string,
	weights: number[],
	codepoints: Set<number>,
): Promise<{ font: ResolvedFont; warning?: string }> {
	const requested = cleanFamily(requestedRaw);
	const none = (warning?: string) => ({ font: { requested, family: null, faces: [] }, warning });
	if (!requested || GENERIC.has(requested.toLowerCase())) return none();
	if (requested === FALLBACK_FAMILY || requested === "Inter") {
		// Already bundled; no need to go to the network for it.
		return { font: { requested, family: FALLBACK_FAMILY, faces: [] } };
	}

	const unique = [...new Set(weights.map((w) => Math.round(w)))];
	let faces: FontFaceSpec[] = [];
	let sawNetworkError: string | null = null;

	const all = await fetchCss(requested, unique);
	if (all.status === "ok") faces = parseFontFaces(all.css);
	else if (all.status === "error") sawNetworkError = all.message;
	else if (unique.length > 1) {
		// One of the weights does not exist: take the ones that do.
		for (const w of unique) {
			const one = await fetchCss(requested, [w]);
			if (one.status === "ok") faces.push(...parseFontFaces(one.css));
			else if (one.status === "error") sawNetworkError = one.message;
		}
	}
	if (faces.length === 0 && !sawNetworkError) {
		const regular = await fetchCss(requested, null);
		if (regular.status === "ok") faces = parseFontFaces(regular.css);
		else if (regular.status === "error") sawNetworkError = regular.message;
	}
	if (faces.length === 0) {
		return none(
			sawNetworkError
				? `font "${requested}" could not be fetched (${sawNetworkError}); using fallback`
				: `font "${requested}" is not a Google Fonts family; using fallback`,
		);
	}

	const needed = faces.filter((face) => {
		if (!face.unicodeRange) return true;
		const ranges = parseUnicodeRange(face.unicodeRange);
		for (const cp of codepoints) if (covers(ranges, cp)) return true;
		return false;
	});
	try {
		await loadFaces(needed, 8000);
	} catch (err) {
		return none(`font "${requested}" failed to load (${err instanceof Error ? err.message : err}); using fallback`);
	}
	return { font: { requested, family: faces[0]!.family, faces: needed } };
}

/** Codepoints that none of the given faces can draw. */
export function uncovered(codepoints: Set<number>, fonts: ResolvedFont[]): Set<number> {
	const ranges = fonts.flatMap((f) => f.faces.flatMap((face) => (face.unicodeRange ? parseUnicodeRange(face.unicodeRange) : [])));
	const everything = fonts.some((f) => f.faces.some((face) => !face.unicodeRange));
	const out = new Set<number>();
	if (everything) return out;
	for (const cp of codepoints) if (!covers(ranges, cp)) out.add(cp);
	return out;
}

const SCRIPTS: { family: string; test: (cp: number) => boolean }[] = [
	{ family: "Noto Sans JP", test: (cp) => (cp >= 0x3040 && cp <= 0x30ff) || (cp >= 0x31f0 && cp <= 0x31ff) },
	{ family: "Noto Sans KR", test: (cp) => (cp >= 0xac00 && cp <= 0xd7af) || (cp >= 0x1100 && cp <= 0x11ff) },
	{ family: "Noto Sans SC", test: (cp) => (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3400 && cp <= 0x4dbf) },
	{ family: "Noto Sans Arabic", test: (cp) => (cp >= 0x0600 && cp <= 0x06ff) || (cp >= 0x0750 && cp <= 0x077f) },
	{ family: "Noto Sans Hebrew", test: (cp) => cp >= 0x0590 && cp <= 0x05ff },
	{ family: "Noto Sans Devanagari", test: (cp) => cp >= 0x0900 && cp <= 0x097f },
	{ family: "Noto Sans Thai", test: (cp) => cp >= 0x0e00 && cp <= 0x0e7f },
	{
		family: "Noto Color Emoji",
		test: (cp) => (cp >= 0x1f000 && cp <= 0x1faff) || (cp >= 0x2600 && cp <= 0x27bf) || (cp >= 0x2b00 && cp <= 0x2bff),
	},
];

/** Noto families to add to the stack for scripts the brand fonts cannot draw. */
export function fallbackFamiliesFor(missing: Set<number>): string[] {
	const families: string[] = [];
	for (const script of SCRIPTS) {
		for (const cp of missing) {
			if (script.test(cp)) {
				// Japanese text also contains Han; do not pull a second CJK font for it.
				if (script.family === "Noto Sans SC" && families.includes("Noto Sans JP")) break;
				families.push(script.family);
				break;
			}
		}
	}
	return families;
}

/** Makes sure the bundled fallback is ready for the given text at the given weights. */
export async function loadFallback(text: string, weights: number[]): Promise<void> {
	await withTimeout(
		Promise.all([...new Set(weights)].map((w) => document.fonts.load(`${w} 16px "${FALLBACK_FAMILY}"`, text))),
		8000,
		"fallback font",
	).catch(() => undefined);
}

const quote = (family: string) => (GENERIC.has(family.toLowerCase()) ? family : JSON.stringify(family));

/** CSS font-family value: brand font, script fallbacks, bundled fallback, system. */
export function fontStack(font: ResolvedFont, extra: ResolvedFont[]): string {
	const generic = GENERIC.has(font.requested.toLowerCase()) ? font.requested.toLowerCase() : null;
	const families = [
		...(font.family ? [font.family] : []),
		...extra.flatMap((f) => (f.family ? [f.family] : [])),
		...(generic && generic !== "sans-serif" && generic !== "system-ui" ? [generic] : []),
		FALLBACK_FAMILY,
		"system-ui",
		"sans-serif",
	];
	return [...new Set(families)].map(quote).join(", ");
}
