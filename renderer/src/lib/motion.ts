import { Easing, interpolate } from "remotion";
import type { TimelineTheme } from "../types.ts";

type Energy = TimelineTheme["motion"]["energy"];

export type Pace = {
	/** Seconds a single element takes to settle. */
	duration: number;
	/** Seconds between words of a split heading. */
	wordStagger: number;
	/** Seconds between stacked elements (kicker -> heading -> subheading ...). */
	beat: number;
	/** Travel distance for `rise`, in design px (1080 short side). */
	rise: number;
	/** Characters per second for `typewriter`. */
	cps: number;
	/** Seconds a stat takes to count up. */
	countUp: number;
	ease: (t: number) => number;
	/** Easing for scene transitions. */
	transitionEase: (t: number) => number;
	/** Spring-like overshoot for `pop`, 0 = none. */
	overshoot: number;
};

export const PACE: Record<Energy, Pace> = {
	calm: {
		duration: 0.95,
		wordStagger: 0.075,
		beat: 0.24,
		rise: 26,
		cps: 22,
		countUp: 1.7,
		ease: Easing.bezier(0.16, 1, 0.3, 1),
		transitionEase: Easing.bezier(0.45, 0, 0.25, 1),
		overshoot: 0,
	},
	balanced: {
		duration: 0.62,
		wordStagger: 0.045,
		beat: 0.15,
		rise: 38,
		cps: 34,
		countUp: 1.2,
		ease: Easing.bezier(0.2, 0.9, 0.25, 1),
		transitionEase: Easing.bezier(0.65, 0, 0.2, 1),
		overshoot: 0.6,
	},
	punchy: {
		duration: 0.38,
		wordStagger: 0.028,
		beat: 0.085,
		rise: 60,
		cps: 52,
		countUp: 0.8,
		ease: Easing.bezier(0.2, 1, 0.3, 1),
		transitionEase: Easing.bezier(0.83, 0, 0.17, 1),
		overshoot: 1.4,
	},
};

export const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** 0..1 progress of something that starts at `start` and lasts `duration` frames. */
export const progress = (frame: number, start: number, duration: number) =>
	duration <= 0 ? (frame >= start ? 1 : 0) : clamp01((frame - start) / duration);

/** Ease-out with overshoot (Robert Penner's "back"), `s` = amount. */
export const backOut = (t: number, s: number) => {
	const u = t - 1;
	return 1 + u * u * ((s + 1) * u + s);
};

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export { interpolate };
