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
import { resolveRange, stamp } from "./footage.ts";
import type { SpokenWord } from "./narration.ts";
import { type Scene, type SceneVisual, type Storyboard, iconName } from "./storyboard.ts";
import {
	TIMELINE_VERSION,
	type SceneType,
	type Timeline,
	type TimelineAudio,
	type TimelineBackground,
	type TimelineCaption,
	type TimelineIcon,
	type TimelineScene,
} from "./timeline.ts";

export interface ComposeAsset {
	id: string;
	kind: string;
	ready: boolean;
	durationSec?: number;
	words?: SpokenWord[];
	contentType?: string;
	/** Icons: true when the icon is a single-colour glyph that takes the scene's colours. */
	mono?: boolean;
	/** A processed recording: its levelled voice track and length. Its transcript is `words`. */
	footage?: { audioAssetId?: string; durationSec: number; hasVideo: boolean };
}

type Ref = { assetId: string; hash: string };

export interface ResolvedRefs {
	narration: Record<string, Ref>;
	visual: Record<string, Ref>;
	sfx: Record<string, Ref>;
	music?: Ref;
	/** `prefix:name` → icon file */
	icons?: Record<string, Ref>;
	/** scene id → the scene picture's subject, cut out */
	cutout?: Record<string, Ref>;
	/** `visual:<scene id>` or `sfx:<scene id>:<index>` → why it was left out (switched off in the account's cost controls). */
	withheld?: Record<string, string>;
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
	chart: { align: "left", textPosition: "center", mediaSide: "right" },
	map: { align: "left", textPosition: "top", mediaSide: "right" },
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
	const text = scene.text ?? {};
	const parts = [text.kicker, text.heading, text.subheading, text.body, text.quote, text.attribution, text.stat?.label, text.cta?.text];
	for (const bullet of text.bullets ?? []) parts.push(bullet.text);
	for (const point of scene.chart?.data ?? []) parts.push(point.label);
	for (const place of scene.map?.places ?? []) parts.push(place.name);
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

/** Relative luminance of a #rgb / #rrggbb colour (0 black … 1 white). */
function luminance(hex: string): number {
	const raw = hex.replace("#", "");
	const full = raw.length === 3 ? [...raw].map((c) => c + c).join("") : raw.slice(0, 6);
	const channel = (i: number) => {
		const v = parseInt(full.slice(i, i + 2), 16) / 255;
		return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
	};
	return /^[0-9a-f]{6}$/i.test(full) ? 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4) : 1;
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

	/** An icon named in the storyboard, once its file exists. Icons are decoration: a missing one is left out. */
	const icon = (name: string | undefined, label: string): TimelineIcon | undefined => {
		if (!name) return undefined;
		const key = iconName(name, brand.visual?.iconSet);
		const asset = ready(resolved.icons?.[key]?.assetId, ["image"]);
		if (asset) return { src: src(asset.id), mono: asset.mono ?? true };
		if (!draft) warnings.push(`${label}: icon "${key}" is not available and was left out`);
		return undefined;
	};
	const maxCaptionWords = captionSettings.maxWordsPerLine ?? DEFAULTS.captionWords;

	const scenes: TimelineScene[] = [];
	const audio: TimelineAudio[] = [];
	const captions: TimelineCaption[] = [];
	const timings: SceneTiming[] = [];
	const narrationRanges: [number, number][] = [];
	let cursor = 0;
	/** The previous scene, when it showed someone on camera: back-to-back cuts from one recording alternate their framing. */
	let lastSpeaker: { assetId: string; endSec: number; zoom: number } | undefined;

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
		let words = narration?.words ?? [];
		let narrationSec = narration ? (narration.durationSec ?? words.at(-1)?.[2] ?? 0) : estimatedSec;

		// --- the person's own recording, in place of narration ------------------
		const cut = scene.footage ? footageCut(scene, label) : undefined;
		if (cut) {
			words = cut.words;
			narrationSec = cut.endSec - cut.startSec;
		}
		const hasVoice = Boolean(narration) || estimatedSec > 0 || Boolean(cut);
		// A cut from a recording already carries its own breath before and after the words.
		const leadIn = (scene.timing?.leadInMs ?? (cut ? 0 : (brand.format?.leadInMs ?? DEFAULTS.leadInMs))) / 1000;
		const tail = (scene.timing?.tailMs ?? (cut ? 0 : (brand.format?.tailMs ?? DEFAULTS.tailMs))) / 1000;

		// --- visual ----------------------------------------------------------
		let background = resolveBackground(scene, label);
		let speakerZoom: number | undefined;
		if (cut?.speaker) {
			if (scene.visual && scene.visual.source !== "brand") warnings.push(`${label}: the footage is shown, so its visual is not used. Set footage.show to "voice" to keep the visual.`);
			const contiguous = lastSpeaker?.assetId === cut.assetId && Math.abs(lastSpeaker.endSec - cut.startSec) < 0.25;
			speakerZoom =
				scene.footage?.zoom ?? (lastSpeaker?.assetId === cut.assetId && !scene.transition ? (contiguous ? lastSpeaker.zoom : lastSpeaker.zoom > 1 ? 1 : 1.12) : 1);
			background = {
				kind: "video",
				src: src(cut.assetId),
				fit: "cover",
				// The picture starts as early as the lead-in, so lips and voice stay in sync.
				startFromSec: Math.max(0, cut.startSec - leadIn),
				loop: false,
				volume: 0,
				playbackRate: 1,
				focus: scene.footage?.focus ?? scene.visual?.focus,
				zoom: speakerZoom > 1 ? speakerZoom : undefined,
				look: scene.footage?.look,
			};
		}

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
		} else if (cut) {
			// Exactly the stretch: any longer and the picture would run on past the words.
			seconds = leadIn + narrationSec + tail;
		} else if (hasVoice) {
			seconds = Math.max(minSeconds, leadIn + narrationSec + tail);
			if (seconds > maxSeconds) {
				warnings.push(`${label}: runs ${seconds.toFixed(1)}s, longer than the ${maxSeconds}s the brand allows per scene. Consider splitting it.`);
			}
		} else {
			const clip = background.kind === "video" ? ready(background.src.replace("asset://", "")) : undefined;
			const clipSec = clip?.durationSec && background.kind === "video" ? (clip.durationSec - background.startFromSec) / background.playbackRate : 0;
			const readingSec = 1.4 + countWords(scene) / 2.6;
			const typeSec =
				scene.type === "outro"
					? 4
					: scene.type === "title"
						? 3
						: scene.type === "chart"
							? 3 + (scene.chart?.data.length ?? 0) * 0.3
							: scene.type === "map"
								? 2.5 + (scene.map?.places.length ?? 1) * (scene.map?.camera === "tour" ? 1.8 : 0.4)
								: 2.5;
			seconds = clipSec > 0 ? Math.min(clipSec, 8) : Math.max(typeSec, readingSec);
			seconds = Math.min(Math.max(minSeconds, seconds), maxSeconds);
		}
		const durationInFrames = Math.max(1, frames(seconds));
		const startFrame = cursor;
		cursor += durationInFrames;

		// --- transition ------------------------------------------------------
		// Someone talking to camera is cut, not faded: a dissolve between two takes looks like a mistake.
		const transitionType = scene.transition?.type ?? (index === 0 || cut?.speaker ? "cut" : (brand.motion?.transition ?? DEFAULTS.transition));
		const transitionMs = scene.transition?.ms ?? brand.motion?.transitionMs ?? DEFAULTS.transitionMs;
		const transitionFrames = transitionType === "cut" ? 0 : Math.min(frames(transitionMs / 1000), Math.floor(durationInFrames / 2));

		// --- narration audio + captions -------------------------------------
		const voiceSrc = cut ? cut.audioAssetId && src(cut.audioAssetId) : narration && src(narration.id);
		if (voiceSrc) {
			const narrationStart = startFrame + frames(leadIn);
			const available = startFrame + durationInFrames - narrationStart;
			const length = cut ? Math.min(frames(narrationSec), available) : scene.timing?.seconds ? Math.min(frames(narrationSec) + 2, available) : frames(narrationSec) + 2;
			if (length > 0) {
				// A cut out of a longer recording fades over a couple of frames so it does not click.
				const fade = cut ? Math.min(2, Math.floor(length / 4)) : 0;
				audio.push({
					id: `narration-${scene.id}`,
					kind: "narration",
					src: voiceSrc,
					startFrame: narrationStart,
					durationInFrames: length,
					trimStartSec: cut ? cut.startSec : 0,
					volume: cut ? (scene.footage?.volume ?? 1) : 1,
					loop: false,
					fadeInFrames: fade,
					fadeOutFrames: fade,
				});
				narrationRanges.push([narrationStart, narrationStart + length]);
			}
		}
		if (voiceSrc || (cut && draft)) {
			const narrationStart = startFrame + frames(leadIn);
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

		// --- bullets, chart values and map places, cued to the voice -------------
		/**
		 * Frame (scene-relative) each item appears on. An item with a cue lands on
		 * the first word of its cue; the rest are spaced out: `"narration"` spreads
		 * them across the whole voice-over (bullets, a map tour), `"brisk"` reveals
		 * them one after another early in the scene (chart values, map pins).
		 */
		const cueFrames = (items: { cue?: string }[], what: string, pacing: "narration" | "brisk"): number[] => {
			let searchFrom = 0;
			let previous = -1;
			const n = items.length;
			return items.map((item, i) => {
				let atSec: number | undefined;
				if (item.cue && words.length) {
					const found = findCue(words, item.cue, searchFrom);
					if (found >= 0) {
						atSec = leadIn + words[found]![1] - 0.12;
						searchFrom = found + 1;
					} else {
						warnings.push(`${label}: ${what} ${i + 1} cue "${item.cue}" was not found in the narration; it is spaced evenly instead`);
					}
				}
				if (atSec === undefined) {
					if (pacing === "narration") {
						atSec = hasVoice ? leadIn + (narrationSec * i) / n : 0.4 + (Math.max(0.5, seconds - 1.2) * i) / n;
					} else {
						const span = Math.min(n * 0.32, Math.max(0.3, (hasVoice ? narrationSec : seconds) * 0.55 - 0.6));
						atSec = 0.6 + (n > 1 ? (span * i) / (n - 1) : 0);
					}
				}
				const atFrame = Math.min(durationInFrames - 1, Math.max(previous + 1, frames(Math.max(0, atSec))));
				previous = atFrame;
				return atFrame;
			});
		};

		const bullets = scene.text?.bullets;
		let timedBullets: { text: string; atFrame: number; icon?: TimelineIcon }[] | undefined;
		if (bullets?.length) {
			const at = cueFrames(bullets, "bullet", "narration");
			timedBullets = bullets.map((bullet, i) => ({ text: bullet.text, atFrame: at[i]!, icon: icon(bullet.icon, label) }));
		}

		let chart: TimelineScene["content"]["chart"];
		if (scene.chart) {
			const at = cueFrames(scene.chart.data, "chart value", "brisk");
			chart = {
				kind: scene.chart.kind,
				points: scene.chart.data.map((point, i) => ({ label: point.label, value: point.value, atFrame: at[i]!, highlight: point.highlight })),
				prefix: scene.chart.prefix,
				suffix: scene.chart.suffix,
				decimals: scene.chart.decimals,
				max: scene.chart.max,
				showValues: scene.chart.showValues ?? true,
			};
		}

		let map: TimelineScene["content"]["map"];
		if (scene.map) {
			const camera = scene.map.camera ?? "overview";
			const at = cueFrames(scene.map.places, "place", camera === "tour" ? "narration" : "brisk");
			map = {
				places: scene.map.places.map((place, i) => ({ name: place.name, lat: place.lat, lng: place.lng, atFrame: at[i]! })),
				camera,
				route: scene.map.route ?? false,
				zoom: scene.map.zoom,
				style: scene.map.style ?? (luminance(theme.colors.background) < 0.4 ? "dark" : "light"),
			};
		}

		// --- sound effects ---------------------------------------------------
		scene.sfx?.forEach((effect, i) => {
			const assetId = effect.assetId ?? resolved.sfx[`${scene.id}:${i}`]?.assetId;
			const asset = ready(assetId, ["audio"]);
			if (!asset) {
				if (!resolved.withheld?.[`sfx:${scene.id}:${i}`]) warnings.push(`${label}: sound effect ${i + 1} is not available and was left out`);
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
				icon: icon(text.icon, label),
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
				chart,
				map,
			},
		});
		lastSpeaker = cut?.speaker ? { assetId: cut.assetId, endSec: cut.endSec, zoom: speakerZoom ?? 1 } : undefined;
		timings.push({
			id: scene.id,
			type: scene.type,
			startSec: startFrame / fps,
			durationSec: durationInFrames / fps,
			narrationSec: hasVoice ? narrationSec : undefined,
		});
	});

	/**
	 * The stretch of the person's recording a scene uses. Undefined when it
	 * cannot be used (the reason is recorded); in a draft, a recording that is
	 * still being processed is stood in for by its quoted length or a guess.
	 */
	function footageCut(
		scene: Scene,
		label: string,
	): { assetId: string; audioAssetId?: string; startSec: number; endSec: number; words: SpokenWord[]; speaker: boolean } | undefined {
		const footage = scene.footage!;
		const asset = assets.get(footage.assetId);
		const problem = !asset
			? `${label}: footage ${footage.assetId} does not exist in this project`
			: asset.kind !== "video" && asset.kind !== "audio"
				? `${label}: footage ${footage.assetId} is a ${asset.kind}, not a video or a recording`
				: !asset.ready
					? `${label}: footage ${footage.assetId} is still uploading`
					: !asset.footage
						? `${label}: footage ${footage.assetId} has not been processed yet (footage.get shows its progress; footage.process starts it)`
						: !asset.footage.audioAssetId
							? `${label}: footage ${footage.assetId} has no sound to use`
							: undefined;
		if (problem && (!draft || !asset || (asset.kind !== "video" && asset.kind !== "audio"))) {
			errors.push(problem);
			return undefined;
		}
		const hasVideo = asset!.footage?.hasVideo ?? asset!.kind === "video";
		const speaker = (footage.show ?? (hasVideo ? "speaker" : "voice")) === "speaker";
		if (speaker && !hasVideo) {
			errors.push(`${label}: footage ${footage.assetId} is sound only, so it cannot be shown; set footage.show to "voice"`);
			return undefined;
		}
		if (problem) {
			// Draft of footage that is not ready: seconds are taken as given, quoted words are guessed at.
			warnings.push(problem);
			const startSec = typeof footage.from === "number" ? footage.from : 0;
			const endSec = typeof footage.to === "number" ? footage.to : startSec + (asset!.durationSec ? Math.min(asset!.durationSec - startSec, 8) : 5);
			return { assetId: asset!.id, startSec, endSec: Math.max(endSec, startSec + 1), words: [], speaker };
		}
		try {
			const range = resolveRange(asset!.words ?? [], footage, asset!.footage!.durationSec);
			for (const warning of range.warnings) warnings.push(`${label}: ${warning}`);
			if (!range.words.length) warnings.push(`${label}: nothing is said between ${stamp(range.startSec)} and ${stamp(range.endSec)} of the recording`);
			// On a frame boundary, so the picture (trimmed by whole frames) and the voice start together.
			const startSec = Math.round(range.startSec * fps) / fps;
			const words = range.words.map(([word, start, end]): SpokenWord => [word, Math.max(0, start + range.startSec - startSec), end + range.startSec - startSec]);
			return { assetId: asset!.id, audioAssetId: asset!.footage!.audioAssetId, ...range, startSec, words, speaker };
		} catch (error) {
			(draft ? warnings : errors).push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
			return undefined;
		}
	}

	function resolveBackground(scene: Scene, label: string): TimelineBackground {
		const visual: SceneVisual | undefined = scene.visual;
		if (!visual || visual.source === "brand") return { kind: "brand" };
		if (visual.source === "solid") return { kind: "solid", color: visual.color ?? theme.colors.background };
		if (visual.source === "gradient") {
			return { kind: "gradient", colors: visual.colors ?? [theme.colors.primary, theme.colors.secondary], angle: visual.angle ?? 135 };
		}
		const assetId = visual.source === "asset" ? visual.assetId : resolved.visual[scene.id]?.assetId;
		const asset = ready(assetId, ["image", "video", "animation"]);
		if (!asset) {
			if (visual.source === "asset") {
				const exists = assetId ? assets.get(assetId) : undefined;
				missing(
					exists
						? `${label}: asset ${assetId} is ${exists.ready ? `a ${exists.kind}, not an image, video or animation` : "not ready"}`
						: `${label}: asset ${assetId} does not exist in this project`,
				);
			} else if (resolved.withheld?.[`visual:${scene.id}`]) {
				// Left out on purpose (cost controls); preparing already said so.
			} else {
				missing(`${label}: its ${visual.source === "stock" ? "stock media" : visual.source === "vector" ? "vector illustration" : visual.source} has not been generated yet`);
			}
			return { kind: "brand" };
		}
		if (visual.cutout && asset.kind !== "image") warnings.push(`${label}: cutout only works on still images, so it was ignored`);
		if (asset.kind === "animation") return { kind: "lottie", src: src(asset.id), loop: visual.loop ?? true };
		if (asset.kind === "image") {
			const svg = /svg/i.test(asset.contentType ?? "");
			const draw = svg ? (visual.draw ?? visual.source === "vector") : false;
			if (visual.draw && !svg) warnings.push(`${label}: draw only works on SVG pictures, so it was ignored`);
			let cutout: Extract<TimelineBackground, { kind: "image" }>["cutout"];
			if (visual.cutout) {
				const cut = ready(resolved.cutout?.[scene.id]?.assetId, ["image"]);
				if (cut) cutout = { src: src(cut.id), mode: visual.cutout };
				else if (!draft) warnings.push(`${label}: the cut-out of its picture is not available, so the whole picture is shown`);
			}
			return { kind: "image", src: src(asset.id), fit: visual.fit ?? "cover", focus: visual.focus, draw: draw || undefined, cutout, look: visual.look };
		}
		return {
			kind: "video",
			src: src(asset.id),
			fit: visual.fit ?? "cover",
			startFromSec: visual.startFromSec ?? 0,
			loop: visual.loop ?? true,
			volume: visual.volume ?? 0,
			playbackRate: visual.speed ?? 1,
			focus: visual.focus,
			look: visual.look,
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
