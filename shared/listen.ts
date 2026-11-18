/**
 * Did the voice say what the script says? The generated narration is
 * transcribed and the words heard are lined up with the words sent to the
 * voice, so a misread name, a skipped phrase or a garbled word shows up as
 * text without anyone listening. Pure functions, no I/O.
 *
 * Transcribers make mistakes of their own (spellings, numbers, compounds), so
 * differences that are only that are dropped, and what is left is reported
 * with both versions for the author to judge.
 */
import type { SpokenWord } from "./narration.ts";

export interface ReadDifference {
	/** What the script has, as sent to the voice (after pronunciation respellings). */
	expected: string;
	/** What the transcriber heard there. Empty when the words were not heard at all. */
	heard: string;
	/** Seconds into the narration clip. */
	atSec: number;
	/** missing: words not said. different: words said differently. extra: words said that are not in the script. */
	kind: "missing" | "different" | "extra";
	/** Content words involved (not counting short function words): how much the difference matters. */
	weight: number;
}

export interface ReadComparison {
	/** Share of the script's words that were heard as written, 0–1. */
	matched: number;
	differences: ReadDifference[];
}

const STOPWORDS = new Set(
	"a an the and or but of to in on at by for with from as is are was were be been it its this that these those i you he she we they me him her us them my your our their do does did so if then than there here not no yes up out over into onto off just also very can will would should could may might has have had let".split(
		" ",
	),
);

const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

/** 1234 → "one thousand two hundred thirty four". Integers below a billion; anything else is left as digits. */
export function numberWords(n: number): string {
	if (!Number.isInteger(n) || n < 0 || n >= 1e9) return String(n);
	if (n < 20) return ONES[n]!;
	if (n < 100) return `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ""}`;
	if (n < 1000) return `${ONES[Math.floor(n / 100)]} hundred${n % 100 ? ` ${numberWords(n % 100)}` : ""}`;
	if (n < 1e6) return `${numberWords(Math.floor(n / 1000))} thousand${n % 1000 ? ` ${numberWords(n % 1000)}` : ""}`;
	return `${numberWords(Math.floor(n / 1e6))} million${n % 1e6 ? ` ${numberWords(n % 1e6)}` : ""}`;
}

const NUMBER_WORDS = new Set([...ONES, ...TENS.filter(Boolean), "hundred", "thousand", "million", "billion", "point", "percent", "first", "second", "third"]);
const numberish = (key: string) => /\d/.test(key) || NUMBER_WORDS.has(key);

interface Token {
	/** Lower case, letters and digits only. */
	key: string;
	/** As written, for messages. */
	text: string;
	start?: number;
	end?: number;
}

/** Splits text into comparable words. Digits become words ("72" → "seventy two") so either way of writing a number matches. */
export function tokens(text: string): Token[] {
	const out: Token[] = [];
	for (const match of text.replace(/\[[^\]]*\]/g, " ").matchAll(/\S+/g)) {
		const raw = match[0];
		const cleaned = raw.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/%/g, " percent ").replace(/&/g, " and ");
		for (const part of cleaned.split(/[\s\-–—/]+/)) {
			const key = part.replace(/[^\p{L}\p{N}]+/gu, "");
			if (!key) continue;
			// Whole numbers only ("72", "1,200"); "3.5" and "4K" stay as they are and are compared as numbers later.
			const plain = part.replace(/[^\p{L}\p{N}.,]/gu, "").replace(/[.,]+$/, "");
			if (/^(\d{1,3}(,\d{3})+|\d{1,9})$/.test(plain)) {
				for (const word of numberWords(Number(plain.replace(/,/g, ""))).split(" ")) out.push({ key: word, text: raw });
			} else out.push({ key, text: raw });
		}
	}
	return out;
}

function heardTokens(words: SpokenWord[]): Token[] {
	const out: Token[] = [];
	for (const [word, start, end] of words) for (const token of tokens(word)) out.push({ ...token, start, end });
	return out;
}

/** Edit distance between two short strings. */
function distance(a: string, b: string): number {
	if (a === b) return 0;
	const row = Array.from({ length: b.length + 1 }, (_, j) => j);
	for (let i = 1; i <= a.length; i++) {
		let previous = row[0]!;
		row[0] = i;
		for (let j = 1; j <= b.length; j++) {
			const current = row[j]!;
			row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
			previous = current;
		}
	}
	return row[b.length]!;
}

/** British and American spellings of the same word: colour/color, organise/organize, centre/center, travelled/traveled. */
const spelling = (word: string) =>
	word
		.replace(/our(s?)$/, "or$1")
		.replace(/is(e|ed|es|ing|ation)$/, "iz$1")
		.replace(/ys(e|ed|es|ing)$/, "yz$1")
		.replace(/tre(s?)$/, "ter$1")
		.replace(/ll(ed|ing|er)$/, "l$1")
		.replace(/^okay$/, "ok");

/**
 * Spellings a transcriber produces for the same sound. Deliberately strict: a
 * brand name misread as a common word ("Retween" → "between") is one letter
 * off, and that is exactly the kind of mistake worth reporting.
 */
function sameWord(a: string, b: string): boolean {
	if (a === b) return true;
	if (spelling(a) === spelling(b)) return true;
	// Long words are sometimes spelled a letter off by the transcriber itself.
	return Math.min(a.length, b.length) >= 9 && distance(a, b) <= 1;
}

const contentWeight = (list: Token[]) => list.filter((token) => token.key.length > 2 && !STOPWORDS.has(token.key) && !numberish(token.key)).length;

/**
 * Lines up what was heard with what was sent to the voice and returns the
 * differences that look real. `spoken` is the text as sent (pronunciation
 * respellings applied); `heard` is the transcript with times in seconds.
 */
export function compareRead(spoken: string, heard: SpokenWord[]): ReadComparison {
	const want = tokens(spoken);
	const got = heardTokens(heard);
	const n = want.length;
	const m = got.length;
	if (!n) return { matched: 1, differences: [] };
	if (!m) return { matched: 0, differences: [{ expected: spoken.trim().slice(0, 160), heard: "", atSec: 0, kind: "missing", weight: contentWeight(want) }] };

	const cost = Array.from({ length: n + 1 }, (_, i) => new Uint32Array(m + 1).map((_, j) => (i === 0 ? j : j === 0 ? i : 0)));
	for (let i = 1; i <= n; i++) {
		for (let j = 1; j <= m; j++) {
			const same = sameWord(want[i - 1]!.key, got[j - 1]!.key);
			cost[i]![j] = Math.min(cost[i - 1]![j - 1]! + (same ? 0 : 1), cost[i - 1]![j]! + 1, cost[i]![j - 1]! + 1);
		}
	}

	// Walk back, collecting runs of words that did not match.
	type Run = { want: Token[]; got: Token[]; wantAt: number };
	const runs: Run[] = [];
	let run: Run | null = null;
	let matched = 0;
	const close = () => {
		if (run) runs.push({ ...run, want: run.want.reverse(), got: run.got.reverse() });
		run = null;
	};
	let i = n;
	let j = m;
	while (i > 0 || j > 0) {
		const same = i > 0 && j > 0 && sameWord(want[i - 1]!.key, got[j - 1]!.key);
		if (i > 0 && j > 0 && cost[i]![j] === cost[i - 1]![j - 1]! + (same ? 0 : 1)) {
			if (same) {
				matched++;
				close();
			} else {
				run ??= { want: [], got: [], wantAt: i - 1 };
				run.want.push(want[i - 1]!);
				run.got.push(got[j - 1]!);
				run.wantAt = i - 1;
			}
			i--;
			j--;
		} else if (i > 0 && (j === 0 || cost[i]![j] === cost[i - 1]![j]! + 1)) {
			run ??= { want: [], got: [], wantAt: i - 1 };
			run.want.push(want[i - 1]!);
			run.wantAt = i - 1;
			i--;
		} else {
			run ??= { want: [], got: [], wantAt: i };
			run.got.push(got[j - 1]!);
			j--;
		}
	}
	close();
	runs.reverse();

	// Times of the heard word nearest each point in the script, for runs with nothing heard.
	const timeNear = (index: number): number => {
		for (let k = index; k >= 0; k--) {
			const match = got.find((token) => token.key === want[k]?.key && token.start !== undefined);
			if (match) return match.end ?? match.start!;
		}
		return 0;
	};

	const differences: ReadDifference[] = [];
	for (const item of runs) {
		const wanted = item.want.map((token) => token.key).join("");
		const said = item.got.map((token) => token.key).join("");
		// "email" heard as "e mail", or the other way round.
		if (wanted === said || (wanted.length >= 6 && sameWord(wanted, said))) {
			matched += item.want.length;
			continue;
		}
		// Numbers are written and transcribed in too many ways to compare.
		if ([...item.want, ...item.got].every((token) => numberish(token.key) || STOPWORDS.has(token.key))) continue;
		const weight = Math.max(contentWeight(item.want), contentWeight(item.got));
		// A dropped or added "the" is not worth anyone's attention.
		if (weight === 0) continue;
		const text = (list: Token[]) => [...new Set(list.map((token) => token.text))].join(" ");
		differences.push({
			expected: text(item.want),
			heard: item.got.map((token) => token.key).join(" "),
			atSec: Math.round((item.got[0]?.start ?? timeNear(item.wantAt - 1)) * 100) / 100,
			kind: !item.got.length ? "missing" : !item.want.length ? "extra" : "different",
			weight,
		});
	}
	return { matched: Math.min(1, matched / n), differences };
}
