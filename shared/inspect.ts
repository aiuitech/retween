/**
 * Looking at a video without watching it: which frames to show, when
 * everything happens, and what is likely to be wrong with it.
 *
 * Agents mostly read text and look at stills; they cannot watch an MP4 or
 * hear a mix. Everything here turns time and sound into one of those two.
 * Pure functions, no I/O.
 */
import type { Storyboard } from "./storyboard.ts";
import type { Timeline, TimelineScene } from "./timeline.ts";

export type Severity = "error" | "warning" | "info";

export interface Issue {
	severity: Severity;
	/** Short machine-friendly tag, e.g. `text-overflow`, `fast-narration`, `dead-air`. */
	kind: string;
	sceneId?: string;
	aspect?: string;
	atSec?: number;
	message: string;
	/** What to change, when there is a knob for it. */
	fix?: string;
}

const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2 };
export const sortIssues = (issues: Issue[]) => [...issues].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || (a.atSec ?? 0) - (b.atSec ?? 0));

export const round2 = (n: number) => Math.round(n * 100) / 100;
export const secondsAt = (frame: number, fps: number) => round2(frame / fps);

/** 83.4 -> "1:23.4" */
export function clock(seconds: number): string {
	const m = Math.floor(seconds / 60);
	const s = seconds - m * 60;
	return `${m}:${s < 10 ? "0" : ""}${s.toFixed(1)}`;
}

// --- frames to look at ---------------------------------------------------------

/** Scene-relative frames at which a scene's bullets, chart values and map places appear. */
function itemFrames(scene: TimelineScene): number[] {
	const c = scene.content;
	return [...(c.bullets ?? []), ...(c.chart?.points ?? []), ...(c.map?.places ?? [])].map((item) => item.atFrame);
}

/**
 * The absolute frame at which a scene looks finished: entrances are over and
 * the last bullet, chart value or map place has landed (plus a moment to
 * animate in). Falls back to 85% of the way through.
 */
export function settledFrame(scene: TimelineScene, fps: number): number {
	const items = itemFrames(scene);
	const lastItem = items.length ? Math.max(...items) + Math.round(fps * 0.7) : 0;
	const local = Math.max(Math.round(scene.durationInFrames * 0.85), lastItem);
	return scene.startFrame + Math.min(scene.durationInFrames - 1, local);
}

/** `count` frames spread evenly over [first, last], both ends included. */
export function spreadFrames(first: number, last: number, count: number): number[] {
	if (count <= 1 || last <= first) return [first];
	const frames = Array.from({ length: count }, (_, i) => Math.round(first + ((last - first) * i) / (count - 1)));
	return [...new Set(frames)];
}

/** The scene on screen at an absolute frame (the incoming one during a transition). */
export function sceneAt(timeline: Timeline, frame: number): TimelineScene {
	return timeline.scenes.findLast((scene) => scene.startFrame <= frame) ?? timeline.scenes[0]!;
}

/** The frame range [first, last] covering some scenes, from the first one's start to the last one's end. */
export function sceneRange(timeline: Timeline, sceneIds: string[]): [number, number] | null {
	const picked = timeline.scenes.filter((scene) => sceneIds.includes(scene.id));
	if (!picked.length) return null;
	return [picked[0]!.startFrame, picked.at(-1)!.startFrame + picked.at(-1)!.durationInFrames - 1];
}

// --- cue sheet ---------------------------------------------------------------------

export interface CueEvent {
	atSec: number;
	what: "bullet" | "chart value" | "place" | "sound effect";
	text: string;
	/** The narration words it was asked to land on. */
	cue?: string;
}

export interface CueScene {
	id: string;
	type: string;
	startSec: number;
	endSec: number;
	transition?: { type: string; seconds: number };
	narration?: { startSec: number; endSec: number; words: number; wordsPerMinute: number };
	/** Caption lines as spoken: a transcript with times. */
	lines?: { atSec: number; endSec: number; text: string }[];
	/** Every spoken word, when asked for. */
	words?: { atSec: number; text: string }[];
	events?: CueEvent[];
}

export interface CueSheet {
	fps: number;
	durationSec: number;
	scenes: CueScene[];
	music?: { startSec: number; endSec: number; volume: number; duckedVolume?: number; duckedStretches: number };
	stings: { atSec: number; seconds: number }[];
	/** Stretches of at least a second with nobody speaking. */
	unvoiced: { startSec: number; endSec: number; seconds: number; music: boolean }[];
}

/** Narration clips merged into the stretches where someone is speaking, in absolute frames. */
function voicedRanges(timeline: Timeline): [number, number][] {
	const ranges = timeline.audio
		.filter((clip) => clip.kind === "narration")
		.map((clip): [number, number] => [clip.startFrame, clip.startFrame + clip.durationInFrames])
		.sort((a, b) => a[0] - b[0]);
	const merged: [number, number][] = [];
	for (const range of ranges) {
		const last = merged.at(-1);
		if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
		else merged.push([...range]);
	}
	return merged;
}

/** Spoken words in a scene, from the captions (which carry the voice's own word timings). */
function spokenWords(timeline: Timeline, scene: TimelineScene) {
	const end = scene.startFrame + scene.durationInFrames;
	return timeline.captions.filter((cue) => cue.startFrame >= scene.startFrame && cue.startFrame < end).flatMap((cue) => cue.words);
}

export function cueSheet(timeline: Timeline, storyboard: Storyboard, options: { sceneIds?: string[]; words?: boolean } = {}): CueSheet {
	const { fps } = timeline;
	const at = (frame: number) => secondsAt(frame, fps);
	const boardScenes = new Map(storyboard.scenes.map((scene) => [scene.id, scene]));

	const scenes = timeline.scenes
		.filter((scene) => !options.sceneIds || options.sceneIds.includes(scene.id))
		.map((scene): CueScene => {
			const board = boardScenes.get(scene.id);
			const start = scene.startFrame;
			const end = start + scene.durationInFrames;
			const out: CueScene = { id: scene.id, type: scene.type, startSec: at(start), endSec: at(end) };
			if (scene.transition.type !== "cut") out.transition = { type: scene.transition.type, seconds: at(scene.transition.durationInFrames) };

			const clip = timeline.audio.find((candidate) => candidate.id === `narration-${scene.id}`);
			const words = spokenWords(timeline, scene);
			if (clip) {
				const first = words[0]?.startFrame ?? clip.startFrame;
				const last = words.at(-1)?.endFrame ?? clip.startFrame + clip.durationInFrames;
				const count = words.length || (board?.narration?.trim().split(/\s+/).length ?? 0);
				const spoken = Math.max(0.1, (last - first) / fps);
				out.narration = { startSec: at(first), endSec: at(last), words: count, wordsPerMinute: Math.round((count / spoken) * 60) };
				const lines = timeline.captions.filter((cue) => cue.startFrame >= start && cue.startFrame < end);
				if (lines.length) out.lines = lines.map((cue) => ({ atSec: at(cue.startFrame), endSec: at(cue.endFrame), text: cue.text }));
				if (options.words && words.length) out.words = words.map((word) => ({ atSec: at(word.startFrame), text: word.text }));
			}

			const events: CueEvent[] = [];
			const c = scene.content;
			c.bullets?.forEach((bullet, i) => events.push({ atSec: at(start + bullet.atFrame), what: "bullet", text: bullet.text, cue: board?.text?.bullets?.[i]?.cue }));
			c.chart?.points.forEach((point, i) =>
				events.push({ atSec: at(start + point.atFrame), what: "chart value", text: `${point.label}: ${point.value}`, cue: board?.chart?.data[i]?.cue }),
			);
			c.map?.places.forEach((place, i) => events.push({ atSec: at(start + place.atFrame), what: "place", text: place.name, cue: board?.map?.places[i]?.cue }));
			for (const sfx of timeline.audio.filter((candidate) => candidate.kind === "sfx" && candidate.id.startsWith(`sfx-${scene.id}-`))) {
				events.push({ atSec: at(sfx.startFrame), what: "sound effect", text: `${at(sfx.durationInFrames)}s` });
			}
			if (events.length) out.events = events.map((event) => (event.cue ? event : { atSec: event.atSec, what: event.what, text: event.text }));
			return out;
		});

	const music = timeline.audio.find((clip) => clip.kind === "music");
	const stings = timeline.audio.filter((clip) => clip.id.startsWith("sting-")).map((clip) => ({ atSec: at(clip.startFrame), seconds: at(clip.durationInFrames) }));

	const unvoiced: CueSheet["unvoiced"] = [];
	let cursor = 0;
	const musicPlays = (from: number, to: number) => Boolean(music && music.startFrame < to && music.startFrame + music.durationInFrames > from);
	for (const [from, to] of [...voicedRanges(timeline), [timeline.durationInFrames, timeline.durationInFrames] as [number, number]]) {
		if (from - cursor >= fps) unvoiced.push({ startSec: at(cursor), endSec: at(from), seconds: at(from - cursor), music: musicPlays(cursor, from) });
		cursor = Math.max(cursor, to);
	}

	return {
		fps,
		durationSec: at(timeline.durationInFrames),
		scenes,
		...(music
			? {
					music: {
						startSec: at(music.startFrame),
						endSec: at(music.startFrame + music.durationInFrames),
						volume: music.volume,
						duckedVolume: music.duck?.volume,
						duckedStretches: music.duck?.ranges.length ?? 0,
					},
				}
			: {}),
		stings,
		unvoiced,
	};
}

// --- pacing ---------------------------------------------------------------------------

/** Words a viewer has to read in a scene. */
function onScreenWords(scene: TimelineScene): number {
	const c = scene.content;
	const parts = [c.kicker, c.heading, c.subheading, c.body, c.quote, c.attribution, c.stat?.label, c.cta?.text, c.lowerThird?.title, c.lowerThird?.subtitle];
	for (const bullet of c.bullets ?? []) parts.push(bullet.text);
	return parts.filter(Boolean).join(" ").split(/\s+/).filter(Boolean).length;
}

const normalise = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}\s]+/gu, "").split(/\s+/).filter(Boolean);

/**
 * Timing problems that show up as a bad viewing experience: narration too
 * fast or too slow, more text than anyone can read in the time, items that
 * land just before a cut, scenes that flash by, and silence.
 */
export function pacingIssues(timeline: Timeline, storyboard: Storyboard): Issue[] {
	const { fps } = timeline;
	const issues: Issue[] = [];
	const sheet = cueSheet(timeline, storyboard);
	const byId = new Map(timeline.scenes.map((scene) => [scene.id, scene]));

	for (const cue of sheet.scenes) {
		const scene = byId.get(cue.id)!;
		const seconds = scene.durationInFrames / fps;
		const base = { sceneId: scene.id, atSec: cue.startSec };

		if (seconds < 1.5) {
			issues.push({ ...base, severity: "warning", kind: "short-scene", message: `Scene "${scene.id}" is on screen for only ${seconds.toFixed(1)}s.`, fix: "Add narration or set timing.minSeconds." });
		}

		// Measured from the first word to the last, so pauses between sentences do not count: natural speech lands around 150-190.
		const n = cue.narration;
		if (n && n.words >= 8) {
			if (n.wordsPerMinute > 200) {
				issues.push({
					...base,
					severity: "warning",
					kind: "fast-narration",
					message: `Scene "${scene.id}": narration runs at ${n.wordsPerMinute} words a minute, faster than is comfortable (150-190).`,
					fix: "Cut words from the narration, or set voice.speed below 1.",
				});
			} else if (n.wordsPerMinute < 115) {
				issues.push({ ...base, severity: "info", kind: "slow-narration", message: `Scene "${scene.id}": narration runs at ${n.wordsPerMinute} words a minute, which can feel slow.`, fix: "Raise voice.speed a little." });
			}
		}

		// Reading: about 4 words a second, after a beat to notice the text. Text that repeats the voice reads faster.
		const words = onScreenWords(scene);
		if (words > 12) {
			const spoken = new Set(normalise(storyboard.scenes.find((s) => s.id === scene.id)?.narration ?? ""));
			const c = scene.content;
			const shown = normalise([c.heading, c.subheading, c.body, c.quote, ...(c.bullets ?? []).map((b) => b.text)].filter(Boolean).join(" "));
			const echoed = shown.length ? shown.filter((word) => spoken.has(word)).length / shown.length : 0;
			const rate = echoed > 0.6 ? 5.5 : 4;
			const needed = 0.8 + words / rate;
			if (needed > seconds) {
				issues.push({
					...base,
					severity: needed > seconds * 1.5 ? "warning" : "info",
					kind: "too-much-text",
					message: `Scene "${scene.id}" shows ${words} words for ${seconds.toFixed(1)}s; reading them takes about ${needed.toFixed(1)}s.`,
					fix: "Trim the on-screen text, or lengthen the narration.",
				});
			}
		}

		// Items that land in the last moment are barely seen before the cut.
		const items = [
			...(scene.content.bullets ?? []).map((item, i) => ({ what: `bullet ${i + 1}`, atFrame: item.atFrame })),
			...(scene.content.chart?.points ?? []).map((item) => ({ what: `chart value "${item.label}"`, atFrame: item.atFrame })),
			...(scene.content.map?.places ?? []).map((item) => ({ what: `place "${item.name}"`, atFrame: item.atFrame })),
		];
		for (const item of items) {
			const left = (scene.durationInFrames - item.atFrame) / fps;
			if (left < 1) {
				issues.push({
					...base,
					atSec: secondsAt(scene.startFrame + item.atFrame, fps),
					severity: "warning",
					kind: "late-reveal",
					message: `Scene "${scene.id}": ${item.what} appears ${left.toFixed(1)}s before the scene ends, too late to take in.`,
					fix: "Give it an earlier cue, or raise timing.tailMs to hold the scene longer.",
				});
			}
		}
		const sorted = items.map((item) => item.atFrame).sort((a, b) => a - b);
		const crowded = sorted.some((frame, i) => i > 0 && frame - sorted[i - 1]! < fps * 0.35);
		if (crowded && scene.content.bullets?.length) {
			issues.push({ ...base, severity: "info", kind: "crowded-reveals", message: `Scene "${scene.id}": some items appear less than 0.35s apart.`, fix: "Spread their cues across the narration." });
		}
	}

	for (const gap of sheet.unvoiced) {
		const last = gap.endSec >= sheet.durationSec - 0.05;
		const first = gap.startSec === 0;
		if (!gap.music && gap.seconds >= 2 && !first) {
			issues.push({
				severity: "warning",
				kind: "dead-air",
				atSec: gap.startSec,
				sceneId: sceneAt(timeline, Math.round(gap.startSec * fps)).id,
				message: `${gap.seconds.toFixed(1)}s with no voice and no music from ${clock(gap.startSec)}${last ? " to the end" : ""}.`,
				fix: "Add narration or a music bed, or shorten the scene.",
			});
		} else if (gap.seconds >= 5 && !last && !first) {
			issues.push({
				severity: "info",
				kind: "long-pause",
				atSec: gap.startSec,
				sceneId: sceneAt(timeline, Math.round(gap.startSec * fps)).id,
				message: `${gap.seconds.toFixed(1)}s without narration from ${clock(gap.startSec)}.`,
			});
		}
	}
	return issues;
}

// --- layout ------------------------------------------------------------------------------

/** What a FitBox reported (see renderer/src/lib/report.ts). `probe` is the tile index. */
export interface FitReport {
	probe?: string;
	box: string;
	scale: number;
	squash: number;
}

/** Text that had to shrink to fit, as issues. `tile` tells which aspect ratio and time a tile showed. */
export function fitIssues(fits: FitReport[], tile: (index: number) => { aspect: string; atSec: number } | undefined): Issue[] {
	const issues: Issue[] = [];
	for (const fit of fits) {
		const where = tile(Number(fit.probe));
		const [sceneId, part = "text"] = fit.box.split("/");
		const what = part === "lower-third" ? "lower third" : "text";
		const base = { sceneId, aspect: where?.aspect, atSec: where?.atSec };
		const percent = Math.round(fit.scale * 100);
		if (fit.squash < 0.995) {
			issues.push({
				...base,
				severity: "error",
				kind: "text-overflow",
				message: `Scene "${sceneId}" (${where?.aspect ?? "?"}): the ${what} does not fit even at ${percent}% size and was squeezed to ${Math.round(fit.squash * 100)}%.`,
				fix: "Cut words, or split the scene.",
			});
		} else if (fit.scale < 0.6) {
			issues.push({
				...base,
				severity: "warning",
				kind: "text-shrunk",
				message: `Scene "${sceneId}" (${where?.aspect ?? "?"}): the ${what} was shrunk to ${percent}% to fit, which is hard to read on a phone.`,
				fix: "Shorten the text, or move some of it into the narration.",
			});
		} else if (fit.scale < 0.85) {
			issues.push({ ...base, severity: "info", kind: "text-shrunk", message: `Scene "${sceneId}" (${where?.aspect ?? "?"}): the ${what} was shrunk to ${percent}% to fit.` });
		}
	}
	return issues;
}

// --- sound ---------------------------------------------------------------------------------

/** The renderer's /audio result (see renderer/server/audio.ts). */
export interface AudioAnalysis {
	analysedSec: number;
	fromSec: number;
	mix: { lufs: number | null; peakDbfs: number | null; clippedMs: number; clipAtSec: number[] };
	stems: Partial<Record<"narration" | "music" | "sfx" | "clip", { lufs: number | null }>>;
	speechOverMusic: { medianLu: number | null; worstLu: number | null } | null;
	scenes: {
		id: string;
		startSec: number;
		endSec: number;
		mixLufs: number | null;
		narrationLufs: number | null;
		musicLufs: number | null;
		speechOverMusicLu: number | null;
		peakDbfs: number | null;
	}[];
	silences: { startSec: number; endSec: number }[];
	profile?: (number | null)[];
	skipped: { id: string; reason: string }[];
}

/** Online platforms play speech-led video at about -14 LUFS (YouTube turns louder videos down, and quieter ones are not turned up). */
export const TARGET_LUFS = -14;

export function audioIssues(analysis: AudioAnalysis, durationSec: number): Issue[] {
	const issues: Issue[] = [];
	const { mix } = analysis;
	if (mix.clippedMs > 0) {
		issues.push({
			severity: "error",
			kind: "clipping",
			atSec: mix.clipAtSec[0],
			message: `The mix clips for ${mix.clippedMs}ms (first at ${mix.clipAtSec.map(clock).join(", ")}).`,
			fix: "Lower the music volume (storyboard.music.volume) or the sound effects' volume.",
		});
	} else if (mix.peakDbfs !== null && mix.peakDbfs > -1) {
		issues.push({ severity: "warning", kind: "no-headroom", message: `Peaks reach ${mix.peakDbfs} dBFS; encoders can clip above -1 dBFS.`, fix: "Lower the music or sound effect volume a little." });
	}
	if (mix.lufs !== null) {
		if (mix.lufs < -20) {
			issues.push({
				severity: "warning",
				kind: "quiet",
				message: `The mix measures ${mix.lufs} LUFS, well under the ${TARGET_LUFS} LUFS platforms play at. It will sound quiet next to other videos.`,
			});
		} else if (mix.lufs > -10) {
			issues.push({ severity: "warning", kind: "loud", message: `The mix measures ${mix.lufs} LUFS; platforms will turn it down to about ${TARGET_LUFS} LUFS and it may sound squashed.` });
		}
	}
	const balance = analysis.speechOverMusic;
	if (balance?.medianLu !== null && balance?.medianLu !== undefined && balance.medianLu < 10) {
		issues.push({
			severity: "warning",
			kind: "music-too-loud",
			message: `While the narrator speaks, the voice is only ${balance.medianLu} LU above the music (aim for 12-20 LU).`,
			fix: "Lower storyboard.music.duckedVolume (or the brand's audio.duckedVolume).",
		});
	}
	for (const scene of analysis.scenes) {
		if (scene.speechOverMusicLu !== null && scene.speechOverMusicLu < 8 && !(balance?.medianLu !== null && balance?.medianLu !== undefined && balance.medianLu < 10)) {
			issues.push({
				severity: "warning",
				kind: "music-too-loud",
				sceneId: scene.id,
				atSec: scene.startSec,
				message: `Scene "${scene.id}": the voice is only ${scene.speechOverMusicLu} LU above the music.`,
				fix: "Lower storyboard.music.duckedVolume.",
			});
		}
	}
	// Narration takes recorded separately can land at different levels.
	const voiced = analysis.scenes.filter((scene) => scene.narrationLufs !== null) as (AudioAnalysis["scenes"][number] & { narrationLufs: number })[];
	if (voiced.length >= 3) {
		const levels = voiced.map((scene) => scene.narrationLufs).sort((a, b) => a - b);
		const middle = levels[Math.floor(levels.length / 2)]!;
		for (const scene of voiced) {
			const delta = Math.round((scene.narrationLufs - middle) * 10) / 10;
			if (Math.abs(delta) >= 3) {
				issues.push({
					severity: "warning",
					kind: "narration-level-jump",
					sceneId: scene.id,
					atSec: scene.startSec,
					message: `Scene "${scene.id}": the narration is ${Math.abs(delta)} LU ${delta > 0 ? "louder" : "quieter"} than in the other scenes.`,
					fix: `Re-voice it: video.prepare with regenerate { narration: true, sceneIds: ["${scene.id}"] }.`,
				});
			}
		}
	}
	for (const silence of analysis.silences) {
		const seconds = Math.round((silence.endSec - silence.startSec) * 10) / 10;
		const atEnd = silence.endSec >= analysis.fromSec + analysis.analysedSec - 0.2 && silence.endSec >= durationSec - 0.2;
		if (seconds >= 1.5 && !(atEnd && seconds < 3)) {
			issues.push({ severity: "warning", kind: "silence", atSec: silence.startSec, message: `Near silence for ${seconds}s from ${clock(silence.startSec)}.`, fix: "Add a music bed, or shorten the pause." });
		}
	}
	for (const skipped of analysis.skipped) {
		issues.push({ severity: "error", kind: "unreadable-audio", message: `Audio "${skipped.id}" could not be decoded (${skipped.reason}); it was left out of the measurement and may fail in the render too.` });
	}
	return issues;
}
