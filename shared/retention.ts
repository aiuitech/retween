/**
 * Where viewers left: YouTube's audience-retention curve laid over the scenes
 * of the export that was uploaded, so "people leave at 0:42" becomes "people
 * leave during scene 5, the second bullet list". Pure, no I/O.
 */
import type { Timeline } from "./timeline.ts";

/** One point of the curve: how far into the video (0–1), the share of viewers still watching (can pass 1 with rewatches), and how that compares with similar videos (0–1, 0.5 typical). */
export interface RetentionPoint {
	at: number;
	watching: number;
	relative?: number;
}

export interface SceneRetention {
	id: string;
	n: number;
	startSec: number;
	endSec: number;
	/** Share of viewers watching when the scene starts and when it ends. */
	start: number;
	end: number;
	/** Points of retention lost per 10 seconds of this scene: the rate, so long and short scenes compare fairly. */
	lossPer10s: number;
	/** How the scene held viewers against similar videos, when YouTube reports it. */
	relative?: number;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** The curve's value at a point, by straight lines between the points YouTube reports. */
export function watchingAt(curve: RetentionPoint[], at: number): number {
	if (!curve.length) return 0;
	const sorted = [...curve].sort((a, b) => a.at - b.at);
	if (at <= sorted[0]!.at) return sorted[0]!.watching;
	for (let i = 1; i < sorted.length; i++) {
		const a = sorted[i - 1]!;
		const b = sorted[i]!;
		if (at <= b.at) return a.watching + ((b.watching - a.watching) * (at - a.at)) / Math.max(1e-9, b.at - a.at);
	}
	return sorted.at(-1)!.watching;
}

export function sceneRetention(timeline: Timeline, curve: RetentionPoint[]): SceneRetention[] {
	const duration = timeline.durationInFrames / timeline.fps;
	return timeline.scenes.map((scene, i) => {
		const startSec = scene.startFrame / timeline.fps;
		const endSec = (scene.startFrame + scene.durationInFrames) / timeline.fps;
		const start = watchingAt(curve, startSec / duration);
		const end = watchingAt(curve, endSec / duration);
		const inside = curve.filter((point) => point.at >= startSec / duration && point.at <= endSec / duration && point.relative !== undefined);
		const relative = inside.length ? inside.reduce((sum, point) => sum + point.relative!, 0) / inside.length : undefined;
		return {
			id: scene.id,
			n: i + 1,
			startSec: Math.round(startSec * 10) / 10,
			endSec: Math.round(endSec * 10) / 10,
			start: round3(start),
			end: round3(end),
			lossPer10s: round3(((start - end) / Math.max(0.5, endSec - startSec)) * 10),
			...(relative !== undefined ? { relative: round3(relative) } : {}),
		};
	});
}

/** The scenes that lost viewers fastest, worst first. The opening is judged separately: every video loses people there. */
export function worstScenes(scenes: SceneRetention[], count = 3): SceneRetention[] {
	return [...scenes.slice(1)].filter((scene) => scene.lossPer10s > 0).sort((a, b) => b.lossPer10s - a.lossPer10s).slice(0, count);
}
