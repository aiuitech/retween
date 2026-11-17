/**
 * Map styling and camera maths for map scenes.
 *
 * The base map is OpenFreeMap's "positron" style (OpenStreetMap data, no key),
 * recoloured from the brand palette so a map looks like part of the video
 * rather than a screenshot: land in the background colour, water tinted with
 * the primary, roads and labels as quiet tones of the text colour. Busy
 * layers (road shields, POIs, footpath names) are dropped.
 */
import type { StyleSpecification } from "maplibre-gl";
import { isDark, mix } from "./color.ts";

export const MAP_STYLE_URL = "https://tiles.openfreemap.org/styles/positron";
export const MAP_ATTRIBUTION = "© OpenStreetMap contributors · OpenMapTiles · OpenFreeMap";

/** Layers that add clutter without telling the viewer anything about the places being shown. */
const DROP = /shield|^airport|^aeroway|^highway-name-(path|minor)|^label_other|^label_village|^railway_.*dash|^tunnel|^road_pier|^road_area_pier/;

let base: Promise<StyleSpecification> | null = null;

async function baseStyle(): Promise<StyleSpecification> {
	base ??= (async () => {
		for (let attempt = 1; ; attempt++) {
			try {
				const response = await fetch(MAP_STYLE_URL);
				if (!response.ok) throw new Error(`HTTP ${response.status}`);
				return (await response.json()) as StyleSpecification;
			} catch (err) {
				if (attempt >= 3) {
					base = null;
					throw err;
				}
				await new Promise((resolve) => setTimeout(resolve, 600 * attempt));
			}
		}
	})();
	return base;
}

/**
 * The map's land colour and the ink drawn on it. A map that matches the brand
 * background uses it as is; a dark map on a light brand (or the reverse) swaps
 * in the brand's text colour as the land.
 */
export function mapInk(colors: { background: string; text: string }, variant: "light" | "dark"): { land: string; ink: string } {
	const bgDark = isDark(colors.background);
	if (bgDark === (variant === "dark")) return { land: colors.background, ink: colors.text };
	return { land: mix(colors.text, colors.background, variant === "dark" ? 0.06 : 0.03), ink: colors.background };
}

export type MapColors = { land: string; text: string; primary: string; variant: "light" | "dark" };

export async function brandMapStyle({ land, text, primary, variant }: MapColors): Promise<StyleSpecification> {
	const style = structuredClone(await baseStyle());
	const dark = variant === "dark";
	const ink = (t: number) => mix(land, text, t);
	const water = mix(land, primary, dark ? 0.32 : 0.2);
	const roadInner = dark ? ink(0.13) : mix(land, "#FFFFFF", 0.55);
	const roadCasing = dark ? ink(0.06) : ink(0.12);

	style.layers = style.layers.filter((layer) => layer.type !== "raster" && layer.type !== "hillshade" && !DROP.test(layer.id));
	for (const layer of style.layers) {
		const id = layer.id;
		const paint = (layer.paint ?? {}) as Record<string, unknown>;
		const sourceLayer = "source-layer" in layer ? layer["source-layer"] : undefined;
		switch (layer.type) {
			case "background":
				paint["background-color"] = land;
				break;
			case "fill":
				if (sourceLayer === "water") paint["fill-color"] = water;
				else if (sourceLayer === "building") {
					paint["fill-color"] = ink(dark ? 0.07 : 0.05);
					paint["fill-outline-color"] = ink(dark ? 0.1 : 0.09);
				} else if (/ice|glacier/.test(id)) paint["fill-color"] = ink(0.02);
				else paint["fill-color"] = ink(dark ? 0.045 : 0.035);
				break;
			case "line":
				if (sourceLayer === "waterway") paint["line-color"] = mix(water, text, 0.06);
				else if (sourceLayer === "boundary") paint["line-color"] = ink(dark ? 0.32 : 0.26);
				else if (/rail/.test(id)) paint["line-color"] = ink(0.11);
				else if (/casing/.test(id)) paint["line-color"] = roadCasing;
				else if (/subtle|minor|path/.test(id)) paint["line-color"] = ink(dark ? 0.09 : 0.1);
				else paint["line-color"] = roadInner;
				break;
			case "symbol": {
				const country = /country/.test(id);
				const waterLabel = /water/.test(id);
				paint["text-color"] = waterLabel ? mix(water, text, 0.4) : ink(country ? 0.55 : /city|capital/.test(id) ? 0.5 : 0.42);
				paint["text-halo-color"] = waterLabel ? water : land;
				paint["text-halo-width"] = 1.4;
				break;
			}
		}
		(layer as { paint?: unknown }).paint = paint;
	}
	return style;
}

// --------------------------------------------------------------- camera maths

/** Web Mercator, normalised to 0..1 across the world. MapLibre draws a 512 px world at zoom 0. */
export const TILE = 512;
export type Point = { x: number; y: number };
export type Camera = { x: number; y: number; zoom: number };
export type Box = { x: number; y: number; w: number; h: number };

export const project = (lng: number, lat: number): Point => {
	const s = Math.sin((Math.max(-85, Math.min(85, lat)) * Math.PI) / 180);
	return { x: (lng + 180) / 360, y: 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI) };
};

export const unproject = (p: Point): { lng: number; lat: number } => ({
	lng: p.x * 360 - 180,
	lat: (Math.atan(Math.sinh(Math.PI * (1 - 2 * p.y))) * 180) / Math.PI,
});

export const worldSize = (zoom: number) => TILE * 2 ** zoom;

/** Where a world point lands in a viewport of `size`, for a camera. */
export const toScreen = (p: Point, cam: Camera, size: { w: number; h: number }): Point => {
	const ws = worldSize(cam.zoom);
	return { x: (p.x - cam.x) * ws + size.w / 2, y: (p.y - cam.y) * ws + size.h / 2 };
};

/**
 * The camera that frames `points` inside `box` (a part of the viewport, so the
 * framing keeps clear of the text), no closer than `maxZoom`.
 */
export function fitCamera(points: Point[], box: Box, size: { w: number; h: number }, maxZoom: number): Camera {
	const xs = points.map((p) => p.x);
	const ys = points.map((p) => p.y);
	const minX = Math.min(...xs);
	const maxX = Math.max(...xs);
	const minY = Math.min(...ys);
	const maxY = Math.max(...ys);
	const dx = maxX - minX;
	const dy = maxY - minY;
	let zoom = maxZoom;
	if (dx > 0 || dy > 0) {
		const zx = dx > 0 ? Math.log2(box.w / (dx * TILE)) : Number.POSITIVE_INFINITY;
		const zy = dy > 0 ? Math.log2(box.h / (dy * TILE)) : Number.POSITIVE_INFINITY;
		zoom = Math.min(maxZoom, zx, zy);
	}
	zoom = Math.max(0.5, Math.min(18, zoom));
	const ws = worldSize(zoom);
	// Put the middle of the points at the middle of the box, not of the viewport.
	return {
		x: (minX + maxX) / 2 - (box.x + box.w / 2 - size.w / 2) / ws,
		y: (minY + maxY) / 2 - (box.y + box.h / 2 - size.h / 2) / ws,
		zoom,
	};
}

/** The camera after zooming in by `dz` around a point on screen (which stays put). */
export function zoomAround(cam: Camera, at: Point, dz: number, size: { w: number; h: number }): Camera {
	const before = worldSize(cam.zoom);
	const after = worldSize(cam.zoom + dz);
	const world = { x: cam.x + (at.x - size.w / 2) / before, y: cam.y + (at.y - size.h / 2) / before };
	return { x: world.x - (at.x - size.w / 2) / after, y: world.y - (at.y - size.h / 2) / after, zoom: cam.zoom + dz };
}

/** A camera move that eases between two framings, pulling back mid-way when both ends would not fit on screen. */
export function flight(from: Camera, to: Camera, t: number, pullBackTo: number): Camera {
	const e = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
	const linear = from.zoom + (to.zoom - from.zoom) * e;
	const mid = (from.zoom + to.zoom) / 2;
	const bump = Math.max(0, mid - pullBackTo);
	return {
		x: from.x + (to.x - from.x) * e,
		y: from.y + (to.y - from.y) * e,
		zoom: linear - bump * Math.sin(Math.PI * t),
	};
}
