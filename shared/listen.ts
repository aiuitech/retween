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

const SCALES: Record<string, number> = { thousand: 1e3, million: 1e6, billion: 1e9 };
const ORDINALS: Record<string, number> = {
	first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12,
	thirteenth: 13, fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17, eighteenth: 18, nineteenth: 19,
	twentieth: 20, thirtieth: 30, fortieth: 40, fiftieth: 50, sixtieth: 60, seventieth: 70, eightieth: 80, ninetieth: 90, hundredth: 100, thousandth: 1000,
};
/** Currency symbols and unit words, in one spelling: "$7" is "7 dollar", and "dollars" is "dollar". */
const CURRENCY: Record<string, string> = { $: "dollar", "£": "pound", "€": "euro", "¥": "yen" };
const UNITS: Record<string, string> = { dollars: "dollar", bucks: "dollar", pounds: "pound", euros: "euro", cents: "cent", percent: "percent", pct: "percent" };
const MULTIPLIERS: Record<string, number> = { k: 1e3, m: 1e6, mm: 1e6, bn: 1e9, b: 1e9 };
const UNIT_WORDS = new Set([...Object.values(CURRENCY), ...Object.values(UNITS)]);

const NUMBER_WORDS = new Set([
	...ONES,
	...TENS.filter(Boolean),
	...TENS.filter(Boolean).map((word) => word.replace(/y$/, "ies")),
	...Object.keys(SCALES),
	...Object.keys(ORDINALS),
	"hundred",
	"point",
	...UNIT_WORDS,
]);
/** Digits, number words and the units that go with them (dollar, percent). */
const numberish = (key: string) => /\d/.test(key) || NUMBER_WORDS.has(key);

interface Token {
	/** Lower case, letters and digits only; a number is its value in digits ("7200", "3.5", "21th" for an ordinal). */
	key: string;
	/** As written, for messages. */
	text: string;
	start?: number;
	end?: number;
}

/** A number written in digits, as a canonical key: "7,200" → "7200", "$5k" → "5000", "3.50" → "3.5", "21st" → "21th". */
function digitKey(piece: string): string | undefined {
	const match = /^(\d{1,3}(?:,\d{3})+|\d+)?(?:\.(\d+))?(k|mm|m|bn|b|st|nd|rd|th|s)?$/i.exec(piece);
	if (!match || (!match[1] && !match[2])) return undefined;
	const value = Number(`${(match[1] ?? "0").replace(/,/g, "")}.${match[2] ?? "0"}`);
	if (!Number.isFinite(value)) return undefined;
	const suffix = match[3]?.toLowerCase();
	if (suffix && suffix in MULTIPLIERS) return String(Math.round(value * MULTIPLIERS[suffix]! * 1000) / 1000);
	if (suffix === "s") return `${value}s`;
	if (suffix) return `${value}th`;
	return String(value);
}

/**
 * Reads runs of number words as one value: "seven thousand two hundred" → "7200", "seventy two hundred" → "7200",
 * "3 point 5" → "3.5", "twenty first" → "21th", "1.5 million" → "1500000". Words that cannot continue the number
 * start a new one, so "twenty twenty six" is two numbers (20, 26), as a year read aloud would be.
 */
function collapseNumbers(list: Token[]): Token[] {
	const out: Token[] = [];
	const ones = (key: string) => ONES.indexOf(key);
	const tens = (key: string) => TENS.indexOf(key);
	let i = 0;
	while (i < list.length) {
		let total = 0;
		let current = 0;
		let last: "digit" | "one" | "teen" | "ten" | "hundred" | "scale" | "decimal" | undefined;
		let largest = Infinity;
		let ordinal = false;
		let j = i;
		for (; j < list.length && !ordinal; j++) {
			const key = list[j]!.key;
			const one = ones(key);
			const ten = tens(key);
			if (/^\d+(\.\d+)?$/.test(key) && last === undefined) {
				current = Number(key);
				last = "digit";
			} else if (one >= 0 && (last === undefined || last === "hundred" || last === "scale" || (last === "ten" && one > 0 && one < 10 && current % 10 === 0))) {
				current += one;
				last = one < 10 ? "one" : "teen";
			} else if (ten > 1 && (last === undefined || last === "hundred" || last === "scale")) {
				current += ten * 10;
				last = "ten";
			} else if (key === "hundred" && (last === "digit" || last === "one" || last === "teen" || last === "ten") && current > 0 && current < 100) {
				current *= 100;
				last = "hundred";
			} else if (key in SCALES && last !== undefined && last !== "scale" && SCALES[key]! < largest && current > 0) {
				total += current * SCALES[key]!;
				current = 0;
				largest = SCALES[key]!;
				last = "scale";
			} else if (key === "and" && (last === "hundred" || last === "scale") && j + 1 < list.length && (ones(list[j + 1]!.key) > 0 || tens(list[j + 1]!.key) > 1)) {
				// "one hundred and five"
			} else if (key === "point" && last !== undefined && last !== "scale" && last !== "decimal" && j + 1 < list.length && ones(list[j + 1]!.key) >= 0 && ones(list[j + 1]!.key) < 10) {
				let k = j + 1;
				let decimal = "";
				while (k < list.length && ones(list[k]!.key) >= 0 && ones(list[k]!.key) < 10) decimal += String(ones(list[k++]!.key));
				current += Number(`0.${decimal}`);
				j = k - 1;
				last = "decimal";
			} else if (key in ORDINALS && (last === undefined || last === "hundred" || last === "scale" || (last === "ten" && ORDINALS[key]! < 10))) {
				current += ORDINALS[key]!;
				ordinal = true;
			} else break;
		}
		if (j === i) {
			out.push(list[i]!);
			i++;
			continue;
		}
		const value = Math.round((total + current) * 1000) / 1000;
		const group = list.slice(i, j);
		out.push({ key: ordinal ? `${value}th` : String(value), text: [...new Set(group.map((token) => token.text))].join(" "), start: group[0]!.start, end: group.at(-1)!.end });
		i = j;
	}
	return out;
}

/** Splits one written word into comparable words, before number words are read as values. */
function wordTokens(raw: string): Token[] {
	const out: Token[] = [];
	const cleaned = raw.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/%/g, " percent ").replace(/&/g, " and ");
	for (const part of cleaned.split(/[\s\-–—/]+/)) {
		// "$7,200." → "$7,200"; "(5k)" → "5k".
		let piece = part.replace(/^[^\p{L}\p{N}$£€¥.]+|[^\p{L}\p{N}]+$/gu, "");
		const currency = CURRENCY[piece[0] ?? ""];
		if (currency) piece = piece.slice(1);
		const number = digitKey(piece);
		const key = number ?? piece.replace(/[^\p{L}\p{N}]+/gu, "");
		if (key) out.push({ key: UNITS[key] ?? key, text: raw });
		if (currency) out.push({ key: currency, text: raw });
	}
	return out;
}

/**
 * Splits text into comparable words. Numbers become their value in digits whichever way they are written
 * ("$7,200", "seven thousand two hundred dollars" and "7.2k dollars" are all "7200 dollar"), so a voice
 * reading a number aloud and a transcriber writing it back in digits still match.
 */
export function tokens(text: string): Token[] {
	const out: Token[] = [];
	for (const match of text.replace(/\[[^\]]*\]/g, " ").matchAll(/\S+/g)) out.push(...wordTokens(match[0]));
	return collapseNumbers(out);
}

/**
 * Transcribers split a written number across words ("$7" ",200", "5" "%"); those pieces are joined
 * back together before reading them.
 */
function joinNumberPieces(words: SpokenWord[]): SpokenWord[] {
	const out: SpokenWord[] = [];
	for (const word of words) {
		const previous = out.at(-1);
		const text = word[0].trim();
		if (
			previous &&
			((/\d[,.]?$/.test(previous[0]) && /^[,.]\d/.test(text)) ||
				(/\d,$/.test(previous[0]) && /^\d{3}(?!\d)/.test(text)) ||
				/^[$£€¥]$/.test(previous[0]) ||
				(/\d$/.test(previous[0]) && /^(%|k|bn)$/i.test(text)))
		) {
			out[out.length - 1] = [previous[0] + text, previous[1], word[2]];
		} else out.push([text, word[1], word[2]]);
	}
	return out;
}

function heardTokens(words: SpokenWord[]): Token[] {
	const out: Token[] = [];
	for (const [word, start, end] of joinNumberPieces(words)) for (const token of wordTokens(word)) out.push({ ...token, start, end });
	return collapseNumbers(out);
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

/**
 * A rough key for how an English word sounds, so a transcriber's choice between homophones ("waits" and
 * "weights", "right" and "rite") is not reported as a misread. Vowel sounds are kept, so a name said with the
 * wrong vowel ("Dana" as "Donna") still differs.
 */
export function soundKey(word: string): string {
	return (
		word
			.toLowerCase()
			.replace(/[^a-z]/g, "")
			.replace(/eigh/g, "A")
			.replace(/igh/g, "I")
			.replace(/^kn/, "n")
			.replace(/^wr/, "r")
			.replace(/^wh/, "w")
			.replace(/^ps/, "s")
			.replace(/ph/g, "f")
			.replace(/gh/g, "")
			.replace(/tch/g, "ch")
			.replace(/dge/g, "j")
			.replace(/ck/g, "k")
			.replace(/c(?=[eiy])/g, "s")
			.replace(/c/g, "k")
			.replace(/q/g, "k")
			.replace(/x/g, "ks")
			.replace(/z/g, "s")
			// A silent e makes the vowel before it long: "rite" sounds like "right".
			.replace(/([aeiou])([b-df-hj-np-tv-z])e(s|d)?$/, (_, vowel: string, consonant: string, ending = "") => `${vowel.toUpperCase()}${consonant}${ending}`)
			.replace(/a[iy]|e[iy]/g, "A")
			.replace(/ee|ea|ie/g, "E")
			.replace(/oa|oe|ow/g, "O")
			.replace(/oo|ue|ew/g, "U")
			.replace(/([a-z])\1+/g, "$1")
	);
}

const PLAIN_NUMBER = /^\d+(\.\d+)?(th)?$/;

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
		// The same sounds spelled another way ("waits" heard as "weights"): nothing the voice could have done differently.
		if (/^[a-z]{3,}$/.test(wanted) && /^[a-z]{3,}$/.test(said) && soundKey(wanted) === soundKey(said)) {
			matched += item.want.length;
			continue;
		}
		// Numbers are compared by value, so "$7,200" and "seven thousand two hundred dollars" are the same. A different
		// value said in place of a single number (a price read wrong) is worth hearing; anything vaguer is not, because
		// numbers can be read aloud in more ways than are worth spelling out ("twenty twenty six" for 2026).
		if ([...item.want, ...item.got].every((token) => numberish(token.key) || STOPWORDS.has(token.key))) {
			const values = (list: Token[]) => list.filter((token) => PLAIN_NUMBER.test(token.key));
			const plain = (list: Token[]) => list.every((token) => PLAIN_NUMBER.test(token.key) || STOPWORDS.has(token.key) || UNIT_WORDS.has(token.key));
			const [expected, heardValue] = [values(item.want), values(item.got)];
			if (plain(item.want) && plain(item.got) && expected.length === 1 && heardValue.length === 1 && expected[0]!.key !== heardValue[0]!.key) {
				differences.push({
					expected: expected[0]!.text,
					heard: heardValue[0]!.text,
					atSec: Math.round((heardValue[0]!.start ?? 0) * 100) / 100,
					kind: "different",
					weight: 2,
				});
			}
			continue;
		}
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
