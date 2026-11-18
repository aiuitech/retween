import assert from "node:assert/strict";
import test from "node:test";
import { compareRead, numberWords, soundKey, tokens } from "./listen.ts";
import type { SpokenWord } from "./narration.ts";

/** Words at 0.3s each, as a transcriber would return them. */
const heard = (text: string): SpokenWord[] => text.split(" ").map((word, i) => [word, Math.round(i * 30) / 100, Math.round((i * 30 + 25)) / 100]);

test("numbers read either way match", () => {
	assert.equal(numberWords(72), "seventy two");
	assert.equal(numberWords(1200), "one thousand two hundred");
	assert.deepEqual(
		tokens("It costs 1,200 dollars.").map((token) => token.key),
		["it", "costs", "1200", "dollar"],
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

test("numbers are compared by value, however they are written or split", () => {
	const keys = (text: string) => tokens(text).map((token) => token.key);
	assert.deepEqual(keys("$7,200."), ["7200", "dollar"]);
	assert.deepEqual(keys("seven thousand two hundred dollars"), ["7200", "dollar"]);
	assert.deepEqual(keys("seventy-two hundred bucks"), ["7200", "dollar"]);
	assert.deepEqual(keys("a five-thousand-dollar job"), ["a", "5000", "dollar", "job"]);
	assert.deepEqual(keys("$5k"), ["5000", "dollar"]);
	assert.deepEqual(keys("3.5 million"), ["3500000"]);
	assert.deepEqual(keys("three point five million"), ["3500000"]);
	assert.deepEqual(keys("one hundred and five"), ["105"]);
	assert.deepEqual(keys("the 21st and the twenty-first"), ["the", "21th", "and", "the", "21th"]);
	assert.deepEqual(keys("40% off"), ["40", "percent", "off"]);
	assert.deepEqual(keys("twenty twenty-six"), ["20", "26"]);
});

test("a price read aloud and transcribed in digits is not a misread", () => {
	// The transcriber split "$7,200" into two words.
	const split: SpokenWord[] = [
		["It", 0, 0.2],
		["costs", 0.2, 0.5],
		["$7", 0.5, 0.9],
		[",200", 0.9, 1.4],
		["a", 1.4, 1.5],
		["month.", 1.5, 1.9],
	];
	assert.deepEqual(compareRead("It costs seven thousand two hundred dollars a month.", split).differences, []);
	assert.deepEqual(compareRead("It costs $7,200 a month.", heard("It costs seven thousand two hundred dollars a month.")).differences, []);
	assert.deepEqual(compareRead("Skip the five-thousand-dollar agency.", heard("Skip the $5,000 agency.")).differences, []);
	assert.deepEqual(
		compareRead("Skip the five-thousand-dollar agency.", [
			["Skip", 0, 0.3],
			["the", 0.3, 0.4],
			["$5", 0.4, 0.7],
			[",000", 0.7, 1],
			["agency.", 1, 1.5],
		]).differences,
		[],
	);
	assert.deepEqual(compareRead("Up 40% this year.", heard("Up forty percent this year.")).differences, []);
	assert.deepEqual(compareRead("Founded in 2026.", heard("Founded in twenty twenty six.")).differences, []);
});

test("a price said wrong is reported", () => {
	const result = compareRead("It costs $7,200 a month.", heard("It costs $7,000 a month."));
	assert.equal(result.differences.length, 1);
	assert.equal(result.differences[0]!.kind, "different");
	assert.equal(result.differences[0]!.expected, "$7,200");
	assert.ok(result.differences[0]!.weight >= 2);
});

test("homophones are not misreads, but a different vowel in a name is", () => {
	assert.equal(soundKey("waits"), soundKey("weights"));
	assert.equal(soundKey("rite"), soundKey("right"));
	assert.notEqual(soundKey("Dana"), soundKey("Donna"));
	assert.deepEqual(compareRead("Nothing waits on you.", heard("Nothing weights on you.")).differences, []);
	const result = compareRead("Ask Dana for a quote.", heard("Ask Donna for a quote."));
	assert.equal(result.differences.length, 1);
	assert.equal(result.differences[0]!.heard, "donna");
});
