/**
 * Narration text → what the voice is sent, and voice timestamps → word timings.
 *
 * Pronunciation fixes change what is *spoken* ("SQL" → "sequel") but captions
 * must still show what was *written*. So the spoken text is built alongside a
 * map back to the original, and word timings are reported for original words.
 */

export interface Pronunciation {
	term: string;
	say: string;
}

/** A word of the original text and when it is spoken, in seconds. */
export type SpokenWord = [word: string, start: number, end: number];

interface Segment {
	/** Range in the original text. */
	start: number;
	end: number;
	/** Range in the spoken text. */
	spokenStart: number;
	spokenEnd: number;
	replaced: boolean;
}

export interface SpokenText {
	spoken: string;
	segments: Segment[];
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Applies pronunciation respellings (whole words, case-insensitive, longest term first). */
export function buildSpokenText(text: string, pronunciations: Pronunciation[] = []): SpokenText {
	const rules = pronunciations.filter((p) => p.term.trim() && p.say.trim()).sort((a, b) => b.term.length - a.term.length);
	if (!rules.length) {
		return { spoken: text, segments: [{ start: 0, end: text.length, spokenStart: 0, spokenEnd: text.length, replaced: false }] };
	}
	const pattern = new RegExp(`(?<![\\p{L}\\p{N}])(${rules.map((r) => escapeRegExp(r.term.trim())).join("|")})(?![\\p{L}\\p{N}])`, "giu");
	const say = new Map(rules.map((r) => [r.term.trim().toLowerCase(), r.say.trim()]));
	const segments: Segment[] = [];
	let spoken = "";
	let cursor = 0;
	const push = (start: number, end: number, value: string, replaced: boolean) => {
		if (end <= start) return;
		segments.push({ start, end, spokenStart: spoken.length, spokenEnd: spoken.length + value.length, replaced });
		spoken += value;
	};
	for (const match of text.matchAll(pattern)) {
		const index = match.index;
		push(cursor, index, text.slice(cursor, index), false);
		push(index, index + match[0].length, say.get(match[0].toLowerCase()) ?? match[0], true);
		cursor = index + match[0].length;
	}
	push(cursor, text.length, text.slice(cursor), false);
	return { spoken, segments };
}

/** Voice direction tags such as [whispers] are spoken cues, not caption text. */
const isDirectionTag = (word: string) => /^\[[^\]]*\]$/.test(word);

/**
 * Word timings for the original text, from character-level timestamps of the
 * spoken text. Falls back to the spoken words if the two cannot be lined up.
 */
export function wordTimings(
	text: string,
	spoken: SpokenText,
	alignment: { characters: string[]; starts: number[]; ends: number[] },
): SpokenWord[] {
	const { characters, starts, ends } = alignment;
	if (!characters.length) return [];
	const round = (n: number) => Math.round(n * 1000) / 1000;

	if (characters.length !== spoken.spoken.length) {
		// Unexpected normalisation by the voice model: report the words it actually aligned.
		const words: SpokenWord[] = [];
		let current = "";
		let wordStart = 0;
		characters.forEach((char, i) => {
			if (/\s/.test(char)) {
				if (current) words.push([current, round(wordStart), round(ends[i - 1] ?? wordStart)]);
				current = "";
			} else {
				if (!current) wordStart = starts[i] ?? 0;
				current += char;
			}
		});
		if (current) words.push([current, round(wordStart), round(ends[ends.length - 1] ?? wordStart)]);
		return words.filter(([word]) => !isDirectionTag(word));
	}

	/** Maps a range of the original text onto the spoken text. */
	const toSpoken = (start: number, end: number): [number, number] => {
		let from = Number.POSITIVE_INFINITY;
		let to = -1;
		for (const segment of spoken.segments) {
			if (segment.end <= start || segment.start >= end) continue;
			if (segment.replaced) {
				from = Math.min(from, segment.spokenStart);
				to = Math.max(to, segment.spokenEnd);
			} else {
				from = Math.min(from, segment.spokenStart + Math.max(0, start - segment.start));
				to = Math.max(to, segment.spokenStart + Math.min(segment.end, end) - segment.start);
			}
		}
		return [from, to];
	};

	const words: SpokenWord[] = [];
	for (const match of text.matchAll(/\S+/g)) {
		if (isDirectionTag(match[0])) continue;
		const [from, to] = toSpoken(match.index, match.index + match[0].length);
		if (to <= from || from >= starts.length) continue;
		words.push([match[0], round(starts[from]!), round(ends[Math.min(to, ends.length) - 1]!)]);
	}
	return words;
}

/**
 * Character-level timestamps for `spoken`, built from word timestamps of a
 * transcript of the recording (voices that give no alignment of their own).
 *
 * The transcript's words are lined up with the text's words by edit distance
 * on a normalised form, so "20" heard as "twenty" or a misheard name still
 * lands in place: a substituted word takes the heard word's time. Words the
 * transcript left out are spread over the gap around them by length. The
 * result has one entry per character of `spoken`, ready for `wordTimings`.
 */
export function alignmentFromWords(
	spoken: string,
	heard: { word: string; start: number; end: number }[],
	durationSec?: number,
): { characters: string[]; starts: number[]; ends: number[] } {
	const norm = (word: string) => word.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, "");
	const tokens = [...spoken.matchAll(/\S+/g)].map((match) => ({ index: match.index, text: match[0], key: norm(match[0]) }));
	const words = heard.map((word) => ({ ...word, key: norm(word.word) })).filter((word) => word.key);
	const n = tokens.length;
	const m = words.length;

	// Edit-distance alignment: cost[i][j] for the first i text tokens against the first j heard words.
	const cost = Array.from({ length: n + 1 }, (_, i) => new Uint32Array(m + 1).map((_, j) => (i === 0 ? j : j === 0 ? i : 0)));
	for (let i = 1; i <= n; i++) {
		for (let j = 1; j <= m; j++) {
			const same = tokens[i - 1]!.key === words[j - 1]!.key || (!tokens[i - 1]!.key && !words[j - 1]!.key);
			cost[i]![j] = Math.min(cost[i - 1]![j - 1]! + (same ? 0 : 1), cost[i - 1]![j]! + 1, cost[i]![j - 1]! + 1);
		}
	}
	const times: ({ start: number; end: number } | undefined)[] = new Array(n).fill(undefined);
	for (let i = n, j = m; i > 0 && j > 0; ) {
		const same = tokens[i - 1]!.key === words[j - 1]!.key;
		if (cost[i]![j] === cost[i - 1]![j - 1]! + (same ? 0 : 1)) {
			times[i - 1] = { start: words[j - 1]!.start, end: words[j - 1]!.end };
			i--;
			j--;
		} else if (cost[i]![j] === cost[i - 1]![j]! + 1) i--;
		else j--;
	}

	// Text words with no heard counterpart share the gap between their timed neighbours, by length.
	const total = durationSec ?? words.at(-1)?.end ?? 0;
	for (let i = 0; i < n; ) {
		if (times[i]) {
			i++;
			continue;
		}
		let k = i;
		while (k < n && !times[k]) k++;
		let first = i;
		let from = times[i - 1]?.end ?? 0;
		const to = times[k]?.start ?? Math.max(from, total);
		// No pause to put them in ("20 dollars" heard as one word, "$20"): they share the previous word's time.
		if (i > 0 && to - from < 0.06 * (k - i)) {
			first = i - 1;
			from = times[i - 1]!.start;
		}
		const lengths = tokens.slice(first, k).map((token) => token.text.length);
		const sum = lengths.reduce((a, b) => a + b, 0) || 1;
		let at = from;
		for (let x = first; x < k; x++) {
			const span = ((to - from) * lengths[x - first]!) / sum;
			times[x] = { start: at, end: at + span };
			at += span;
		}
		i = k;
	}

	// One entry per UTF-16 unit, matching how `wordTimings` indexes the spoken text.
	const characters = spoken.split("");
	const starts = new Array<number>(spoken.length).fill(0);
	const ends = new Array<number>(spoken.length).fill(0);
	let last = 0;
	let cursor = 0;
	tokens.forEach((token, t) => {
		const { start, end } = times[t]!;
		for (; cursor < token.index; cursor++) starts[cursor] = ends[cursor] = last;
		const length = token.text.length;
		for (let c = 0; c < length; c++) {
			starts[token.index + c] = start + ((end - start) * c) / length;
			ends[token.index + c] = start + ((end - start) * (c + 1)) / length;
		}
		cursor = token.index + length;
		last = end;
	});
	for (; cursor < spoken.length; cursor++) starts[cursor] = ends[cursor] = last;
	return { characters, starts, ends };
}
