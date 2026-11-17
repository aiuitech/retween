/**
 * Scene visuals beyond a plain picture or clip: a Lottie animation, an SVG
 * illustration that draws itself on, and the two cut-out treatments
 * (a subject floating in front of its own picture, or alone on the backdrop).
 */
import { Lottie, type LottieAnimationData } from "@remotion/lottie";
import type React from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Img, useCurrentFrame, useDelayRender } from "remotion";
import { useRender } from "../context.ts";
import type { Rect } from "../lib/layout.ts";
import { clamp01, progress } from "../lib/motion.ts";
import { useSvg } from "../lib/svg.ts";
import type { MediaInfo } from "../types.ts";

// ------------------------------------------------------------------- Lottie

const lottieData = new Map<string, Promise<LottieAnimationData | Error>>();

function loadLottie(src: string): Promise<LottieAnimationData | Error> {
	let promise = lottieData.get(src);
	if (!promise) {
		promise = (async () => {
			for (let attempt = 1; ; attempt++) {
				try {
					const response = await fetch(src);
					if (!response.ok) throw new Error(`HTTP ${response.status}`);
					return (await response.json()) as LottieAnimationData;
				} catch (err) {
					if (attempt >= 3) return err instanceof Error ? err : new Error(String(err));
				}
			}
		})();
		lottieData.set(src, promise);
	}
	return promise;
}

/** A Lottie animation fitted inside `stage`, playing from the start of the scene. */
export const LottieLayer: React.FC<{ src: string; loop: boolean; stage: Rect; onFail: (reason: string) => void }> = ({ src, loop, stage, onFail }) => {
	const { delayRender, continueRender } = useDelayRender();
	const [handle] = useState(() => delayRender("Loading animation", { timeoutInMilliseconds: 45_000 }));
	const [data, setData] = useState<LottieAnimationData | null>(null);

	useEffect(() => {
		let live = true;
		loadLottie(src).then((result) => {
			if (live) {
				if (result instanceof Error) onFail(result.message);
				else setData(result);
			}
			continueRender(handle);
		});
		return () => {
			live = false;
		};
	}, [src]);

	if (!data) return null;
	return (
		<div style={{ position: "absolute", left: stage.x, top: stage.y, width: stage.w, height: stage.h }}>
			<Lottie animationData={data} loop={loop} renderer="svg" preserveAspectRatio="xMidYMid meet" style={{ width: "100%", height: "100%" }} />
		</div>
	);
};

// ------------------------------------------------------- self-drawing SVG

type Shape = { el: SVGGeometryElement; length: number; big: boolean; color: string; stroked: boolean };

/**
 * An SVG illustration that is traced in outline, shape by shape in document
 * order (back to front), with each shape's fill following its outline. Large
 * background shapes simply fade in first. The finished frame is exactly the
 * original drawing.
 */
export const DrawnSvg: React.FC<{
	src: string;
	width: number;
	height: number;
	fit: "cover" | "contain";
	focus: { x: number; y: number };
	visibleFrames: number;
	transform?: string;
	transformOrigin?: string;
	onFail: (reason: string) => void;
}> = ({ src, width, height, fit, focus, visibleFrames, transform, transformOrigin, onFail }) => {
	const { u, fps, pace } = useRender();
	const f = useCurrentFrame();
	const { svg, failed } = useSvg(src, "illustration");
	const host = useRef<HTMLDivElement>(null);
	const shapes = useRef<Shape[]>([]);

	useEffect(() => {
		if (failed) onFail("the SVG could not be loaded");
	}, [failed]);

	// Size the drawing like an <img> with object-fit, using its view box.
	const [, , vw = 1, vh = 1] = svg?.viewBox ?? [];
	const k = fit === "cover" ? Math.max(width / vw, height / vh) : Math.min(width / vw, height / vh);
	const dw = vw * k;
	const dh = vh * k;
	const left = (width - dw) * focus.x;
	const top = (height - dh) * focus.y;

	useLayoutEffect(() => {
		const root = host.current?.querySelector("svg");
		if (!root) return;
		const area = vw * vh;
		const found: Shape[] = [];
		for (const el of root.querySelectorAll<SVGGeometryElement>("path, circle, ellipse, rect, polygon, polyline, line")) {
			if (el.closest("defs, clipPath, mask, pattern, symbol, marker")) continue;
			let length = 0;
			let boxArea = 0;
			try {
				length = el.getTotalLength();
				const box = el.getBBox();
				boxArea = box.width * box.height;
			} catch {
				continue;
			}
			const style = getComputedStyle(el);
			const fill = style.fill;
			const stroked = style.stroke !== "none" && style.stroke !== "";
			const color = fill && fill !== "none" && !fill.startsWith("url(") ? fill : stroked ? style.stroke : "currentColor";
			found.push({ el, length, big: boxArea > area * 0.45, color, stroked });
		}
		shapes.current = found;
	}, [svg, vw, vh]);

	useLayoutEffect(() => {
		const list = shapes.current;
		if (!list.length) return;
		const traced = list.filter((shape) => !shape.big);
		const span = Math.min(2.2 * fps, Math.max(0.8 * fps, visibleFrames * 0.45));
		const each = Math.max(0.45 * fps, span * 0.35);
		const lineWidth = (1.7 * u * vw) / Math.max(1, dw);
		let rank = 0;
		for (const shape of list) {
			const s = shape.el.style;
			if (shape.big) {
				s.opacity = String(pace.ease(progress(f, 0, 0.5 * fps)));
				continue;
			}
			const start = traced.length > 1 ? (rank++ / (traced.length - 1)) * (span - each) : 0;
			const line = progress(f, start, each);
			const fill = pace.ease(progress(f, start + each * 0.55, each * 0.9));
			if (line >= 1 && fill >= 1) {
				s.removeProperty("stroke-dasharray");
				s.removeProperty("stroke-dashoffset");
				s.removeProperty("fill-opacity");
				s.removeProperty("stroke-opacity");
				if (!shape.stroked) {
					s.removeProperty("stroke");
					s.removeProperty("stroke-width");
				}
				continue;
			}
			const len = Math.max(0.01, shape.length);
			s.strokeDasharray = `${len} ${len}`;
			s.strokeDashoffset = String(len * (1 - pace.ease(line)));
			s.fillOpacity = String(fill);
			if (!shape.stroked) {
				s.stroke = shape.color;
				s.strokeWidth = String(lineWidth);
				s.strokeOpacity = String(1 - fill);
			}
		}
	});

	if (!svg) return null;
	return (
		<div
			ref={host}
			style={{ position: "absolute", left, top, width: dw, height: dh, transform, transformOrigin }}
			// biome-ignore lint/security/noDangerouslySetInnerHtml: cleaned by cleanSvg (no scripts, handlers or external references)
			dangerouslySetInnerHTML={{ __html: svg.markup }}
		/>
	);
};

// ------------------------------------------------------------------ cut-outs

/** Where an image sits in a box with object-fit: cover and a focus point. */
function coverRect(info: MediaInfo, width: number, height: number, focus: { x: number; y: number }) {
	const k = Math.max(width / info.width!, height / info.height!);
	const w = info.width! * k;
	const h = info.height! * k;
	return { x: (width - w) * focus.x, y: (height - h) * focus.y, w, h };
}

/**
 * 2.5D: the picture recedes (slight push, soft focus) while its cut-out subject
 * pushes in faster in front of it. The subject always grows faster than the
 * picture behind it, around its own centre, so it keeps covering itself.
 */
export const ParallaxCutout: React.FC<{
	src: string;
	cutoutSrc: string;
	info: MediaInfo;
	bbox: NonNullable<MediaInfo["bbox"]>;
	width: number;
	height: number;
	focus: { x: number; y: number };
	amount: number;
	visibleFrames: number;
}> = ({ src, cutoutSrc, info, bbox, width, height, focus, amount, visibleFrames }) => {
	const { u, pace } = useRender();
	const f = useCurrentFrame();
	const rect = coverRect(info, width, height, focus);
	const origin = `${rect.x + ((bbox.x0 + bbox.x1) / 2) * rect.w}px ${rect.y + ((bbox.y0 + bbox.y1) / 2) * rect.h}px`;
	const t = pace.transitionEase(visibleFrames > 1 ? clamp01(f / (visibleFrames - 1)) : 0);
	const layer: React.CSSProperties = { position: "absolute", left: rect.x, top: rect.y, width: rect.w, height: rect.h, maxWidth: "none", transformOrigin: origin };
	return (
		<div style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
			<Img
				src={src}
				maxRetries={1}
				delayRenderTimeoutInMilliseconds={25_000}
				style={{ ...layer, transform: `scale(${1 + amount * t})`, filter: `blur(${(2.6 * u * t).toFixed(2)}px)` }}
			/>
			<Img
				src={cutoutSrc}
				maxRetries={1}
				delayRenderTimeoutInMilliseconds={25_000}
				style={{
					...layer,
					transform: `scale(${1 + amount * 2.6 * t})`,
					filter: `drop-shadow(0 ${(14 * u * t).toFixed(1)}px ${(30 * u * t).toFixed(1)}px rgba(0, 0, 0, ${(0.28 * t).toFixed(3)}))`,
				}}
			/>
		</div>
	);
};

/** The cut-out subject on its own, sized to `stage`, with a soft shadow and a slow float. */
export const IsolatedCutout: React.FC<{
	cutoutSrc: string;
	info: MediaInfo;
	bbox: NonNullable<MediaInfo["bbox"]>;
	stage: Rect;
	seedPhase: number;
	onFail: (reason: string) => void;
}> = ({ cutoutSrc, info, bbox, stage, seedPhase, onFail }) => {
	const { u, fps, pace } = useRender();
	const f = useCurrentFrame();
	const iw = info.width!;
	const ih = info.height!;
	const bw = (bbox.x1 - bbox.x0) * iw;
	const bh = (bbox.y1 - bbox.y0) * ih;
	const k = Math.min((stage.w * 0.9) / bw, (stage.h * 0.9) / bh);
	const cx = ((bbox.x0 + bbox.x1) / 2) * iw * k;
	const cy = ((bbox.y0 + bbox.y1) / 2) * ih * k;
	const enter = pace.ease(progress(f, 0, pace.duration * fps * 1.6));
	const float = Math.sin((f / fps) * 0.9 + seedPhase * Math.PI * 2) * 7 * u;
	return (
		<Img
			src={cutoutSrc}
			maxRetries={1}
			delayRenderTimeoutInMilliseconds={25_000}
			onError={() => onFail("cut-out failed to load")}
			style={{
				position: "absolute",
				left: stage.x + stage.w / 2 - cx,
				top: stage.y + stage.h / 2 - cy,
				width: iw * k,
				height: ih * k,
				maxWidth: "none",
				opacity: clamp01(enter * 1.4),
				transform: `translateY(${(1 - enter) * 30 * u + float}px) scale(${0.94 + 0.06 * enter + 0.025 * clamp01(f / (8 * fps))})`,
				transformOrigin: `${cx}px ${cy}px`,
				filter: `drop-shadow(0 ${26 * u}px ${44 * u}px rgba(0, 0, 0, 0.24))`,
			}}
		/>
	);
};

