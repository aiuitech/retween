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
	/** The narration has not been voiced yet: this scene's length and cues are estimated from its word count. */
	estimated?: true;
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
			} else if (board?.narration?.trim() && !board.footage) {
				out.estimated = true;
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

		const board = storyboard.scenes.find((s) => s.id === scene.id);
		if (seconds < 1.5) {
			issues.push({
				...base,
				severity: "warning",
				kind: "short-scene",
				message: `Scene "${scene.id}" is on screen for only ${seconds.toFixed(1)}s.`,
				fix: board?.footage ? "Use a longer stretch of the footage, or join it to the next scene." : "Add narration or set timing.minSeconds.",
			});
		}

		// Measured from the first word to the last, so pauses between sentences do not count: natural speech lands around 150-190.
		const n = cue.narration;
		// The person's own recording is at their own pace: nothing to tune there.
		if (n && n.words >= 8 && !board?.footage) {
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
			const end = scene.startFrame + scene.durationInFrames;
			const said = board?.footage
				? timeline.captions.filter((caption) => caption.startFrame >= scene.startFrame && caption.startFrame < end).map((caption) => caption.text).join(" ")
				: (board?.narration ?? "");
			const spoken = new Set(normalise(said));
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

// --- structure: the opening, visual rhythm and sameness -------------------------------------

/** Whether a scene's picture moves on its own, so a long stretch of it is not a still frame. */
function moving(scene: TimelineScene): boolean {
	const bg = scene.background;
	return bg.kind === "video" || bg.kind === "lottie" || (bg.kind === "image" && bg.cutout?.mode === "parallax") || scene.type === "map";
}

/** Absolute frames at which something new appears on screen: cuts and every bullet, chart value and map place. */
function visualChanges(scene: TimelineScene): number[] {
	return [scene.startFrame, ...itemFrames(scene).map((frame) => scene.startFrame + frame)].sort((a, b) => a - b);
}

/** The longest stretch inside a scene with nothing new on screen, in frames, and where it starts. Zero for a moving picture. */
function longestStill(scene: TimelineScene): { frames: number; atFrame: number } {
	if (moving(scene)) return { frames: 0, atFrame: scene.startFrame };
	const changes = [...visualChanges(scene), scene.startFrame + scene.durationInFrames];
	let best = { frames: 0, atFrame: scene.startFrame };
	for (let i = 1; i < changes.length; i++) {
		const gap = changes[i]! - changes[i - 1]!;
		if (gap > best.frames) best = { frames: gap, atFrame: changes[i - 1]! };
	}
	return best;
}

/** Seconds of the opening within which viewers decide whether to stay. */
export const OPENING_SECONDS = 15;

/**
 * How the video holds attention, from its shape alone: how soon anyone speaks,
 * whether it opens on a title card, how long the picture stays unchanged, and
 * whether the same kind of scene repeats. These are prompts to look again, not
 * rules: a deliberate slow open is fine.
 */
export function structureIssues(timeline: Timeline, storyboard: Storyboard): Issue[] {
	const { fps } = timeline;
	const issues: Issue[] = [];
	const scenes = timeline.scenes;
	if (!scenes.length) return issues;
	const boardScenes = new Map(storyboard.scenes.map((scene) => [scene.id, scene]));

	// How soon the first word lands.
	const voiced = timeline.audio.filter((clip) => clip.kind === "narration");
	const firstWord = Math.min(
		...timeline.captions.flatMap((cue) => cue.words.map((word) => word.startFrame)),
		...(timeline.captions.length ? [] : voiced.map((clip) => clip.startFrame)),
	);
	if (voiced.length && Number.isFinite(firstWord) && firstWord / fps > 3) {
		issues.push({
			severity: "warning",
			kind: "slow-hook",
			atSec: 0,
			sceneId: scenes[0]!.id,
			message: `Nothing is said for the first ${(firstWord / fps).toFixed(1)}s. Viewers decide whether to stay in the opening seconds, and most watch with the sound on.`,
			fix: "Start the narration in the first scene (shorten timing.leadInMs), or open with a line that states the promise of the video.",
		});
	}

	// A title card with nothing said is a slow way in.
	const first = scenes[0]!;
	const firstBoard = boardScenes.get(first.id);
	if (first.type === "title" && !firstBoard?.narration?.trim() && !firstBoard?.footage && first.durationInFrames / fps > 2.5) {
		issues.push({
			severity: "info",
			kind: "title-card-open",
			sceneId: first.id,
			atSec: 0,
			message: `The video opens on a silent title card for ${(first.durationInFrames / fps).toFixed(1)}s.`,
			fix: "Open on the hook instead: say the most interesting thing first and let the title sit under it, or move the title later.",
		});
	}

	// Stretches where the picture does not change.
	const openingEnd = OPENING_SECONDS * fps;
	for (const scene of scenes) {
		const still = longestStill(scene);
		const seconds = still.frames / fps;
		const inOpening = still.atFrame < openingEnd;
		const base = { sceneId: scene.id, atSec: secondsAt(still.atFrame, fps) };
		if (inOpening && seconds > 7) {
			issues.push({
				...base,
				severity: "warning",
				kind: "slow-open",
				message: `Scene "${scene.id}": the picture does not change for ${seconds.toFixed(1)}s during the opening, where attention is easiest to lose.`,
				fix: "Split the scene, cue bullets or chart values through it, or give it a moving picture (a clip, footage, or a still with cutout \"parallax\").",
			});
		} else if (seconds > 20) {
			issues.push({ ...base, severity: "warning", kind: "static-stretch", message: `Scene "${scene.id}": ${seconds.toFixed(1)}s with nothing new on screen.`, fix: "Split it into two scenes with different pictures, or reveal its points as they are said." });
		} else if (seconds > 12) {
			issues.push({ ...base, severity: "info", kind: "static-stretch", message: `Scene "${scene.id}": ${seconds.toFixed(1)}s with nothing new on screen.`, fix: "Consider splitting it or revealing its points as they are said." });
		}
	}

	// The same kind of scene over and over.
	const signature = (scene: TimelineScene) => {
		const visual = boardScenes.get(scene.id)?.visual?.source ?? scene.background.kind;
		return scene.type === "media" || scene.type === "split" ? `${scene.type}:${visual}` : scene.type;
	};
	for (let i = 0; i < scenes.length; ) {
		let j = i + 1;
		while (j < scenes.length && signature(scenes[j]!) === signature(scenes[i]!)) j++;
		if (j - i >= 3) {
			issues.push({
				severity: "info",
				kind: "repetitive-run",
				sceneId: scenes[i]!.id,
				atSec: secondsAt(scenes[i]!.startFrame, fps),
				message: `${j - i} ${scenes[i]!.type} scenes in a row (${scenes.slice(i, j).map((scene) => scene.id).join(", ")}).`,
				fix: "Vary the rhythm: turn one into a stat, chart, quote or split scene, or change its picture.",
			});
		}
		i = j;
	}
	if (scenes.length >= 6) {
		const counts = new Map<string, number>();
		for (const scene of scenes) counts.set(scene.type, (counts.get(scene.type) ?? 0) + 1);
		const [type, count] = [...counts].sort((a, b) => b[1] - a[1])[0]!;
		if (count / scenes.length > 0.6) {
			issues.push({ severity: "info", kind: "one-note", message: `${count} of ${scenes.length} scenes are ${type} scenes.`, fix: "Mix in other scene types where the content allows: a stat for a number, a chart for a trend, a quote for a voice." });
		}
	}

	// Nowhere to go at the end.
	const hasCta = storyboard.scenes.some((scene) => scene.text?.cta) || scenes.at(-1)!.type === "outro";
	if (scenes.length >= 4 && !hasCta) {
		issues.push({ severity: "info", kind: "no-call-to-action", sceneId: scenes.at(-1)!.id, message: "The video ends without a call to action.", fix: "End on an outro scene, or give the last scene text.cta saying what to do next." });
	}
	return issues;
}

/** A storyboard's shape: the kind of each scene and where its picture comes from. */
export function storyboardShape(storyboard: Storyboard): string[] {
	return storyboard.scenes.map((scene) => `${scene.type}:${scene.footage ? "footage" : (scene.visual?.source ?? "brand")}`);
}

/** How alike two shapes are, 0–1: the longest common subsequence over the longer length. */
export function shapeSimilarity(a: string[], b: string[]): number {
	if (!a.length || !b.length) return 0;
	const row = new Array<number>(b.length + 1).fill(0);
	for (let i = 1; i <= a.length; i++) {
		let diagonal = 0;
		for (let j = 1; j <= b.length; j++) {
			const above = row[j]!;
			row[j] = a[i - 1] === b[j - 1] ? diagonal + 1 : Math.max(row[j]!, row[j - 1]!);
			diagonal = above;
		}
	}
	return row[b.length]! / Math.max(a.length, b.length);
}

const openingWords = (storyboard: Storyboard) =>
	normalise(storyboard.scenes.find((scene) => scene.narration?.trim())?.narration ?? "")
		.slice(0, 8)
		.join(" ");

/**
 * Whether this video looks like a copy of the project's other videos with the
 * words changed. YouTube does not pay for "inauthentic content": videos that
 * are generic, repetitive or made from one template with little variation.
 */
export function samenessIssues(storyboard: Storyboard, others: { title: string; storyboard: Storyboard }[]): Issue[] {
	const shape = storyboardShape(storyboard);
	if (shape.length < 5) return [];
	const issues: Issue[] = [];
	const alike = others.filter((other) => shapeSimilarity(shape, storyboardShape(other.storyboard)) >= 0.85);
	if (alike.length >= 2) {
		issues.push({
			severity: "warning",
			kind: "template-sameness",
			message: `This video has the same structure, scene for scene, as ${alike.length} others in the project (${alike.slice(0, 3).map((other) => `"${other.title}"`).join(", ")}${alike.length > 3 ? ", …" : ""}).`,
			fix: "Videos made from one template with only the words changed can be refused monetisation on YouTube as repetitive. Shape this one around its own content: a different opening, other scene types, its own pictures.",
		});
	}
	const opening = openingWords(storyboard);
	const sameOpening = opening.split(" ").length >= 5 ? others.filter((other) => openingWords(other.storyboard) === opening) : [];
	if (sameOpening.length) {
		issues.push({
			severity: "info",
			kind: "same-opening",
			sceneId: storyboard.scenes.find((scene) => scene.narration?.trim())?.id,
			message: `The narration opens with the same words as "${sameOpening[0]!.title}".`,
			fix: "Write an opening line for this video's own subject.",
		});
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

/**
 * `master` is the loudness exports are levelled to (brand audio.loudness), or null when they are not
 * levelled. A quiet or loud mix, or peaks without headroom, are then fixed in the render, so they are
 * reported as information rather than as warnings.
 */
export function audioIssues(analysis: AudioAnalysis, durationSec: number, master: { lufs: number; truePeak: number } | null = null): Issue[] {
	const issues: Issue[] = [];
	const { mix } = analysis;
	const levelled = master
		? ` Exports are levelled to ${master.lufs} LUFS with peaks under ${master.truePeak} dBTP (brand audio.loudness), so the rendered file will not have this problem.`
		: "";
	if (mix.clippedMs > 0) {
		issues.push({
			severity: "error",
			kind: "clipping",
			atSec: mix.clipAtSec[0],
			message: `The mix clips for ${mix.clippedMs}ms (first at ${mix.clipAtSec.map(clock).join(", ")}).`,
			fix: "Lower the music volume (storyboard.music.volume) or the sound effects' volume.",
		});
	} else if (mix.peakDbfs !== null && mix.peakDbfs > -1) {
		issues.push(
			master
				? { severity: "info", kind: "no-headroom", message: `Peaks in the mix reach ${mix.peakDbfs} dBFS.${levelled}` }
				: { severity: "warning", kind: "no-headroom", message: `Peaks reach ${mix.peakDbfs} dBFS; encoders can clip above -1 dBFS.`, fix: "Lower the music or sound effect volume a little, or set the brand's audio.loudness so exports are levelled and limited." },
		);
	}
	if (mix.lufs !== null) {
		if (mix.lufs < -20) {
			issues.push(
				master
					? { severity: "info", kind: "quiet", message: `The mix measures ${mix.lufs} LUFS.${levelled}` }
					: {
							severity: "warning",
							kind: "quiet",
							message: `The mix measures ${mix.lufs} LUFS, well under the ${TARGET_LUFS} LUFS platforms play at. It will sound quiet next to other videos.`,
							fix: `Set the brand's audio.loudness (e.g. ${TARGET_LUFS}) so exports are levelled to it.`,
						},
			);
		} else if (mix.lufs > -10) {
			issues.push(
				master
					? { severity: "info", kind: "loud", message: `The mix measures ${mix.lufs} LUFS.${levelled}` }
					: { severity: "warning", kind: "loud", message: `The mix measures ${mix.lufs} LUFS; platforms will turn it down to about ${TARGET_LUFS} LUFS and it may sound squashed.` },
			);
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
