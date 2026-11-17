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
