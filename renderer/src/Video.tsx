import type React from "react";
import { useEffect, useMemo, useState } from "react";
import { AbsoluteFill, Img, Sequence, useCurrentFrame, useDelayRender } from "remotion";
import { AudioLayer } from "./components/AudioLayer.tsx";
import { Captions } from "./components/Captions.tsx";
import { Scene } from "./components/Scene.tsx";
import { mediaOk, type RenderContext, RenderProvider, useRender } from "./context.ts";
import { collectText, fontStack, loadFaces, loadFallback } from "./lib/fonts.ts";
import { captionLayout, frameLayout, watermarkBox } from "./lib/layout.ts";
import { PACE, progress } from "./lib/motion.ts";
import { preflight } from "./lib/preflight.ts";
import type { Resolved, TimelineScene, VideoProps } from "./types.ts";

/**
 * Blocks rendering until the preflight result is known and the fonts are in.
 * During a real render `resolved` arrives through props (computed once in
 * `calculateMetadata`); in the Studio it is computed here instead.
 */
function useReady(props: VideoProps): Resolved | null {
	const { delayRender, continueRender } = useDelayRender();
	const [handle] = useState(() => delayRender("Loading fonts", { timeoutInMilliseconds: 60_000 }));
	const [resolved, setResolved] = useState<Resolved | null>(null);

	useEffect(() => {
		let cancelled = false;
		(async () => {
			const res = props.resolved ?? (await preflight(props));
			const fonts = [...new Set([res.fonts.heading, res.fonts.body, ...res.fonts.extra])];
			await Promise.all(
				fonts.map(async (font) => {
					if (font.faces.length === 0) return;
					for (let attempt = 1; attempt <= 3; attempt++) {
						try {
							await loadFaces(font.faces, 8000);
							return;
						} catch (err) {
							if (attempt === 3) console.warn(`[retween] font "${font.requested}" failed to load in a render tab (${err instanceof Error ? err.message : err}); using fallback`);
						}
					}
				}),
			);
			const { heading, body } = props.timeline.theme.fonts;
			await loadFallback(collectText(props.timeline), [heading.weight, body.weight, Math.max(700, body.weight)]);
			if (cancelled) return;
			setResolved(res);
			continueRender(handle);
		})().catch((err) => {
			// Font trouble must never stop a render: carry on with whatever is available.
			console.warn(`[retween] font setup failed (${err instanceof Error ? err.message : err}); using system fonts`);
			if (cancelled) return;
			setResolved(props.resolved ?? { media: {}, fonts: { heading: { requested: "", family: null, faces: [] }, body: { requested: "", family: null, faces: [] }, extra: [] }, warnings: [] });
			continueRender(handle);
		});
		return () => {
			cancelled = true;
		};
		// Props are fixed for the lifetime of a render tab.
	}, []);

	return resolved;
}

export const VideoComposition: React.FC<VideoProps> = (props) => {
	const { timeline, width, height } = props;
	const resolved = useReady(props);

	const ctx = useMemo<RenderContext | null>(() => {
		if (!resolved) return null;
		const frame = frameLayout(width, height);
		const { theme } = timeline;
		const wm = theme.watermark && mediaOk(resolved, theme.watermark.src) ? theme.watermark : null;
		const wmInfo = wm ? resolved.media[wm.src] : undefined;
		const wmBox = wm ? watermarkBox(frame, wm, wmInfo?.width && wmInfo.height ? wmInfo.width / wmInfo.height : 3) : null;
		return {
			timeline,
			theme,
			fps: timeline.fps,
			frame,
			u: frame.u,
			pace: PACE[theme.motion.energy],
			anim: theme.motion.textAnimation,
			fonts: {
				heading: fontStack(resolved.fonts.heading, resolved.fonts.extra),
				body: fontStack(resolved.fonts.body, resolved.fonts.extra),
			},
			resolved,
			caption: theme.captions.enabled && timeline.captions.length > 0 ? captionLayout(frame, theme.captions, wmBox) : null,
			watermark: wmBox,
		};
	}, [resolved, timeline, width, height]);

	if (!ctx) return <AbsoluteFill style={{ background: timeline.theme.colors.background }} />;

	const scenes = timeline.scenes;
	return (
		<RenderProvider value={ctx}>
			<AbsoluteFill style={{ background: timeline.theme.colors.background, ["--u" as string]: `${ctx.u}px` }}>
				{scenes.map((scene, i) => {
					// A scene stays up underneath the next one for as long as that one takes to enter.
					const next = scenes[i + 1];
					const end = scene.startFrame + scene.durationInFrames;
					const tail = next && next.transition.type !== "cut" && next.startFrame <= end ? Math.max(0, Math.min(next.transition.durationInFrames, timeline.durationInFrames - end)) : 0;
					const captioned = timeline.captions.some((cue) => cue.startFrame < end + tail && cue.endFrame > scene.startFrame);
					return (
						<Sequence key={scene.id} from={scene.startFrame} durationInFrames={scene.durationInFrames + tail} name={`${scene.type}:${scene.id}`}>
							<SceneLayer scene={scene} tail={tail} next={tail > 0 ? next : undefined} captioned={captioned} />
						</Sequence>
					);
				})}
				<Watermark />
				<Captions />
				<AudioLayer />
			</AbsoluteFill>
		</RenderProvider>
	);
};

/**
 * Applies the scene's entrance transition and, while it lingers under the
 * next scene, the matching exit move. Neither changes when anything happens:
 * the scene still starts exactly on `startFrame`.
 */
const SceneLayer: React.FC<{ scene: TimelineScene; tail: number; next?: TimelineScene; captioned: boolean }> = ({ scene, tail, next, captioned }) => {
	const { pace, theme, frame: layout, u } = useRender();
	const f = useCurrentFrame();
	const { type, durationInFrames: T } = scene.transition;
	const p = type === "cut" ? 1 : pace.transitionEase(progress(f, 0, T));
	const q = next ? pace.transitionEase(progress(f, scene.durationInFrames, tail)) : 0;

	const style: React.CSSProperties = {};
	const transforms: string[] = [];
	let edge: React.ReactNode = null;

	if (p < 1) {
		switch (type) {
			case "fade":
				style.opacity = p;
				break;
			case "slide-left":
				transforms.push(`translateX(${(1 - p) * 100}%)`);
				break;
			case "slide-up":
				transforms.push(`translateY(${(1 - p) * 100}%)`);
				break;
			case "wipe": {
				style.clipPath = `inset(0 ${(1 - p) * 100}% 0 0)`;
				// A brand-coloured leading edge travels with the wipe.
				const w = 10 * u;
				edge = <div style={{ position: "absolute", top: 0, bottom: 0, left: p * layout.width - w / 2, width: w, background: theme.colors.accent, opacity: Math.min(1, p * 8, (1 - p) * 8) }} />;
				break;
			}
			case "zoom":
				style.opacity = Math.min(1, p * 1.6);
				transforms.push(`scale(${1.22 - 0.22 * p})`);
				break;
		}
	}

	let dim = 0;
	if (q > 0 && next) {
		// What the outgoing scene does while the next one comes in over it.
		switch (next.transition.type) {
			case "slide-left":
				transforms.push(`translateX(${-q * 28}%)`);
				dim = q * 0.35;
				break;
			case "slide-up":
				transforms.push(`translateY(${-q * 28}%)`);
				dim = q * 0.35;
				break;
			case "zoom":
				transforms.push(`scale(${1 - 0.08 * q})`);
				break;
		}
	}
	if (transforms.length > 0) style.transform = transforms.join(" ");

	return (
		<>
			<AbsoluteFill style={style}>
				<Scene scene={scene} tail={tail} captioned={captioned} />
				{dim > 0 ? <AbsoluteFill style={{ background: `rgba(0, 0, 0, ${dim})` }} /> : null}
			</AbsoluteFill>
			{edge}
		</>
	);
};

const Watermark: React.FC = () => {
	const { theme, watermark } = useRender();
	const wm = theme.watermark;
	if (!wm || !watermark) return null;
	const { rect } = watermark;
	const left = wm.position.endsWith("left");
	return (
		<Img
			src={wm.src}
			style={{
				position: "absolute",
				left: rect.x,
				top: rect.y,
				width: rect.w,
				height: rect.h,
				objectFit: "contain",
				objectPosition: `${left ? "left" : "right"} ${wm.position.startsWith("top") ? "top" : "bottom"}`,
				opacity: wm.opacity,
			}}
		/>
	);
};
