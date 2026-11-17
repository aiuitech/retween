import type React from "react";
import { useCurrentFrame } from "remotion";
import { U, useRender } from "../context.ts";
import { backOut, clamp01, progress } from "../lib/motion.ts";

type Anim = "fade" | "rise" | "pop" | "typewriter";

/** Opacity + transform for one animated unit at 0..1 progress. Layout is never touched. */
function unitStyle(anim: Anim, p: number, ease: (t: number) => number, rise: number, overshoot: number): React.CSSProperties {
	if (p >= 1) return { opacity: 1 };
	if (p <= 0) return { opacity: 0 };
	switch (anim) {
		case "rise":
			return { opacity: ease(clamp01(p * 1.5)), transform: `translateY(${U((1 - ease(p)) * rise)})` };
		case "pop":
			return { opacity: clamp01(p * 3), transform: `scale(${0.7 + 0.3 * backOut(ease(p), overshoot)})` };
		default:
			return { opacity: ease(p) };
	}
}

/**
 * A heading-like run of text, animated word by word (or character by
 * character for `typewriter`). The full text is always in the DOM, so the box
 * it occupies - and therefore wrapping and auto-fit - never changes.
 */
export const SplitText: React.FC<{
	text: string;
	/** Scene-local frame the animation starts on. */
	start: number;
	/** Overrides the theme's text animation. */
	anim?: Anim;
	caretColor?: string;
}> = ({ text, start, anim: animOverride, caretColor }) => {
	const { pace, fps, anim: themeAnim } = useRender();
	const frame = useCurrentFrame();
	const anim = animOverride ?? themeAnim;
	const words = text.split(/\s+/).filter(Boolean);

	if (anim === "typewriter") {
		const total = [...text.replace(/\s+/g, " ").trim()].length;
		const duration = typewriterSeconds(total, pace.cps) * fps;
		const shown = Math.floor(progress(frame, start, duration) * total + 1e-6);
		const typing = frame >= start && frame < start + duration + fps * 0.6;
		const caretOn = typing && (frame < start + duration || Math.floor(((frame - start - duration) / fps) * 3.2) % 2 === 0);
		let index = 0;
		return (
			<>
				{words.map((word, wi) => {
					const chars = [...word];
					const el = (
						<span key={wi} data-w style={{ display: "inline-block", whiteSpace: "pre" }}>
							{chars.map((ch, ci) => {
								const i = index + ci;
								const isLast = i === shown - 1;
								return (
									<span key={ci} style={{ opacity: i < shown ? 1 : 0, position: "relative" }}>
										{ch}
										{isLast && caretOn ? (
											<span
												style={{
													position: "absolute",
													left: "100%",
													top: "0.12em",
													bottom: "0.1em",
													width: "0.055em",
													marginLeft: "0.04em",
													background: caretColor ?? "currentColor",
												}}
											/>
										) : null}
									</span>
								);
							})}
						</span>
					);
					index += chars.length + 1;
					return [el, wi < words.length - 1 ? " " : null];
				})}
			</>
		);
	}

	const stagger = Math.min(pace.wordStagger, 0.7 / Math.max(1, words.length)) * fps;
	const duration = pace.duration * fps;
	return (
		<>
			{words.map((word, i) => [
				<span
					key={i}
					data-w
					style={{
						display: "inline-block",
						whiteSpace: "pre",
						transformOrigin: "50% 80%",
						...unitStyle(anim, progress(frame, start + i * stagger, duration), pace.ease, pace.rise, pace.overshoot),
					}}
				>
					{word}
				</span>,
				i < words.length - 1 ? " " : null,
			])}
		</>
	);
};

/** How long a typewriter run takes: characters / speed, capped so long text does not drag. */
export const typewriterSeconds = (chars: number, cps: number) => Math.min(1.8, chars / cps);

/** Animates a whole block (paragraphs, buttons, rules) as one unit. `typewriter` degrades to a fade. */
export const Reveal: React.FC<{
	start: number;
	anim?: Anim;
	style?: React.CSSProperties;
	origin?: string;
	children: React.ReactNode;
	block?: boolean;
}> = ({ start, anim: animOverride, style, origin, children, block }) => {
	const { pace, fps, anim: themeAnim } = useRender();
	const frame = useCurrentFrame();
	const anim = animOverride ?? themeAnim;
	const p = progress(frame, start, pace.duration * fps);
	const motion = unitStyle(anim === "typewriter" ? "fade" : anim, p, pace.ease, pace.rise * 0.7, pace.overshoot * 0.6);
	return (
		<div data-block={block ? "" : undefined} style={{ ...style, ...motion, transformOrigin: origin }}>
			{children}
		</div>
	);
};

/** A rule that draws itself in along one axis. */
export const Rule: React.FC<{
	start: number;
	axis: "x" | "y";
	origin: string;
	style: React.CSSProperties;
}> = ({ start, axis, origin, style }) => {
	const { pace, fps } = useRender();
	const frame = useCurrentFrame();
	const p = pace.ease(progress(frame, start, pace.duration * fps * 1.1));
	return <div style={{ ...style, transform: axis === "x" ? `scaleX(${p})` : `scaleY(${p})`, transformOrigin: origin }} />;
};
