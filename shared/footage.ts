/**
 * Footage: working with a person's own recording through its transcript.
 *
 * A recording is cut by quoting it. A scene names the first and last words of
 * the stretch it wants ("from 'so here is the thing' to 'every single time'"),
 * and the cut is placed in the pauses around those words, so no syllable is
 * clipped. Seconds work too, and are snapped to the nearest pause the same way.
 *
 * Pure functions: no I/O.
 */
import type { SpokenWord } from "./narration.ts";

/** Silence kept before the first word and after the last one of a cut, at most. */
const PAD_BEFORE = 0.08;
const PAD_AFTER = 0.16;

const normalise = (word: string) => word.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
const tokens = (text: string) => text.split(/\s+/).map(normalise).filter(Boolean);
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Formats seconds as m:ss.s */
export const stamp = (sec: number) => `${Math.floor(sec / 60)}:${(sec % 60).toFixed(1).padStart(4, "0")}`;

/** Every index where the words `phrase` start, from `from` onwards. Punctuation and case are ignored. */
export function findPhrase(words: SpokenWord[], phrase: string, from = 0): number[] {
	const target = tokens(phrase);
	if (!target.length) return [];
	const spoken = words.map(([word]) => normalise(word));
	const hits: number[] = [];
	for (let i = Math.max(0, from); i <= spoken.length - target.length; i++) {
		if (target.every((token, j) => spoken[i + j] === token)) hits.push(i);
	}
	return hits;
}

export interface RangeRequest {
	/** Seconds, or the first words of the stretch. */
	from?: number | string;
	/** Seconds, or the last words of the stretch. */
	to?: number | string;
	/** When the `from` words occur more than once, the first occurrence after this many seconds is used. */
	after?: number;
}

export interface ResolvedRange {
	startSec: number;
	endSec: number;
	/** The words inside the stretch, timed from its start. */
	words: SpokenWord[];
	warnings: string[];
}

/**
 * A cut at `sec` that clips no word: inside a word it moves to just before the
 * word (`side` start) or just after it (`side` end); in a pause it stays put.
 */
function snap(words: SpokenWord[], sec: number, side: "start" | "end", durationSec: number): number {
	const i = words.findIndex(([, start, end]) => sec > start && sec < end);
	if (i < 0) return Math.min(durationSec, Math.max(0, sec));
	return side === "start" ? startOfWord(words, i) : endOfWord(words, i, durationSec);
}

/** Start of a cut just before word `i`. */
const startOfWord = (words: SpokenWord[], i: number) => {
	const previousEnd = i > 0 ? words[i - 1]![2] : 0;
	return Math.max(0, words[i]![1] - Math.min(PAD_BEFORE, (words[i]![1] - previousEnd) / 2));
};
/** End of a cut just after word `i`. */
const endOfWord = (words: SpokenWord[], i: number, durationSec: number) => {
	const nextStart = i + 1 < words.length ? words[i + 1]![1] : durationSec;
	return Math.min(durationSec, words[i]![2] + Math.min(PAD_AFTER, Math.max(0, nextStart - words[i]![2]) / 2));
};

/** Text of the transcript around `sec`, for error messages that help find the right words. */
function nearby(words: SpokenWord[], sec: number): string {
	const i = words.findIndex(([, start]) => start >= sec);
	const at = i < 0 ? words.length - 1 : i;
	return words
		.slice(Math.max(0, at - 6), at + 6)
		.map(([word]) => word)
		.join(" ");
}

/**
 * Resolves a scene's `from` / `to` against the recording's transcript. Throws
 * (with a message that says what the transcript does contain) when quoted
 * words cannot be found.
 */
export function resolveRange(words: SpokenWord[], request: RangeRequest, durationSec: number): ResolvedRange {
	const warnings: string[] = [];
	let startSec = 0;
	let firstIndex = 0;
	const { from, to } = request;

	if (typeof from === "string") {
		const after = request.after ?? 0;
		const startAt = words.findIndex(([, start]) => start >= after - 0.05);
		const hits = startAt < 0 ? [] : findPhrase(words, from, startAt);
		if (!hits.length) {
			const anywhere = findPhrase(words, from);
			throw new RangeError(
				anywhere.length
					? `"${from}" is not said after ${stamp(after)}; it is said at ${anywhere.map((i) => stamp(words[i]![1])).join(", ")}`
					: `"${from}" is not in the transcript. Quote the words exactly as footage.transcript shows them.`,
			);
		}
		if (hits.length > 1 && request.after === undefined) {
			warnings.push(`"${from}" is said ${hits.length} times (at ${hits.slice(0, 4).map((i) => stamp(words[i]![1])).join(", ")}); the first was used. Add more words or set "after" to pick another.`);
		}
		firstIndex = hits[0]!;
		startSec = startOfWord(words, firstIndex);
	} else if (typeof from === "number") {
		if (from >= durationSec) throw new RangeError(`from ${from}s is past the end of the recording (${round2(durationSec)}s)`);
		startSec = snap(words, from, "start", durationSec);
		firstIndex = Math.max(0, words.findIndex(([, start]) => start >= startSec));
	} else if (words.length) {
		startSec = startOfWord(words, 0);
	}

	let endSec = durationSec;
	if (typeof to === "string") {
		const target = tokens(to);
		const hits = findPhrase(words, to, firstIndex);
		if (!hits.length) {
			const anywhere = findPhrase(words, to);
			throw new RangeError(
				anywhere.length
					? `"${to}" is only said before the start of this stretch (at ${anywhere.map((i) => stamp(words[i]![1])).join(", ")})`
					: `"${to}" is not in the transcript after ${stamp(startSec)}. Around there it says: "${nearby(words, startSec)}"`,
			);
		}
		endSec = endOfWord(words, hits[0]! + target.length - 1, durationSec);
	} else if (typeof to === "number") {
		endSec = snap(words, Math.min(to, durationSec), "end", durationSec);
	} else if (words.length && from === undefined) {
		endSec = endOfWord(words, words.length - 1, durationSec);
	}
	if (endSec <= startSec + 0.1) throw new RangeError(`the stretch from ${stamp(startSec)} to ${stamp(endSec)} is empty; "to" must come after "from"`);

	return { startSec: round2(startSec), endSec: round2(endSec), words: wordsBetween(words, startSec, endSec), warnings };
}

/** Words spoken inside [startSec, endSec], timed from startSec. A word cut in half is kept only if most of it is inside. */
export function wordsBetween(words: SpokenWord[], startSec: number, endSec: number): SpokenWord[] {
	const out: SpokenWord[] = [];
	for (const [word, start, end] of words) {
		const mid = (start + end) / 2;
		if (mid < startSec || mid > endSec) continue;
		out.push([word, round2(Math.max(0, start - startSec)), round2(Math.min(endSec, end) - startSec)]);
	}
	return out;
}

// --- reading a transcript ------------------------------------------------------------

export interface Paragraph {
	startSec: number;
	endSec: number;
	speaker?: string;
	text: string;
	/** Silence before this paragraph, when it is long enough to be worth knowing about. */
	pauseBeforeSec?: number;
}

/**
 * Groups words into paragraphs an agent can read and quote: a new one starts
 * when the speaker changes, after a pause, or at a sentence end once a
 * paragraph is long.
 */
export function paragraphs(words: SpokenWord[], speakers?: (string | undefined)[], options: { pauseSec?: number; maxWords?: number } = {}): Paragraph[] {
	const pause = options.pauseSec ?? 0.9;
	const max = options.maxWords ?? 60;
	const out: Paragraph[] = [];
	let current: { words: string[]; start: number; end: number; speaker?: string; pauseBefore?: number } | null = null;
	words.forEach(([word, start, end], i) => {
		const speaker = speakers?.[i];
		const gap = current ? start - current.end : start;
		const previous = current?.words.at(-1) ?? "";
		const sentenceEnded = /[.!?…]["')\]]?$/.test(previous);
		const breakHere =
			!current ||
			speaker !== current.speaker ||
			gap >= pause ||
			(sentenceEnded && current.words.length >= max * 0.6) ||
			current.words.length >= max * 1.5;
		if (breakHere) {
			if (current) out.push(finish(current));
			current = { words: [], start, end, speaker, pauseBefore: gap >= pause ? round2(gap) : undefined };
		}
		current!.words.push(word);
		current!.end = end;
	});
	if (current) out.push(finish(current));
	return out;

	function finish(p: { words: string[]; start: number; end: number; speaker?: string; pauseBefore?: number }): Paragraph {
		return { startSec: round2(p.start), endSec: round2(p.end), speaker: p.speaker, text: p.words.join(" "), pauseBeforeSec: p.pauseBefore };
	}
}

const srtTime = (sec: number) => {
	const ms = Math.max(0, Math.round(sec * 1000));
	const pad = (n: number, width = 2) => String(n).padStart(width, "0");
	return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor(ms / 60_000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
};

/** SubRip subtitles: lines of up to `maxWords` words, broken at punctuation and pauses. */
export function toSrt(words: SpokenWord[], maxWords = 10): string {
	const cues: SpokenWord[][] = [];
	let line: SpokenWord[] = [];
	words.forEach((word, i) => {
		line.push(word);
		const next = words[i + 1];
		if (!next || /[.!?…,;:]["')\]]?$/.test(word[0]) || next[1] - word[2] > 0.6 || line.length >= maxWords) {
			cues.push(line);
			line = [];
		}
	});
	return cues.map((cue, i) => `${i + 1}\n${srtTime(cue[0]![1])} --> ${srtTime(cue.at(-1)![2])}\n${cue.map(([w]) => w).join(" ")}\n`).join("\n");
}

/** Silences between words of at least `minSec`. */
export function pauses(words: SpokenWord[], minSec = 1.2): { startSec: number; endSec: number }[] {
	const out: { startSec: number; endSec: number }[] = [];
	for (let i = 1; i < words.length; i++) {
		const gap = words[i]![1] - words[i - 1]![2];
		if (gap >= minSec) out.push({ startSec: round2(words[i - 1]![2]), endSec: round2(words[i]![1]) });
	}
	return out;
}

const FILLERS = new Set(["um", "umm", "uh", "uhh", "er", "erm", "ah", "hmm", "mm"]);

/** Hesitation sounds ("um", "uh"), which are usually worth cutting around. */
export function fillers(words: SpokenWord[]): { atSec: number; word: string }[] {
	return words.filter(([word]) => FILLERS.has(normalise(word))).map(([word, start]) => ({ atSec: round2(start), word }));
}

export interface Retake {
	/** The abandoned attempt. */
	dropStartSec: number;
	dropEndSec: number;
	/** Where the attempt that replaces it starts. */
	keepStartSec: number;
	text: string;
}

/**
 * Restarted sentences: someone says "So the main reason we" and then, a few
 * seconds later, starts again with "So the main reason we built this...". The
 * earlier attempt is usually the one to drop.
 */
export function retakes(words: SpokenWord[], options: { minWords?: number; withinSec?: number } = {}): Retake[] {
	const minWords = options.minWords ?? 3;
	const within = options.withinSec ?? 25;
	const spoken = words.map(([word]) => normalise(word));
	// Starts of sentences or phrases: the first word, words after sentence ends or long pauses.
	const starts = words
		.map((_, i) => i)
		.filter((i) => i === 0 || /[.!?…,—-]["')\]]?$/.test(words[i - 1]![0]) || words[i]![1] - words[i - 1]![2] > 0.6);
	const out: Retake[] = [];
	let skipUntil = -1;
	for (const a of starts) {
		if (a < skipUntil) continue;
		for (const b of starts) {
			if (b <= a) continue;
			if (words[b]![1] - words[a]![1] > within) break;
			let n = 0;
			while (b + n < spoken.length && a + n < b && spoken[a + n] === spoken[b + n] && spoken[a + n]) n++;
			if (n >= minWords) {
				out.push({
					dropStartSec: round2(words[a]![1]),
					dropEndSec: round2(words[b - 1]![2]),
					keepStartSec: round2(words[b]![1]),
					text: words.slice(a, Math.min(b, a + 12)).map(([w]) => w).join(" "),
				});
				skipUntil = b;
				break;
			}
		}
	}
	return out;
}
