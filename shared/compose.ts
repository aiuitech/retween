/**
 * Compose: storyboard + landed media → timeline.
 *
 * This runs only after narration and footage exist, and every frame number it
 * writes comes from a measured duration: a scene lasts as long as its
 * narration takes to say, bullets appear on the word that cues them, captions
 * follow the voice's own word timestamps, and music ducks exactly where
 * someone is speaking.
 *
 * Pure function: no I/O, so it can be tested and reasoned about on its own.
 */
import { type BrandKit, DEFAULTS, resolveTheme } from "./brand.ts";
import type { SpokenWord } from "./narration.ts";
import type { Scene, SceneVisual, Storyboard } from "./storyboard.ts";
import {
	TIMELINE_VERSION,
	type SceneType,
	type Timeline,
	type TimelineAudio,
	type TimelineBackground,
	type TimelineCaption,
	type TimelineScene,
} from "./timeline.ts";

export interface ComposeAsset {
	id: string;
	kind: string;
	ready: boolean;
	durationSec?: number;
	words?: SpokenWord[];
}

export interface ResolvedRefs {
	narration: Record<string, { assetId: string; hash: string }>;
	visual: Record<string, { assetId: string; hash: string }>;
	sfx: Record<string, { assetId: string; hash: string }>;
	music?: { assetId: string; hash: string };
}

export interface ComposeInput {
	storyboard: Storyboard;
	brand: BrandKit;
	resolved: ResolvedRefs;
	assets: Map<string, ComposeAsset>;
	/**
	 * Draft mode: build a timeline even though media is missing. Narration that
	 * has not been voiced yet is estimated from its word count and visuals that
	 * do not exist yet fall back to the brand backdrop. Used for previews and
	 * length estimates before anything has been paid for.
	 */
	draft?: boolean;
}

export interface SceneTiming {
	id: string;
	type: SceneType;
	startSec: number;
	durationSec: number;
	narrationSec?: number;
}

export interface ComposeResult {
	/** Null when something required is missing; see `errors`. */
	timeline: Timeline | null;
	/** Problems that stop a timeline being built (usually media that has not been generated yet). */
	errors: string[];
	/** Things that were worked around and are worth a look. */
	warnings: string[];
	scenes: SceneTiming[];
	durationSec: number;
}

const LAYOUT_DEFAULTS: Record<SceneType, TimelineScene["layout"]> = {
	title: { align: "center", textPosition: "center", mediaSide: "right" },
	media: { align: "left", textPosition: "bottom", mediaSide: "right" },
	bullets: { align: "left", textPosition: "center", mediaSide: "right" },
	quote: { align: "center", textPosition: "center", mediaSide: "right" },
	stat: { align: "center", textPosition: "center", mediaSide: "right" },
	split: { align: "left", textPosition: "center", mediaSide: "right" },
	outro: { align: "center", textPosition: "center", mediaSide: "right" },
};

const normalise = (word: string) => word.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/** Index of the first word of `cue` within `words`, searching from `from`. */
function findCue(words: SpokenWord[], cue: string, from: number): number {
	const target = cue.split(/\s+/).map(normalise).filter(Boolean);
	if (!target.length) return -1;
	const spoken = words.map(([word]) => normalise(word));
	for (let i = from; i <= spoken.length - target.length; i++) {
		if (target.every((token, j) => spoken[i + j] === token)) return i;
	}
	return -1;
}

function countWords(scene: Scene): number {
	const text = scene.text;
	if (!text) return 0;
	const parts = [text.kicker, text.heading, text.subheading, text.body, text.quote, text.attribution, text.stat?.label, text.cta?.text];
	for (const bullet of text.bullets ?? []) parts.push(bullet.text);
	return parts.filter(Boolean).join(" ").split(/\s+/).filter(Boolean).length;
}

/** Groups spoken words into caption lines, breaking on punctuation, pauses and line length. */
function captionCues(words: SpokenWord[], maxWords: number): SpokenWord[][] {
	const cues: SpokenWord[][] = [];
	let current: SpokenWord[] = [];
	words.forEach((word, i) => {
		current.push(word);
		const next = words[i + 1];
		const sentenceEnd = /[.!?…]["')\]]?$/.test(word[0]);
		const clauseEnd = /[,;:—–]$/.test(word[0]) && current.length >= 3;
		const pause = next ? next[1] - word[2] > 0.55 : false;
		if (!next || sentenceEnd || clauseEnd || pause || current.length >= maxWords) {
			cues.push(current);
			current = [];
		}
	});
	return cues;
}

export function composeTimeline(input: ComposeInput): ComposeResult {
	const { storyboard, brand, resolved, assets, draft = false } = input;
	const errors: string[] = [];
	const warnings: string[] = [];
	/** Missing media stops a real compose but is only noted in a draft. */
	const missing = (message: string) => (draft ? warnings : errors).push(message);
	const fps = brand.format?.fps ?? DEFAULTS.fps;
	const frames = (seconds: number) => Math.max(0, Math.round(seconds * fps));

	const ready = (assetId: string | undefined, kinds?: string[]): ComposeAsset | undefined => {
		const asset = assetId ? assets.get(assetId) : undefined;
		if (!asset?.ready) return undefined;
		if (kinds && !kinds.includes(asset.kind)) return undefined;
		return asset;
	};
	const src = (assetId: string) => `asset://${assetId}`;

	const theme = resolveTheme({ ...brand, captions: { ...brand.captions, ...storyboard.captions } }, (id) => (ready(id) ? src(id) : undefined));
	const captionSettings = { ...brand.captions, ...storyboard.captions };
	const maxCaptionWords = captionSettings.maxWordsPerLine ?? DEFAULTS.captionWords;

	const scenes: TimelineScene[] = [];
	const audio: TimelineAudio[] = [];
	const captions: TimelineCaption[] = [];
	const timings: SceneTiming[] = [];
	const narrationRanges: [number, number][] = [];
	let cursor = 0;

	storyboard.scenes.forEach((scene, index) => {
		const label = `Scene "${scene.id}"`;

		// --- narration -------------------------------------------------------
		let narration: ComposeAsset | undefined;
		let estimatedSec = 0;
		if (scene.narration?.trim()) {
			narration = ready(resolved.narration[scene.id]?.assetId, ["audio"]);
			if (!narration) {
				missing(`${label}: narration has not been generated yet`);
				const spokenWords = scene.narration.trim().split(/\s+/).length;
				estimatedSec = (spokenWords / (brand.narration?.wordsPerMinute ?? 155)) * 60;
			}
		}
		const words = narration?.words ?? [];
		const narrationSec = narration ? (narration.durationSec ?? words.at(-1)?.[2] ?? 0) : estimatedSec;
		const hasVoice = Boolean(narration) || estimatedSec > 0;
		const leadIn = (scene.timing?.leadInMs ?? brand.format?.leadInMs ?? DEFAULTS.leadInMs) / 1000;
		const tail = (scene.timing?.tailMs ?? brand.format?.tailMs ?? DEFAULTS.tailMs) / 1000;

		// --- visual ----------------------------------------------------------
		const background = resolveBackground(scene, label);

		// --- duration --------------------------------------------------------
		const minSeconds = scene.timing?.minSeconds ?? brand.format?.minSceneSeconds ?? DEFAULTS.minSceneSeconds;
		const maxSeconds = brand.format?.maxSceneSeconds ?? DEFAULTS.maxSceneSeconds;
		let seconds: number;
		if (scene.timing?.seconds) {
			seconds = scene.timing.seconds;
			if (narration && leadIn + narrationSec > seconds + 0.05) {
				warnings.push(
					`${label}: narration runs ${narrationSec.toFixed(1)}s but the scene is fixed at ${seconds}s, so the voice is cut off. Remove timing.seconds to fit it.`,
				);
			}
		} else if (hasVoice) {
			seconds = Math.max(minSeconds, leadIn + narrationSec + tail);
			if (seconds > maxSeconds) {
				warnings.push(`${label}: runs ${seconds.toFixed(1)}s, longer than the ${maxSeconds}s the brand allows per scene. Consider splitting it.`);
			}
		} else {
			const clip = background.kind === "video" ? ready(background.src.replace("asset://", "")) : undefined;
			const clipSec = clip?.durationSec ? clip.durationSec - (background.kind === "video" ? background.startFromSec : 0) : 0;
			const readingSec = 1.4 + countWords(scene) / 2.6;
			const typeSec = scene.type === "outro" ? 4 : scene.type === "title" ? 3 : 2.5;
			seconds = clipSec > 0 ? Math.min(clipSec, 8) : Math.max(typeSec, readingSec);
			seconds = Math.min(Math.max(minSeconds, seconds), maxSeconds);
		}
		const durationInFrames = Math.max(1, frames(seconds));
		const startFrame = cursor;
		cursor += durationInFrames;

		// --- transition ------------------------------------------------------
		const transitionType = scene.transition?.type ?? (index === 0 ? "cut" : (brand.motion?.transition ?? DEFAULTS.transition));
		const transitionMs = scene.transition?.ms ?? brand.motion?.transitionMs ?? DEFAULTS.transitionMs;
		const transitionFrames = transitionType === "cut" ? 0 : Math.min(frames(transitionMs / 1000), Math.floor(durationInFrames / 2));

		// --- narration audio + captions -------------------------------------
		if (narration) {
			const narrationStart = startFrame + frames(leadIn);
			const available = startFrame + durationInFrames - narrationStart;
			const length = scene.timing?.seconds ? Math.min(frames(narrationSec) + 2, available) : frames(narrationSec) + 2;
			if (length > 0) {
				audio.push({
					id: `narration-${scene.id}`,
					kind: "narration",
					src: src(narration.id),
					startFrame: narrationStart,
					durationInFrames: length,
					trimStartSec: 0,
					volume: 1,
					loop: false,
					fadeInFrames: 0,
					fadeOutFrames: 0,
				});
				narrationRanges.push([narrationStart, narrationStart + length]);
			}
			const sceneEnd = startFrame + durationInFrames;
			const cues = captionCues(words, maxCaptionWords);
			cues.forEach((cue, i) => {
				const first = cue[0]!;
				const last = cue.at(-1)!;
				const nextStart = cues[i + 1]?.[0]?.[1];
				// Hold a line until the next one starts when the gap is short, so captions do not flicker.
				const holdUntil = nextStart !== undefined && nextStart - last[2] < 0.4 ? nextStart : last[2] + 0.15;
				const cueStart = narrationStart + frames(first[1]);
				const cueEnd = Math.min(sceneEnd, narrationStart + frames(holdUntil));
				if (cueEnd <= cueStart) return;
				captions.push({
					startFrame: cueStart,
					endFrame: cueEnd,
					text: cue.map(([word]) => word).join(" "),
					words: cue.map(([word, start, end]) => ({
						text: word,
						startFrame: Math.min(cueEnd, narrationStart + frames(start)),
						endFrame: Math.min(cueEnd, Math.max(narrationStart + frames(start) + 1, narrationStart + frames(end))),
					})),
				});
			});
		}

		// --- bullets, cued to the voice --------------------------------------
		const bullets = scene.text?.bullets;
		let timedBullets: { text: string; atFrame: number }[] | undefined;
		if (bullets?.length) {
			let searchFrom = 0;
			let previous = -1;
			timedBullets = bullets.map((bullet, i) => {
				let atSec: number | undefined;
				if (bullet.cue && words.length) {
					const found = findCue(words, bullet.cue, searchFrom);
					if (found >= 0) {
						atSec = leadIn + words[found]![1] - 0.12;
						searchFrom = found + 1;
					} else {
						warnings.push(`${label}: bullet ${i + 1} cue "${bullet.cue}" was not found in the narration; it is spaced evenly instead`);
					}
				}
				if (atSec === undefined) {
					atSec = hasVoice
						? leadIn + (narrationSec * i) / bullets.length
						: 0.4 + (Math.max(0.5, seconds - 1.2) * i) / bullets.length;
				}
				const atFrame = Math.min(durationInFrames - 1, Math.max(previous + 1, frames(Math.max(0, atSec))));
				previous = atFrame;
				return { text: bullet.text, atFrame };
			});
		}

		// --- sound effects ---------------------------------------------------
		scene.sfx?.forEach((effect, i) => {
			const assetId = effect.assetId ?? resolved.sfx[`${scene.id}:${i}`]?.assetId;
			const asset = ready(assetId, ["audio"]);
			if (!asset) {
				warnings.push(`${label}: sound effect ${i + 1} is not available and was left out`);
				return;
			}
			const length = Math.max(1, frames(asset.durationSec ?? 2));
			const at = effect.at ?? "start";
			const offset = at === "start" ? 0 : at === "end" ? Math.max(0, durationInFrames - length) : frames(at);
			audio.push({
				id: `sfx-${scene.id}-${i}`,
				kind: "sfx",
				src: src(asset.id),
				startFrame: startFrame + Math.min(offset, durationInFrames - 1),
				durationInFrames: length,
				trimStartSec: 0,
				volume: effect.volume ?? 0.8,
				loop: false,
				fadeInFrames: 0,
				fadeOutFrames: Math.min(length, frames(0.15)),
			});
		});

		const text = scene.text ?? {};
		scenes.push({
			id: scene.id,
			type: scene.type,
			startFrame,
			durationInFrames,
			transition: { type: transitionType, durationInFrames: transitionFrames },
			background,
			layout: { ...LAYOUT_DEFAULTS[scene.type], ...scene.layout },
			content: {
				kicker: text.kicker,
				heading: text.heading,
				subheading: text.subheading,
				body: text.body,
				bullets: timedBullets,
				quote: text.quote,
				attribution: text.attribution,
				stat: text.stat,
				cta: text.cta,
				lowerThird: text.lowerThird,
				showLogo: text.showLogo ?? (scene.type === "outro" ? true : undefined),
			},
		});
		timings.push({
			id: scene.id,
			type: scene.type,
			startSec: startFrame / fps,
			durationSec: durationInFrames / fps,
			narrationSec: hasVoice ? narrationSec : undefined,
		});
	});

	function resolveBackground(scene: Scene, label: string): TimelineBackground {
		const visual: SceneVisual | undefined = scene.visual;
		if (!visual || visual.source === "brand") return { kind: "brand" };
		if (visual.source === "solid") return { kind: "solid", color: visual.color ?? theme.colors.background };
		if (visual.source === "gradient") {
			return { kind: "gradient", colors: visual.colors ?? [theme.colors.primary, theme.colors.secondary], angle: visual.angle ?? 135 };
		}
		const assetId = visual.source === "asset" ? visual.assetId : resolved.visual[scene.id]?.assetId;
		const asset = ready(assetId, ["image", "video"]);
		if (!asset) {
			if (visual.source === "asset") {
				const exists = assetId ? assets.get(assetId) : undefined;
				missing(
					exists
						? `${label}: asset ${assetId} is ${exists.ready ? `a ${exists.kind}, not an image or video` : "not ready"}`
						: `${label}: asset ${assetId} does not exist in this project`,
				);
			} else {
				missing(`${label}: its ${visual.source === "stock" ? "stock media" : visual.source} has not been generated yet`);
			}
			return { kind: "brand" };
		}
		if (asset.kind === "image") {
			return { kind: "image", src: src(asset.id), fit: visual.fit ?? "cover", focus: visual.focus };
		}
		return {
			kind: "video",
			src: src(asset.id),
			fit: visual.fit ?? "cover",
			startFromSec: visual.startFromSec ?? 0,
			loop: visual.loop ?? true,
			volume: visual.volume ?? 0,
			playbackRate: 1,
			focus: visual.focus,
		};
	}

	const total = cursor;
	if (!storyboard.scenes.length) errors.push("The storyboard has no scenes");

	// --- music bed, ducked under the voice ------------------------------------
	const music = storyboard.music;
	if (music?.enabled !== false && total > 0) {
		const musicId = music?.assetId ?? resolved.music?.assetId ?? brand.audio?.musicAssetId;
		const asset = ready(musicId, ["audio"]);
		if (musicId && !asset) {
			if (music?.assetId || brand.audio?.musicAssetId) warnings.push("The music bed is not available and was left out");
			else missing("Music has not been generated yet");
		}
		if (asset) {
			const volume = music?.volume ?? brand.audio?.musicVolume ?? DEFAULTS.musicVolume;
			const ducked = Math.min(volume, music?.duckedVolume ?? brand.audio?.duckedVolume ?? DEFAULTS.duckedVolume);
			// Merge ranges separated by less than a breath so the bed does not pump between sentences.
			const merged: [number, number][] = [];
			for (const [start, end] of narrationRanges) {
				const last = merged.at(-1);
				if (last && start - last[1] < frames(0.7)) last[1] = Math.max(last[1], end);
				else merged.push([start, end]);
			}
			audio.push({
				id: "music",
				kind: "music",
				src: src(asset.id),
				startFrame: 0,
				durationInFrames: total,
				trimStartSec: 0,
				volume,
				loop: true,
				fadeInFrames: Math.min(frames(0.6), Math.floor(total / 4)),
				fadeOutFrames: Math.min(frames(1.5), Math.floor(total / 3)),
				duck: merged.length ? { volume: ducked, ranges: merged, rampFrames: frames(0.3) } : undefined,
			});
		}
	}

	// --- sonic logo -----------------------------------------------------------
	const sting = (assetId: string | undefined, at: "start" | "end") => {
		const asset = ready(assetId, ["audio"]);
		if (!asset || total === 0) return;
		const length = Math.min(total, Math.max(1, frames(asset.durationSec ?? 2)));
		audio.push({
			id: `sting-${at}`,
			kind: "sfx",
			src: src(asset.id),
			startFrame: at === "start" ? 0 : total - length,
			durationInFrames: length,
			trimStartSec: 0,
			volume: 0.9,
			loop: false,
			fadeInFrames: 0,
			fadeOutFrames: Math.min(length, frames(0.2)),
		});
	};
	sting(brand.audio?.introStingAssetId, "start");
	sting(brand.audio?.outroStingAssetId, "end");

	const timeline: Timeline | null =
		errors.length || total === 0
			? null
			: { version: TIMELINE_VERSION, fps, durationInFrames: total, theme, scenes, audio, captions };

	return { timeline, errors, warnings, scenes: timings, durationSec: total / fps };
}
