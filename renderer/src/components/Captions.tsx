import type React from "react";
import { useMemo } from "react";
import { useCurrentFrame } from "remotion";
import { useRender } from "../context.ts";
import type { CaptionLayout } from "../lib/layout.ts";
import { progress } from "../lib/motion.ts";
import type { TimelineCaption } from "../types.ts";

type Word = { text: string; startFrame: number; endFrame: number; width: number };
type Page = { startFrame: number; endFrame: number; lines: Word[][] };

/** Cues without word timings get evenly spread ones, weighted by word length. */
function wordsOf(cue: TimelineCaption): Omit<Word, "width">[] {
	if (cue.words.length > 0) return cue.words.filter((w) => w.text.trim()).map((w) => ({ ...w, text: w.text.trim() }));
	const tokens = cue.text.split(/\s+/).filter(Boolean);
	const total = tokens.reduce((n, t) => n + t.length + 1, 0);
	const span = Math.max(1, cue.endFrame - cue.startFrame);
	let seen = 0;
	return tokens.map((text) => {
		const startFrame = cue.startFrame + Math.round((seen / total) * span);
		seen += text.length + 1;
		return { text, startFrame, endFrame: cue.startFrame + Math.round((seen / total) * span) };
	});
}

/**
 * Breaks each cue into pages of at most `maxLines` measured lines. A cue that
 * is too long for the band is shown as consecutive pages, each timed by the
 * words it contains - text is never shrunk to unreadable or cut off.
 */
function paginate(cues: TimelineCaption[], layout: CaptionLayout, font: string, letterSpacing: number, uppercase: boolean): { pages: Page[]; space: number } {
	const ctx = document.createElement("canvas").getContext("2d")!;
	ctx.font = font;
	ctx.letterSpacing = `${letterSpacing}px`;
	const space = ctx.measureText(" ").width;
	const pages: Page[] = [];

	for (const cue of cues) {
		const words: Word[] = wordsOf(cue).map((w) => {
			const text = uppercase ? w.text.toUpperCase() : w.text;
			return { ...w, text, width: ctx.measureText(text).width };
		});
		if (words.length === 0) continue;

		const breakInto = (maxWidth: number) => {
			const out: Word[][] = [];
			let line: Word[] = [];
			let lineWidth = 0;
			for (const word of words) {
				const next = line.length === 0 ? word.width : lineWidth + space + word.width;
				if (line.length > 0 && next > maxWidth) {
					out.push(line);
					line = [word];
					lineWidth = word.width;
				} else {
					line.push(word);
					lineWidth = next;
				}
			}
			if (line.length > 0) out.push(line);
			return out;
		};
		let lines = breakInto(layout.maxTextWidth);
		if (lines.length > 1) {
			// Balance: the narrowest measure that still gives the same number of lines, so no line is a lone word.
			let lo = Math.max(...words.map((w) => w.width));
			let hi = layout.maxTextWidth;
			for (let i = 0; i < 12; i++) {
				const mid = (lo + hi) / 2;
				if (breakInto(mid).length <= lines.length) hi = mid;
				else lo = mid;
			}
			lines = breakInto(hi);
		}

		const count = Math.ceil(lines.length / layout.maxLines);
		// Spread lines evenly so the last page is not a single orphaned line.
		const perPage = Math.ceil(lines.length / count);
		const cuePages: Page[] = [];
		for (let i = 0; i < lines.length; i += perPage) {
			const chunk = lines.slice(i, i + perPage);
			cuePages.push({ startFrame: i === 0 ? cue.startFrame : chunk[0]![0]!.startFrame, endFrame: cue.endFrame, lines: chunk });
		}
		// Each page of a cue ends where the next begins.
		cuePages.forEach((page, i) => {
			const following = cuePages[i + 1];
			if (following) page.endFrame = following.startFrame;
		});
		pages.push(...cuePages);
	}
	return { pages, space };
}

export const Captions: React.FC = () => {
	const { timeline, theme, caption, fonts, u, fps } = useRender();
	const frame = useCurrentFrame();
	const style = theme.captions;
	const weight = Math.max(700, theme.fonts.body.weight);
	const letterSpacing = caption ? caption.fontSize * (style.uppercase ? 0.03 : 0) : 0;

	const { pages, space } = useMemo(
		() =>
			caption
				? paginate(timeline.captions, caption, `${weight} ${caption.fontSize}px ${fonts.body}`, letterSpacing, style.uppercase)
				: { pages: [], space: 0 },
		[timeline.captions, caption, fonts.body, weight, letterSpacing, style.uppercase],
	);
	if (!caption) return null;

	let page: Page | undefined;
	for (const p of pages) if (frame >= p.startFrame && frame < p.endFrame) page = p;
	if (!page) return null;

	const boxed = style.background !== "none";
	const lineHeight = caption.fontSize * caption.lineHeight;
	const enter = progress(frame, page.startFrame, Math.max(1, fps * 0.1));
	const karaoke = style.mode === "karaoke";
	// The spoken word stays lit until the next one starts.
	let active: Word | undefined;
	if (karaoke) for (const line of page.lines) for (const word of line) if (frame >= word.startFrame) active = word;

	return (
		<div
			style={{
				position: "absolute",
				left: caption.band.x,
				top: caption.band.y,
				width: caption.band.w,
				height: caption.band.h,
				display: "flex",
				justifyContent: "center",
				alignItems: caption.position === "top" ? "flex-start" : caption.position === "bottom" ? "flex-end" : "center",
			}}
		>
			<div
				style={{
					padding: `${caption.padY}px ${caption.padX}px`,
					background: boxed ? "rgba(10, 10, 14, 0.8)" : undefined,
					borderRadius: style.background === "pill" ? lineHeight / 2 + caption.padY : style.background === "box" ? Math.min(theme.radius, 14) * u : 0,
					opacity: 0.35 + 0.65 * enter,
					transform: `translateY(${(1 - enter) * 8 * u}px)`,
					fontFamily: fonts.body,
					fontWeight: weight,
					fontSize: caption.fontSize,
					lineHeight: `${lineHeight}px`,
					letterSpacing,
					color: "#FFFFFF",
					// Without a plate, an outline plus a soft shadow keeps captions legible on any footage.
					WebkitTextStroke: boxed ? undefined : `${caption.fontSize * 0.11}px rgba(0, 0, 0, 0.82)`,
					paintOrder: "stroke fill",
					textShadow: boxed ? undefined : `0 ${caption.fontSize * 0.04}px ${caption.fontSize * 0.22}px rgba(0, 0, 0, 0.55)`,
				}}
			>
				{page.lines.map((line, i) => (
					<div key={i} style={{ display: "flex", justifyContent: "center", gap: space, whiteSpace: "nowrap", height: lineHeight }}>
						{line.map((word, j) => {
							const spoken = !karaoke || frame >= word.startFrame;
							return (
								<span key={j} style={{ color: word === active ? style.highlightColor : spoken ? "#FFFFFF" : "rgba(255, 255, 255, 0.5)" }}>
									{word.text}
								</span>
							);
						})}
					</div>
				))}
			</div>
		</div>
	);
};
