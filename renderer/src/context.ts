import { createContext, useContext } from "react";
import type { CaptionLayout, FrameLayout, WatermarkBox } from "./lib/layout.ts";
import type { Pace } from "./lib/motion.ts";
import type { Resolved, Timeline, TimelineTheme } from "./types.ts";

export type RenderContext = {
	timeline: Timeline;
	theme: TimelineTheme;
	fps: number;
	frame: FrameLayout;
	/** Design px -> output px. */
	u: number;
	pace: Pace;
	anim: TimelineTheme["motion"]["textAnimation"];
	fonts: { heading: string; body: string };
	resolved: Resolved;
	/** Null when captions are off or the timeline has none. */
	caption: CaptionLayout | null;
	/** Where the watermark sits, when there is a usable one. Scene content keeps clear of it. */
	watermark: WatermarkBox | null;
	/** Tags this copy's layout reports (see FitBox). Set on contact-sheet tiles. */
	probe?: string;
};

const Ctx = createContext<RenderContext | null>(null);
export const RenderProvider = Ctx.Provider;

export function useRender(): RenderContext {
	const ctx = useContext(Ctx);
	if (!ctx) throw new Error("RenderContext missing");
	return ctx;
}

/** A length in design px that follows the fitted scale of the enclosing <FitBox>. */
export const U = (n: number) => `calc(var(--u) * ${n})`;

export const mediaOk = (resolved: Resolved, src: string | undefined) => !!src && resolved.media[src]?.ok !== false;
