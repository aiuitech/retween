import assert from "node:assert/strict";
import { test } from "node:test";
import { type ComposeAsset, composeTimeline } from "./compose.ts";
import { fillers, findPhrase, paragraphs, resolveRange, retakes, toSrt, wordsBetween } from "./footage.ts";
import type { SpokenWord } from "./narration.ts";
import type { Storyboard } from "./storyboard.ts";

/** A recording: words 0.3 s long, 0.1 s apart, with a long pause before "Second". */
function recording(text: string, pauseBefore: Record<string, number> = {}): SpokenWord[] {
	let t = 0.5;
	return text.split(" ").map((word) => {
		t += pauseBefore[word] ?? 0;
		const w: SpokenWord = [word, Math.round(t * 100) / 100, Math.round((t + 0.3) * 100) / 100];
		t += 0.4;
		return w;
	});
}

const talk = recording("So the main reason we. So the main reason we built this is speed. Second, it is cheap. Um, and it works every single time.", { "Second,": 1.5 });
const DURATION = 30;

test("findPhrase ignores case and punctuation", () => {
	assert.deepEqual(findPhrase(talk, "so THE main"), [0, 5]);
	assert.deepEqual(findPhrase(talk, "second it is"), [findPhrase(talk, "Second")[0]]);
});

test("a stretch quoted by its words is cut in the pauses around them", () => {
	const range = resolveRange(talk, { from: "second, it is", to: "is cheap" }, DURATION);
	const second = talk.find(([w]) => w === "Second,")!;
	const cheap = talk.find(([w]) => w === "cheap.")!;
	assert.ok(range.startSec < second[1] && range.startSec >= second[1] - 0.1, `${range.startSec}`);
	assert.ok(range.endSec > cheap[2] && range.endSec <= cheap[2] + 0.17, `${range.endSec}`);
	assert.deepEqual(
		range.words.map(([w]) => w),
		["Second,", "it", "is", "cheap."],
	);
	assert.ok(range.words[0]![1] > 0 && range.words[0]![1] < 0.1);
});

test("seconds inside a word are moved so the word is not clipped", () => {
	const speed = talk.find(([w]) => w === "speed.")!;
	const range = resolveRange(talk, { from: speed[1] + 0.1, to: speed[1] + 0.15 }, DURATION);
	assert.ok(range.startSec < speed[1]);
	assert.ok(range.endSec > speed[2]);
});

test("repeated words: the first is used with a warning, `after` picks a later one", () => {
	const first = resolveRange(talk, { from: "so the main reason", to: "speed" }, DURATION);
	assert.equal(first.warnings.length, 1);
	assert.match(first.warnings[0]!, /2 times/);
	const later = resolveRange(talk, { from: "so the main reason", to: "speed", after: 2 }, DURATION);
	assert.ok(later.startSec > 2);
	assert.equal(later.words[0]![0], "So");
	assert.equal(later.words.length, 9);
});

test("words that are not said give a helpful error", () => {
	assert.throws(() => resolveRange(talk, { from: "it is expensive" }, DURATION), /not in the transcript/);
	assert.throws(() => resolveRange(talk, { from: "second", to: "so the main" }, DURATION), /only said before/);
});

test("wordsBetween keeps words mostly inside the stretch, timed from its start", () => {
	assert.deepEqual(wordsBetween([["a", 1, 2], ["b", 2.1, 3], ["c", 3.1, 4]], 1.9, 3.2), [["b", 0.2, 1.1]]);
});

test("paragraphs break at pauses and speaker changes", () => {
	const ps = paragraphs(talk);
	assert.equal(ps.length, 2);
	assert.ok(ps[1]!.text.startsWith("Second,"));
	assert.equal(ps[1]!.pauseBeforeSec, 1.6);
	const speakers = talk.map((_, i) => (i < 3 ? "a" : "b"));
	assert.equal(paragraphs(talk, speakers)[0]!.text, "So the main");
});

test("retakes, fillers and SRT", () => {
	const found = retakes(talk);
	assert.equal(found.length, 1);
	assert.equal(found[0]!.text, "So the main reason we.");
	assert.equal(found[0]!.keepStartSec, talk[5]![1]);
	assert.deepEqual(fillers(talk).map((f) => f.word), ["Um,"]);
	const srt = toSrt(talk);
	assert.match(srt, /^1\n00:00:00,500 --> 00:00:02,/);
	assert.ok(srt.includes("Second,"));
});

// --- compose -------------------------------------------------------------------------

const footageAssets = (extra: Partial<ComposeAsset> = {}) =>
	new Map<string, ComposeAsset>([
		[
			"ast_talk",
			{ id: "ast_talk", kind: "video", ready: true, durationSec: DURATION, words: talk, footage: { audioAssetId: "ast_voice", durationSec: DURATION, hasVideo: true }, ...extra },
		],
		["ast_broll", { id: "ast_broll", kind: "image", ready: true }],
	]);
const resolved = { narration: {}, visual: {}, sfx: {} };

test("compose cuts footage scenes to the quoted words and syncs picture and voice", () => {
	const storyboard: Storyboard = {
		scenes: [
			{ id: "why", type: "media", footage: { assetId: "ast_talk", from: "so the main reason we built", to: "speed" }, text: { bullets: [{ text: "Speed", cue: "speed" }] } },
			{ id: "cheap", type: "media", footage: { assetId: "ast_talk", from: "second", to: "cheap" } },
			{ id: "works", type: "media", footage: { assetId: "ast_talk", from: "and it works", show: "voice" }, visual: { source: "asset", assetId: "ast_broll" } },
		],
	};
	const result = composeTimeline({ storyboard, brand: {}, resolved, assets: footageAssets() });
	assert.deepEqual(result.errors, []);
	const tl = result.timeline!;
	const [why, cheap, works] = tl.scenes;
	const voice = tl.audio.filter((clip) => clip.kind === "narration");
	assert.equal(voice.length, 3);
	for (const [i, scene] of tl.scenes.entries()) {
		assert.equal(voice[i]!.src, "asset://ast_voice");
		assert.equal(voice[i]!.startFrame, scene!.startFrame);
		assert.ok(Math.abs(voice[i]!.durationInFrames - scene!.durationInFrames) <= 1);
	}
	assert.equal(why!.background.kind, "video");
	if (why!.background.kind === "video") {
		assert.equal(why!.background.src, "asset://ast_talk");
		assert.equal(why!.background.startFromSec, voice[0]!.trimStartSec);
		assert.equal(why!.background.volume, 0);
	}
	// The second cut from the same recording punches in to hide the jump.
	assert.equal(cheap!.background.kind === "video" && cheap!.background.zoom, 1.12);
	assert.equal(cheap!.transition.type, "cut");
	// Voice only: the b-roll stays, the voice plays over it.
	assert.equal(works!.background.kind, "image");
	// Cues and captions follow the recording.
	const speed = talk.find(([w]) => w === "speed.")!;
	assert.ok(Math.abs(why!.content.bullets![0]!.atFrame / tl.fps - (speed[1] - voice[0]!.trimStartSec - 0.12)) < 0.05);
	assert.ok(tl.captions.some((caption) => caption.text.includes("cheap")));
	assert.ok(Math.abs(why!.durationInFrames / tl.fps - (speed[2] + 0.16 - voice[0]!.trimStartSec)) < 0.1);
});

test("compose reports footage that is not processed, and drafts around it", () => {
	const storyboard: Storyboard = { scenes: [{ id: "a", type: "media", footage: { assetId: "ast_talk", from: 2, to: 6 } }] };
	const pending = footageAssets({ footage: undefined });
	const real = composeTimeline({ storyboard, brand: {}, resolved, assets: pending });
	assert.equal(real.timeline, null);
	assert.match(real.errors[0]!, /not been processed/);
	const draft = composeTimeline({ storyboard, brand: {}, resolved, assets: pending, draft: true });
	assert.ok(draft.timeline);
	assert.ok(Math.abs(draft.durationSec - 4) < 0.1);
});

test("a storyboard scene cannot have both narration and footage", async () => {
	const { Storyboard } = await import("./storyboard.ts");
	const parsed = Storyboard.safeParse({ scenes: [{ id: "a", type: "media", narration: "Hi", footage: { assetId: "x" } }] });
	assert.equal(parsed.success, false);
});

test("looks reach the timeline, and clip speed changes how long an unvoiced clip runs", () => {
	const assets = footageAssets();
	assets.set("ast_clip", { id: "ast_clip", kind: "video", ready: true, durationSec: 4 });
	const storyboard: Storyboard = {
		scenes: [
			{ id: "talk", type: "media", footage: { assetId: "ast_talk", from: "second", to: "cheap", look: { grayscale: 1 } } },
			{ id: "slow", type: "media", visual: { source: "asset", assetId: "ast_clip", speed: 0.5, look: { vignette: 0.5, temperature: 0.3 } } },
		],
	};
	const tl = composeTimeline({ storyboard, brand: {}, resolved, assets }).timeline!;
	const [talk, slow] = tl.scenes;
	assert.deepEqual(talk!.background.kind === "video" && talk!.background.look, { grayscale: 1 });
	assert.ok(slow!.background.kind === "video" && slow!.background.playbackRate === 0.5 && slow!.background.look?.vignette === 0.5);
	// 4 s of clip at half speed fills 8 s (capped at 8 s for an unvoiced clip).
	assert.equal(slow!.durationInFrames / tl.fps, 8);
});
