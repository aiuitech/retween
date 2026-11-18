import assert from "node:assert/strict";
import test from "node:test";
import { compareRead, numberWords, tokens } from "./listen.ts";
import type { SpokenWord } from "./narration.ts";

/** Words at 0.3s each, as a transcriber would return them. */
const heard = (text: string): SpokenWord[] => text.split(" ").map((word, i) => [word, Math.round(i * 30) / 100, Math.round((i * 30 + 25)) / 100]);

test("numbers read either way match", () => {
	assert.equal(numberWords(72), "seventy two");
	assert.equal(numberWords(1200), "one thousand two hundred");
	assert.deepEqual(
		tokens("It costs 1,200 dollars.").map((token) => token.key),
		["it", "costs", "one", "thousand", "two", "hundred", "dollars"],
	);
	const result = compareRead("Delivered in 72 hours.", heard("Delivered in seventy-two hours."));
	assert.equal(result.differences.length, 0);
	assert.equal(result.matched, 1);
});

test("a clean read has no differences, whatever the punctuation, case or spelling variant", () => {
	const result = compareRead("Pick a colour, any colour. It's OK!", heard("pick a color any color it's ok"));
	assert.deepEqual(result.differences, []);
});

test("split and joined compounds are not differences", () => {
	assert.deepEqual(compareRead("Send us an email today.", heard("Send us an e mail today.")).differences, []);
});

test("a misread name is reported with what was heard and when", () => {
	const result = compareRead("Retween turns a storyboard into a finished video.", heard("Between turns a storyboard into a finished video."));
	assert.equal(result.differences.length, 1);
	const [difference] = result.differences;
	assert.equal(difference!.kind, "different");
	assert.equal(difference!.expected, "Retween");
	assert.equal(difference!.heard, "between");
	assert.equal(difference!.atSec, 0);
});

test("a skipped phrase is reported as missing", () => {
	const result = compareRead("Roasted every Tuesday morning in small batches and shipped the same afternoon.", heard("Roasted every Tuesday morning and shipped the same afternoon."));
	assert.equal(result.differences.length, 1);
	assert.equal(result.differences[0]!.kind, "missing");
	assert.match(result.differences[0]!.expected, /small batches/);
	assert.ok(result.differences[0]!.weight >= 2);
	assert.ok(result.matched < 1);
});

test("dropped function words are ignored", () => {
	assert.deepEqual(compareRead("We ship it to the door.", heard("We ship it to door.")).differences, []);
});

test("direction tags are not expected to be heard", () => {
	assert.deepEqual(compareRead("[whispers] Not a word to anyone.", heard("Not a word to anyone.")).differences, []);
});

test("nothing heard at all is one big difference", () => {
	const result = compareRead("This should have been said.", []);
	assert.equal(result.matched, 0);
	assert.equal(result.differences[0]!.kind, "missing");
});
