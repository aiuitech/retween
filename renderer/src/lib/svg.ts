/**
 * Inline SVG: fetched once per render tab, cleaned, and handed to components
 * as markup they can colour (icons use `currentColor`) or animate path by
 * path (vector illustrations that draw themselves on).
 */
import { useEffect, useState } from "react";
import { useDelayRender } from "remotion";
import { redact } from "./preflight.ts";

export type Svg = {
	/** The cleaned `<svg>` element, sized to fill whatever box it is put in. */
	markup: string;
	viewBox: [number, number, number, number];
};

const results = new Map<string, Svg | Error>();
const pending = new Map<string, Promise<Svg | Error>>();

const ALLOWED_HREF = /^(#|data:image\/)/i;

/** Parses SVG text and removes anything that is not drawing: scripts, event handlers, external references. */
export function cleanSvg(text: string): Svg {
	const doc = new DOMParser().parseFromString(text, "image/svg+xml");
	const svg = doc.documentElement;
	if (svg.nodeName.toLowerCase() !== "svg" || doc.getElementsByTagName("parsererror").length) throw new Error("not an SVG file");
	for (const node of [...svg.querySelectorAll("script, foreignObject, iframe, audio, video")]) node.remove();
	for (const el of [svg, ...svg.querySelectorAll("*")]) {
		for (const attr of [...el.attributes]) {
			const name = attr.name.toLowerCase();
			if (name.startsWith("on")) el.removeAttribute(attr.name);
			else if ((name === "href" || name === "xlink:href") && !ALLOWED_HREF.test(attr.value.trim())) el.removeAttribute(attr.name);
		}
	}
	const number = (value: string | null) => (value && /^\s*[\d.]+(px)?\s*$/.test(value) ? Number.parseFloat(value) : undefined);
	let box = svg.getAttribute("viewBox")?.trim().split(/[\s,]+/).map(Number);
	if (!box || box.length !== 4 || box.some((n) => !Number.isFinite(n)) || box[2]! <= 0 || box[3]! <= 0) {
		box = [0, 0, number(svg.getAttribute("width")) ?? 100, number(svg.getAttribute("height")) ?? 100];
		svg.setAttribute("viewBox", box.join(" "));
	}
	svg.setAttribute("width", "100%");
	svg.setAttribute("height", "100%");
	svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
	svg.style.display = "block";
	svg.style.overflow = "visible";
	return { markup: new XMLSerializer().serializeToString(svg), viewBox: box as Svg["viewBox"] };
}

function load(src: string): Promise<Svg | Error> {
	let promise = pending.get(src);
	if (!promise) {
		promise = (async () => {
			for (let attempt = 1; ; attempt++) {
				try {
					const response = await fetch(src);
					if (!response.ok) throw new Error(`HTTP ${response.status}`);
					return cleanSvg(await response.text());
				} catch (err) {
					if (attempt >= 3) return err instanceof Error ? err : new Error(String(err));
				}
			}
		})().then((result) => {
			results.set(src, result);
			return result;
		});
		pending.set(src, promise);
	}
	return promise;
}

/**
 * The cleaned SVG at `src`. `svg` is null while it loads (rendering waits for
 * it) and when it cannot be used, in which case `failed` is set and a warning
 * has been logged; the caller shows nothing, or a fallback.
 */
export function useSvg(src: string | undefined, label: string): { svg: Svg | null; failed: boolean } {
	const { delayRender, continueRender } = useDelayRender();
	const [state, setState] = useState<{ src?: string; svg: Svg | null; failed: boolean; handle?: number }>(() => {
		const known = src ? results.get(src) : undefined;
		if (!src || known) return { src, svg: known instanceof Error ? null : (known ?? null), failed: known instanceof Error };
		return { src, svg: null, failed: false, handle: delayRender(`Loading ${label}`, { timeoutInMilliseconds: 45_000 }) };
	});

	useEffect(() => {
		if (state.handle === undefined || !src) return;
		let cancelled = false;
		load(src).then((result) => {
			// The handle is released even after an unmount, or the render would wait for it forever.
			if (!cancelled) {
				if (result instanceof Error) {
					console.warn(`[retween] ${label} could not be loaded (${result.message}), left out - ${redact(src)}`);
				}
				setState({ src, svg: result instanceof Error ? null : result, failed: result instanceof Error });
			}
			continueRender(state.handle!);
		});
		return () => {
			cancelled = true;
		};
	}, [state.handle, src, label, continueRender]);

	return { svg: state.svg, failed: state.failed };
}
