import { Video } from "@remotion/media";
import type React from "react";
import { useState } from "react";
import { Img, useCurrentFrame } from "remotion";
import { mediaOk, useRender } from "../context.ts";
import { seeded } from "../lib/hash.ts";
import { redact } from "../lib/preflight.ts";
import type { TimelineBackground, TimelineLook, TimelineScene } from "../types.ts";
import type { Rect } from "../lib/layout.ts";
import { BrandBackdrop } from "./BrandBackdrop.tsx";
import { DrawnSvg, IsolatedCutout, LottieLayer, ParallaxCutout } from "./Visuals.tsx";

const KEN_BURNS = { none: 0, subtle: 0.07, strong: 0.16 } as const;

/**
 * True when the scene's background is a picture or footage that fills the
 * frame and can actually be shown: text over it gets a scrim and white type.
 * Lottie animations and isolated cut-outs sit on the brand backdrop instead,
 * so text over them keeps the theme colours.
 */
export function hasMedia(background: TimelineBackground, ok: (src: string) => boolean): boolean {
	if (background.kind === "image" && background.cutout?.mode === "isolate" && ok(background.cutout.src)) return false;
	return (background.kind === "image" || background.kind === "video") && ok(background.src);
}

/** True for visuals drawn inside a stage on the brand backdrop rather than filling the frame. */
export function isStaged(background: TimelineBackground, ok: (src: string) => boolean): boolean {
	if (background.kind === "lottie") return ok(background.src);
	return background.kind === "image" && background.cutout?.mode === "isolate" && ok(background.cutout.src) && ok(background.src);
}

/**
 * Fills a `width` x `height` box with the scene background.
 * `visibleFrames` is how long the scene stays on screen (including the tail it
 * keeps under the next scene's transition) - the Ken Burns move spans all of it.
 */
type BackgroundProps = {
	scene: TimelineScene;
	width: number;
	height: number;
	visibleFrames: number;
	/** Where a staged visual (Lottie, isolated cut-out) goes, inside this box. Defaults to the whole box, inset. */
	stage?: Rect;
};

export const Background: React.FC<BackgroundProps> = (props) => {
	const bg = props.scene.background;
	const look = bg.kind === "image" || bg.kind === "video" ? bg.look : undefined;
	if (!look || !hasLook(look)) return <BackgroundLayer {...props} />;
	return (
		<Graded look={look} width={props.width} height={props.height}>
			<BackgroundLayer {...props} />
		</Graded>
	);
};

const hasLook = (look: TimelineLook) => Object.values(look).some((value) => value !== undefined);

/**
 * A colour grade over whatever is inside: CSS filters for brightness,
 * contrast, saturation, black and white and blur; a soft-light wash for
 * temperature; a radial shade for the vignette.
 */
const Graded: React.FC<{ look: TimelineLook; width: number; height: number; children: React.ReactNode }> = ({ look, width, height, children }) => {
	const unit = Math.min(width, height) / 1080;
	const filters = [
		look.brightness !== undefined && look.brightness !== 1 ? `brightness(${look.brightness})` : "",
		look.contrast !== undefined && look.contrast !== 1 ? `contrast(${look.contrast})` : "",
		look.saturation !== undefined && look.saturation !== 1 ? `saturate(${look.saturation})` : "",
		look.grayscale ? `grayscale(${look.grayscale})` : "",
		look.blur ? `blur(${look.blur * unit}px)` : "",
	].filter(Boolean);
	const fill: React.CSSProperties = { position: "absolute", left: 0, top: 0, width, height, overflow: "hidden" };
	const t = look.temperature ?? 0;
	return (
		<div style={fill}>
			{/* Blur pulls in the edges; scaling up a little keeps them filled. */}
			<div style={{ ...fill, filter: filters.length ? filters.join(" ") : undefined, transform: look.blur ? `scale(${1 + (look.blur * unit * 3) / Math.min(width, height)})` : undefined }}>
				{children}
			</div>
			{t !== 0 && <div style={{ ...fill, background: t > 0 ? "#ff9a3c" : "#3c8dff", mixBlendMode: "soft-light", opacity: Math.min(1, Math.abs(t)) * 0.55 }} />}
			{look.vignette ? (
				<div style={{ ...fill, background: `radial-gradient(ellipse at center, rgba(0,0,0,0) ${Math.round(62 - look.vignette * 22)}%, rgba(0,0,0,${0.35 + look.vignette * 0.5}) 100%)` }} />
			) : null}
		</div>
	);
};

const BackgroundLayer: React.FC<BackgroundProps> = ({ scene, width, height, visibleFrames, stage }) => {
	const { theme, resolved, fps } = useRender();
	const frame = useCurrentFrame();
	const [failed, setFailed] = useState(false);
	const bg = scene.background;

	const fail = (reason: string) => {
		if (failed) return;
		const src = bg.kind === "image" || bg.kind === "video" || bg.kind === "lottie" ? redact(bg.src) : "";
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

	const area: Rect = stage ?? { x: width * 0.06, y: height * 0.06, w: width * 0.88, h: height * 0.88 };
	if (bg.kind === "lottie") {
		return (
			<div style={fill}>
				<BrandBackdrop seed={scene.id} width={width} height={height} />
				<LottieLayer src={bg.src} loop={bg.loop} stage={area} onFail={fail} />
			</div>
		);
	}

	const fx = clamp01(bg.focus?.x ?? 0.5);
	const fy = clamp01(bg.focus?.y ?? 0.5);
	const amount = KEN_BURNS[theme.motion.kenBurns];

	if (bg.kind === "image" && bg.cutout && mediaOk(resolved, bg.cutout.src)) {
		const info = resolved.media[bg.src];
		const cut = resolved.media[bg.cutout.src];
		if (info?.width && info.height && cut?.bbox) {
			if (bg.cutout.mode === "isolate") {
				return (
					<div style={fill}>
						<BrandBackdrop seed={scene.id} width={width} height={height} />
						<IsolatedCutout cutoutSrc={bg.cutout.src} info={info} bbox={cut.bbox} stage={area} seedPhase={seeded(scene.id, 1)[0] ?? 0} onFail={fail} />
					</div>
				);
			}
			return (
				<div style={{ ...fill, background: theme.colors.background }}>
					<ParallaxCutout
						src={bg.src}
						cutoutSrc={bg.cutout.src}
						info={info}
						bbox={cut.bbox}
						width={width}
						height={height}
						focus={{ x: fx, y: fy }}
						amount={Math.max(amount, 0.06) * 1.15}
						visibleFrames={visibleFrames}
					/>
				</div>
			);
		}
	}

	if (bg.kind === "image") {
		// Direction is picked per scene id: push in or pull out, drifting towards a different corner each time.
		const move = amount * (bg.fit === "contain" ? 0.4 : 1);
		const [dir = 0, ox = 0, oy = 0] = seeded(scene.id, 3);
		const p = visibleFrames > 1 ? Math.min(1, frame / (visibleFrames - 1)) : 0;
		// A drawing pushes in while it draws; a photo picks its direction from the scene id.
		const zoomIn = bg.draw || dir < 0.5;
		const scale = bg.fit === "contain" ? 1 - move * (zoomIn ? 1 - p : p) : 1 + move * (zoomIn ? p : 1 - p);
		// Scaling around a point near the focus keeps the focus in frame and reads as a slow pan.
		const originX = clamp01(fx + (ox - 0.5) * 0.5) * 100;
		const originY = clamp01(fy + (oy - 0.5) * 0.5) * 100;
		if (bg.draw) {
			return (
				<div style={{ ...fill, background: theme.colors.background }}>
					<DrawnSvg
						src={bg.src}
						width={width}
						height={height}
						fit={bg.fit}
						focus={{ x: fx, y: fy }}
						visibleFrames={visibleFrames}
						transform={move > 0 ? `scale(${scale})` : undefined}
						transformOrigin={`${originX}% ${originY}%`}
						onFail={fail}
					/>
				</div>
			);
		}
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
						transform: move > 0 ? `scale(${scale})` : undefined,
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
	// A punch-in scales around the focus point, so the face stays where it was.
	const zoom = bg.zoom && bg.zoom > 1 ? bg.zoom : undefined;
	return (
		<div style={{ ...fill, background: theme.colors.background }}>
			<div style={zoom ? { ...fill, transform: `scale(${zoom})`, transformOrigin: `${fx * 100}% ${fy * 100}%` } : fill}>
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
		</div>
	);
};

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
