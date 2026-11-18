import assert from "node:assert/strict";
import test from "node:test";
import { alignmentFromWords, buildSpokenText, pronunciationsFor, wordTimings } from "./narration.ts";

const heard = [
	{ word: "Retwean", start: 0.1, end: 0.5 },
	{ word: "turns", start: 0.58, end: 0.82 },
	{ word: "a", start: 0.84, end: 0.92 },
	{ word: "storyboard", start: 0.96, end: 1.48 },
	{ word: "into", start: 1.52, end: 1.7 },
	{ word: "a", start: 1.76, end: 1.84 },
	{ word: "finished", start: 1.88, end: 2.16 },
	{ word: "video.", start: 2.2, end: 2.52 },
	{ word: "It", start: 3.02, end: 3.1 },
	{ word: "costs", start: 3.14, end: 3.5 },
	{ word: "twenty", start: 3.54, end: 3.74 },
	{ word: "dollars", start: 3.82, end: 4.12 },
	{ word: "a", start: 4.16, end: 4.2 },
	{ word: "month", start: 4.24, end: 4.46 },
];

test("transcript word times line up with the written words, misheard ones included", () => {
	const text = "Retween turns a storyboard into a finished video. It costs 20 dollars a month.";
	const spoken = buildSpokenText(text);
	const alignment = alignmentFromWords(spoken.spoken, heard, 4.8);
	assert.equal(alignment.characters.length, spoken.spoken.length);
	const words = wordTimings(text, spoken, alignment);
	assert.equal(words.length, 14);
	assert.deepEqual(words[0], ["Retween", 0.1, 0.5]);
	assert.deepEqual(words[10], ["20", 3.54, 3.74]);
	assert.deepEqual(words[13], ["month.", 4.24, 4.46]);
});

test("words the transcript dropped share the gap around them", () => {
	const text = "One two three four";
	const spoken = buildSpokenText(text);
	const words = wordTimings(text, spoken, alignmentFromWords(spoken.spoken, [{ word: "one", start: 0, end: 0.4 }, { word: "four", start: 2, end: 2.4 }]));
	assert.equal(words.length, 4);
	assert.ok(words[1]![1] >= 0.4 && words[2]![2] <= 2, JSON.stringify(words));
	assert.ok(words[1]![2] <= words[2]![1] + 1e-9);
});

test("an empty transcript still gives every word a time inside the recording", () => {
	const text = "Hello there";
	const spoken = buildSpokenText(text);
	const words = wordTimings(text, spoken, alignmentFromWords(spoken.spoken, [], 2));
	assert.equal(words.length, 2);
	assert.equal(words[1]![2], 2);
});

test("words heard as one share its time", () => {
	const text = "It costs 20 dollars a month.";
	const spoken = buildSpokenText(text);
	const heardAsOne = [
		{ word: "It", start: 2.94, end: 3.1 },
		{ word: "costs", start: 3.1, end: 3.56 },
		{ word: "$20", start: 3.56, end: 3.98 },
		{ word: "a", start: 3.98, end: 4.44 },
		{ word: "month.", start: 4.44, end: 4.82 },
	];
	const words = wordTimings(text, spoken, alignmentFromWords(spoken.spoken, heardAsOne));
	const [, start20, end20] = words[2]!;
	const [, startDollars, endDollars] = words[3]!;
	assert.equal(start20, 3.56);
	assert.ok(end20 > start20 && endDollars > startDollars, JSON.stringify(words));
	assert.equal(endDollars, 3.98);
});

test("only respellings whose term the line says are kept for it", () => {
	const rules = [
		{ term: "Dana", say: "Day-na" },
		{ term: "SQL", say: "sequel" },
		{ term: "Retween", say: "Re-tween" },
		{ term: " ", say: "blank" },
	];
	assert.deepEqual(pronunciationsFor("Ask dana about the SQL export.", rules), [rules[0], rules[1]]);
	// Whole words only: "Danaher" and "MySQL" do not use the rules.
	assert.deepEqual(pronunciationsFor("Danaher runs MySQL.", rules), []);
	assert.deepEqual(pronunciationsFor("Hello.", []), []);
	// The kept rules respell the line exactly as the full list does.
	const text = "Dana writes SQL in Retween.";
	assert.equal(buildSpokenText(text, pronunciationsFor(text, rules)).spoken, buildSpokenText(text, rules).spoken);
});
