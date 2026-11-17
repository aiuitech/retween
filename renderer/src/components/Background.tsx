import { Video } from "@remotion/media";
import type React from "react";
import { useState } from "react";
import { Img, useCurrentFrame } from "remotion";
import { mediaOk, useRender } from "../context.ts";
import { seeded } from "../lib/hash.ts";
import { redact } from "../lib/preflight.ts";
import type { TimelineBackground, TimelineScene } from "../types.ts";
import { BrandBackdrop } from "./BrandBackdrop.tsx";

const KEN_BURNS = { none: 0, subtle: 0.07, strong: 0.16 } as const;

/** True when the scene's background is an image or video that can actually be shown. */
export function hasMedia(background: TimelineBackground, ok: (src: string) => boolean): boolean {
	return (background.kind === "image" || background.kind === "video") && ok(background.src);
}

/**
 * Fills a `width` x `height` box with the scene background.
 * `visibleFrames` is how long the scene stays on screen (including the tail it
 * keeps under the next scene's transition) - the Ken Burns move spans all of it.
 */
export const Background: React.FC<{
	scene: TimelineScene;
	width: number;
	height: number;
	visibleFrames: number;
}> = ({ scene, width, height, visibleFrames }) => {
	const { theme, resolved, fps } = useRender();
	const frame = useCurrentFrame();
	const [failed, setFailed] = useState(false);
	const bg = scene.background;

	const fail = (reason: string) => {
		if (failed) return;
		const src = bg.kind === "image" || bg.kind === "video" ? redact(bg.src) : "";
		console.warn(`[retween] scene "${scene.id}": ${bg.kind} background failed while rendering (${reason}), using brand backdrop - ${src}`);
		setFailed(true);
	};

	const fill: React.CSSProperties = { position: "absolute", left: 0, top: 0, width, height, overflow: "hidden" };

	if (bg.kind === "solid") return <div style={{ ...fill, background: bg.color }} />;
	if (bg.kind === "gradient") {
		return <div style={{ ...fill, background: `linear-gradient(${bg.angle}deg, ${bg.colors.join(", ")})` }} />;
	}
	if (bg.kind === "brand" || failed || !mediaOk(resolved, bg.src)) {
		return (
			<div style={fill}>
				<BrandBackdrop seed={scene.id} width={width} height={height} />
			</div>
		);
	}

	const fx = clamp01(bg.focus?.x ?? 0.5);
	const fy = clamp01(bg.focus?.y ?? 0.5);

	if (bg.kind === "image") {
		// Direction is picked per scene id: push in or pull out, drifting towards a different corner each time.
		const amount = KEN_BURNS[theme.motion.kenBurns] * (bg.fit === "contain" ? 0.4 : 1);
		const [dir = 0, ox = 0, oy = 0] = seeded(scene.id, 3);
		const p = visibleFrames > 1 ? Math.min(1, frame / (visibleFrames - 1)) : 0;
		const zoomIn = dir < 0.5;
		const scale = bg.fit === "contain" ? 1 - amount * (zoomIn ? 1 - p : p) : 1 + amount * (zoomIn ? p : 1 - p);
		// Scaling around a point near the focus keeps the focus in frame and reads as a slow pan.
		const originX = clamp01(fx + (ox - 0.5) * 0.5) * 100;
		const originY = clamp01(fy + (oy - 0.5) * 0.5) * 100;
		return (
			<div style={{ ...fill, background: theme.colors.background }}>
				<Img
					src={bg.src}
					maxRetries={1}
					delayRenderTimeoutInMilliseconds={25_000}
					onError={() => fail("load error")}
					style={{
						position: "absolute",
						inset: 0,
						width: "100%",
						height: "100%",
						objectFit: bg.fit,
						objectPosition: `${fx * 100}% ${fy * 100}%`,
						transform: amount > 0 ? `scale(${scale})` : undefined,
						transformOrigin: `${originX}% ${originY}%`,
					}}
				/>
			</div>
		);
	}

	// Video. With known dimensions the element is sized by hand so `focus` can steer the crop
	// (the canvas-based <Video> has object-fit but no object-position).
	const info = resolved.media[bg.src];
	let style: React.CSSProperties = { position: "absolute", left: 0, top: 0, width, height };
	if (bg.fit === "cover" && info?.width && info.height) {
		const k = Math.max(width / info.width, height / info.height);
		const w = info.width * k;
		const h = info.height * k;
		style = { position: "absolute", width: w, height: h, left: (width - w) * fx, top: (height - h) * fy };
	}
	return (
		<div style={{ ...fill, background: theme.colors.background }}>
			<Video
				src={bg.src}
				style={style}
				objectFit={bg.fit}
				trimBefore={Math.round(bg.startFromSec * fps)}
				loop={bg.loop}
				playbackRate={bg.playbackRate}
				volume={bg.volume}
				muted={bg.volume === 0}
				delayRenderTimeoutInMilliseconds={45_000}
				fallbackOffthreadVideoProps={{ onError: (err) => fail(err.message) }}
			/>
		</div>
	);
};

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
