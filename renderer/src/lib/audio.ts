import type { TimelineAudio } from "../types.ts";

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/**
 * How ducked a clip is at an absolute frame: 0 = not at all, 1 = fully.
 * The clip is fully ducked for the whole of each [start, end] range; the ramps
 * sit just outside it, so the music is already down when the narration starts.
 */
export function duckAmount(duck: NonNullable<TimelineAudio["duck"]>, frame: number): number {
	const ramp = duck.rampFrames;
	let amount = 0;
	for (const [start, end] of duck.ranges) {
		if (frame >= start && frame <= end) return 1;
		if (ramp <= 0) continue;
		if (frame < start && frame > start - ramp) amount = Math.max(amount, 1 - (start - frame) / ramp);
		else if (frame > end && frame < end + ramp) amount = Math.max(amount, 1 - (frame - end) / ramp);
	}
	return amount;
}

/** The volume of `clip` at an absolute timeline frame. Pure: frame in, volume out. */
export function volumeAt(clip: TimelineAudio, frame: number): number {
	const local = frame - clip.startFrame;
	if (local < 0 || local >= clip.durationInFrames) return 0;

	let volume = clip.volume;
	if (clip.duck) volume += (clip.duck.volume - volume) * duckAmount(clip.duck, frame);

	// Fades multiply whatever the level is, so a ducked clip still fades cleanly.
	if (clip.fadeInFrames > 0) volume *= clamp01((local + 1) / clip.fadeInFrames);
	if (clip.fadeOutFrames > 0) volume *= clamp01((clip.durationInFrames - 1 - local) / clip.fadeOutFrames);
	return Math.max(0, volume);
}
