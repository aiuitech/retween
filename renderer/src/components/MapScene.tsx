import "maplibre-gl/dist/maplibre-gl.css";
import * as maplibregl from "maplibre-gl";
import type React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { staticFile, useCurrentFrame, useDelayRender } from "remotion";
import { useRender } from "../context.ts";
import { mix, pickReadable, readableOn, withAlpha } from "../lib/color.ts";
import { type Box, type Camera, MAP_ATTRIBUTION, brandMapStyle, fitCamera, flight, mapInk, project, toScreen, unproject, zoomAround } from "../lib/mapStyle.ts";
import { backOut, clamp01, progress } from "../lib/motion.ts";
import type { TimelineMap } from "../types.ts";
import { BrandBackdrop } from "./BrandBackdrop.tsx";

// Copied into public/ by scripts/copy-public.mjs: MapLibre cannot find its worker inside a webpack bundle.
maplibregl.setWorkerUrl(staticFile("maplibre-gl-worker.mjs"));

type Props = {
	map: TimelineMap;
	seed: string;
	/** Output px. */
	width: number;
	height: number;
	visibleFrames: number;
	/** Where the scene's text sits; the framing keeps the places clear of it. */
	textPosition: "top" | "center" | "bottom";
	hasText: boolean;
};

/**
 * A map scene: a vector map in the brand colours, with the camera worked out
 * for every frame (a slow push over all the places, or a tour that flies to
 * each place as the narration reaches it), pins that drop on their cue, and an
 * optional route that draws itself between them.
 *
 * The map is laid out at design size (1080 short side) and scaled up, so
 * labels and line widths look the same at every resolution. Pins and the route
 * are drawn by this component, from the same camera, so they never depend on
 * the map having loaded: if WebGL or the tiles fail, they appear over the
 * brand backdrop instead.
 */
export const MapScene: React.FC<Props> = ({ map, seed, width, height, visibleFrames, textPosition, hasText }) => {
	const { u, fps, pace, theme, fonts, caption, watermark, frame: layout } = useRender();
	const f = useCurrentFrame();
	const size = { w: width / u, h: height / u };
	const c = theme.colors;
	const { land, ink } = mapInk(c, map.style);

	// --- framing -------------------------------------------------------------
	const points = useMemo(() => map.places.map((place) => project(place.lng, place.lat)), [map.places]);
	const box = useMemo<Box>(() => {
		const sideX = layout.safe.x / u + 40;
		let top = layout.safe.y / u + 70;
		let bottom = size.h - (layout.safe.y + layout.safe.h) / u + 60;
		if (hasText && textPosition === "top") top = Math.max(top, size.h * 0.42);
		if (hasText && textPosition === "bottom") bottom = Math.max(bottom, size.h * 0.42);
		if (caption?.position === "bottom") bottom = Math.max(bottom, size.h - caption.band.y / u + 30);
		if (caption?.position === "top") top = Math.max(top, (caption.band.y + caption.band.h) / u + 30);
		// Leave room on the right for the place labels, which sit beside their pins.
		return { x: sideX, y: top, w: Math.max(80, size.w - 2 * sideX - 160), h: Math.max(80, size.h - top - bottom) };
	}, [layout, u, size.w, size.h, hasText, textPosition, caption]);

	const camera = useMemo(() => {
		const single = points.length === 1;
		const overview = fitCamera(points, box, size, single ? (map.zoom ?? 11) : (map.zoom ?? 13));
		// Pushes in around the middle of the framing box, so what is framed stays framed.
		const focus = { x: box.x + box.w / 2, y: box.y + box.h / 2 };
		const push = (cam: Camera, dz: number) => zoomAround(cam, focus, dz, size);
		if (map.camera === "overview" || single) {
			// A slow push in over the whole scene, ending on the framing (so nothing drifts out of it).
			return (frame: number): Camera => push(overview, -0.3 + 0.3 * pace.transitionEase(clamp01(frame / Math.max(1, visibleFrames))));
		}
		const stopZoom = map.zoom ?? Math.min(12, Math.max(3, overview.zoom + 3.5));
		const stops = points.map((point) => fitCamera([point], box, size, stopZoom));
		const arrivals = map.places.map((place) => place.atFrame);
		const longest = Math.round(2.4 * fps);
		const hold = Math.round(0.5 * fps);
		return (frame: number): Camera => {
			const next = arrivals.findIndex((arrival) => arrival > frame);
			if (next === -1) {
				// Settled on the last place: a gentle push.
				const last = arrivals.length - 1;
				return push(stops[last]!, 0.25 * clamp01((frame - arrivals[last]!) / (3 * fps)));
			}
			// A first place that arrives almost at once is simply where the tour starts.
			if (next === 0 && arrivals[0]! < Math.round(0.8 * fps)) return stops[0]!;
			const from = next === 0 ? overview : stops[next - 1]!;
			const leave = next === 0 ? 0 : arrivals[next - 1]! + hold;
			const duration = Math.max(Math.round(0.8 * fps), Math.min(longest, arrivals[next]! - leave));
			const start = arrivals[next]! - duration;
			if (frame < start) {
				return next === 0 ? from : push(from, 0.25 * clamp01((frame - arrivals[next - 1]!) / (3 * fps)));
			}
			const pair = fitCamera([next === 0 ? points[0]! : points[next - 1]!, points[next]!], box, size, 18);
			return flight(from, stops[next]!, clamp01((frame - start) / duration), Math.min(pair.zoom, next === 0 ? overview.zoom : pair.zoom) - 0.3);
		};
	}, [points, box, size.w, size.h, map, fps, pace, visibleFrames]);

	const cam = camera(f);

	// --- the base map ----------------------------------------------------------
	const container = useRef<HTMLDivElement>(null);
	const { delayRender, continueRender } = useDelayRender();
	const [instance, setInstance] = useState<maplibregl.Map | null>(null);
	const [failed, setFailed] = useState(false);
	const [loading] = useState(() => delayRender("Loading map", { timeoutInMilliseconds: 90_000 }));

	useEffect(() => {
		let live = true;
		let created: maplibregl.Map | null = null;
		let released = false;
		const release = () => {
			if (released) return;
			released = true;
			continueRender(loading);
		};
		const giveUp = (reason: string) => {
			console.warn(`[retween] scene "${seed}": the map could not be drawn (${reason}); pins are shown over the brand backdrop`);
			if (live) setFailed(true);
			release();
		};
		const timer = setTimeout(() => giveUp("timed out loading the map style"), 45_000);
		(async () => {
			try {
				const style = await brandMapStyle({ land, text: ink, primary: c.primary, variant: map.style });
				if (!live || !container.current) return release();
				const start = camera(f);
				created = new maplibregl.Map({
					container: container.current,
					style,
					center: unproject(start) as maplibregl.LngLatLike,
					zoom: start.zoom,
					interactive: false,
					attributionControl: false,
					fadeDuration: 0,
					pixelRatio: u,
					canvasContextAttributes: { preserveDrawingBuffer: true, antialias: true },
				});
				created.once("load", () => {
					clearTimeout(timer);
					if (live) setInstance(created);
					release();
				});
			} catch (err) {
				clearTimeout(timer);
				giveUp(err instanceof Error ? err.message : String(err));
			}
		})();
		return () => {
			live = false;
			clearTimeout(timer);
			release();
			created?.remove();
		};
		// The map is created once per mount; the camera is set per frame below.
	}, []);

	useEffect(() => {
		if (!instance) return;
		const handle = delayRender(`Drawing map frame ${f}`, { timeoutInMilliseconds: 60_000 });
		let done = false;
		const finish = () => {
			if (done) return;
			done = true;
			continueRender(handle);
		};
		instance.once("idle", finish);
		instance.jumpTo({ center: unproject(cam) as maplibregl.LngLatLike, zoom: cam.zoom });
		instance.triggerRepaint();
		// A tile that never answers must not stall the render: draw what has arrived.
		const timer = setTimeout(finish, 25_000);
		return () => {
			clearTimeout(timer);
			finish();
		};
	}, [instance, cam.x, cam.y, cam.zoom, f]);

	// --- pins, labels, route -------------------------------------------------
	const screen = points.map((point) => toScreen(point, cam, size));
	const tour = map.camera === "tour" && points.length > 1;
	const drop = Math.round(pace.duration * fps * 1.1);
	const appear = (i: number) => map.places[i]!.atFrame - (tour ? Math.round(0.15 * fps) : 0);
	const labelBg = map.style === "dark" ? mix(land, ink, 0.14) : c.surface;
	const labelText = pickReadable(labelBg, 4.5, ink, c.text);
	const pin = pickReadable(land, 2.2, c.accent, c.primary, ink);

	// Labels go beside their pins, on the right unless that runs off the frame or into another label.
	const LABEL_H = 48;
	const placed: { x: number; y: number; w: number; h: number }[] = [];
	const sides = screen.map((point, i) => {
		const w = map.places[i]!.name.length * 15.5 + 40;
		const options = point.x > size.w - w - 60 ? (["left", "right", "below", "above"] as const) : (["right", "left", "below", "above"] as const);
		const rect = (side: (typeof options)[number]) =>
			side === "right"
				? { x: point.x + 30, y: point.y - LABEL_H / 2, w, h: LABEL_H }
				: side === "left"
					? { x: point.x - 30 - w, y: point.y - LABEL_H / 2, w, h: LABEL_H }
					: side === "below"
						? { x: point.x - w / 2, y: point.y + 26, w, h: LABEL_H }
						: { x: point.x - w / 2, y: point.y - 26 - LABEL_H, w, h: LABEL_H };
		const clear = (r: ReturnType<typeof rect>) =>
			placed.every((o) => r.x > o.x + o.w + 8 || r.x + r.w < o.x - 8 || r.y > o.y + o.h + 4 || r.y + r.h < o.y - 4) &&
			screen.every((other, j) => j === i || other.x < r.x - 16 || other.x > r.x + r.w + 16 || other.y < r.y - 16 || other.y > r.y + r.h + 16);
		const side = options.find((option) => clear(rect(option))) ?? options[0];
		placed.push(rect(side));
		return side;
	});

	const segments = points.slice(1).map((_, k) => {
		const i = k + 1;
		const a = screen[i - 1]!;
		const b = screen[i]!;
		const end = appear(i);
		const start = Math.max(appear(i - 1), end - Math.round((tour ? 2.2 : 0.9) * fps));
		const p = pace.ease(progress(f, start, Math.max(1, end - start)));
		const dx = b.x - a.x;
		const dy = b.y - a.y;
		const len = Math.hypot(dx, dy);
		// Bow the line a little so a route reads as travel, not a ruler line.
		const bow = Math.min(0.22 * len, 140);
		const cx = (a.x + b.x) / 2 + (dy / (len || 1)) * bow * (dx >= 0 ? -1 : 1);
		const cy = (a.y + b.y) / 2 - (dx / (len || 1)) * bow * (dx >= 0 ? -1 : 1);
		return { d: `M${a.x},${a.y} Q${cx},${cy} ${b.x},${b.y}`, p };
	});

	const attributionLeft = watermark?.position === "bottom-right" || !watermark ? false : true;

	return (
		<div style={{ position: "absolute", left: 0, top: 0, width, height, overflow: "hidden", background: land }}>
			<div style={{ position: "absolute", left: 0, top: 0, width: size.w, height: size.h, transform: `scale(${u})`, transformOrigin: "0 0" }}>
				{failed ? <BrandBackdrop seed={seed} width={size.w} height={size.h} /> : null}
				<div ref={container} style={{ position: "absolute", inset: 0, opacity: failed ? 0 : 1 }} />
				<svg width={size.w} height={size.h} style={{ position: "absolute", inset: 0, overflow: "visible" }}>
					{map.route
						? segments.map((segment, i) =>
								segment.p > 0 ? (
									<g key={i}>
										<path d={segment.d} pathLength={1} fill="none" stroke={withAlpha(land, 0.85)} strokeWidth={12} strokeLinecap="round" strokeDasharray={`${segment.p} 1`} />
										<path d={segment.d} pathLength={1} fill="none" stroke={pin} strokeWidth={5} strokeLinecap="round" strokeDasharray={`${segment.p} 1`} />
									</g>
								) : null,
							)
						: null}
					{screen.map((point, i) => {
						const p = progress(f, appear(i), drop);
						if (p <= 0) return null;
						const ring = progress(f, appear(i), Math.round(1.1 * fps));
						return (
							<g key={i} transform={`translate(${point.x} ${point.y})`}>
								{ring < 1 ? <circle r={14 + 42 * ring} fill="none" stroke={pin} strokeWidth={3} opacity={0.55 * (1 - ring)} /> : null}
								<g transform={`translate(0 ${-26 * (1 - pace.ease(p))}) scale(${backOut(Math.min(1, p * 1.2), pace.overshoot + 0.8)})`}>
									<circle r={17} fill={land} opacity={0.9} />
									<circle r={12} fill={pin} />
								</g>
							</g>
						);
					})}
				</svg>
				{screen.map((point, i) => {
					const p = progress(f, appear(i) + Math.round(0.12 * fps), drop);
					if (p <= 0) return null;
					const side = sides[i]!;
					const slide = 12 * (1 - pace.ease(p));
					const place =
						side === "right"
							? `translate(30px, -50%) translateX(${-slide}px)`
							: side === "left"
								? `translate(calc(-100% - 30px), -50%) translateX(${slide}px)`
								: side === "below"
									? `translate(-50%, 26px) translateY(${-slide}px)`
									: `translate(-50%, calc(-100% - 26px)) translateY(${slide}px)`;
					return (
						<div
							key={i}
							style={{
								position: "absolute",
								left: point.x,
								top: point.y,
								transform: place,
								opacity: clamp01(p * 2),
								padding: "9px 18px",
								borderRadius: Math.min(theme.radius, 14),
								background: labelBg,
								color: labelText,
								fontFamily: fonts.body,
								fontWeight: Math.max(600, theme.fonts.body.weight),
								fontSize: 28,
								lineHeight: 1.2,
								whiteSpace: "nowrap",
								boxShadow: `0 6px 24px ${withAlpha("#000000", map.style === "dark" ? 0.4 : 0.14)}`,
							}}
						>
							{map.places[i]!.name}
						</div>
					);
				})}
				<div
					style={{
						position: "absolute",
						bottom: 10,
						[attributionLeft ? "left" : "right"]: 14,
						fontFamily: fonts.body,
						fontSize: 13,
						lineHeight: 1,
						color: withAlpha(readableOn(land), 0.55),
					}}
				>
					{MAP_ATTRIBUTION}
				</div>
			</div>
		</div>
	);
};
