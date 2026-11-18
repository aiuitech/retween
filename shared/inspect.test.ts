import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { type AudioAnalysis, audioIssues, clock, cueSheet, fitIssues, pacingIssues, samenessIssues, sceneAt, sceneRange, settledFrame, shapeSimilarity, spreadFrames, structureIssues } from "./inspect.ts";
import type { Storyboard } from "./storyboard.ts";
import { Timeline } from "./timeline.ts";

const fixture = Timeline.parse(JSON.parse(readFileSync(new URL("../renderer/fixtures/timeline.json", import.meta.url), "utf8")));
const board: Storyboard = { scenes: fixture.scenes.map((scene) => ({ id: scene.id, type: scene.type })) };

test("clock formats minutes and tenths", () => {
	assert.equal(clock(3.44), "0:03.4");
	assert.equal(clock(83.45), "1:23.5");
});

test("settledFrame waits for the last bullet and stays inside the scene", () => {
	const bullets = fixture.scenes.find((scene) => scene.id === "how")!;
	const last = Math.max(...bullets.content.bullets!.map((bullet) => bullet.atFrame));
	const frame = settledFrame(bullets, fixture.fps);
	assert.ok(frame >= bullets.startFrame + Math.min(bullets.durationInFrames - 1, last + 21));
	assert.ok(frame < bullets.startFrame + bullets.durationInFrames);
	for (const scene of fixture.scenes) {
		const f = settledFrame(scene, fixture.fps);
		assert.ok(f >= scene.startFrame && f < scene.startFrame + scene.durationInFrames, scene.id);
	}
});

test("spreadFrames covers both ends without duplicates", () => {
	assert.deepEqual(spreadFrames(0, 90, 4), [0, 30, 60, 90]);
	assert.deepEqual(spreadFrames(10, 12, 8), [10, 11, 12]);
	assert.deepEqual(spreadFrames(5, 5, 3), [5]);
});

test("sceneAt and sceneRange find scenes by frame and id", () => {
	assert.equal(sceneAt(fixture, 0).id, "open");
	assert.equal(sceneAt(fixture, 240).id, "how");
	assert.deepEqual(sceneRange(fixture, ["view", "how"]), [129, 455]);
	assert.equal(sceneRange(fixture, ["nope"]), null);
});

test("cueSheet reports narration speed, lines and events", () => {
	const sheet = cueSheet(fixture, board);
	assert.equal(sheet.scenes.length, fixture.scenes.length);
	const how = sheet.scenes.find((scene) => scene.id === "how")!;
	assert.ok(how.narration && how.narration.wordsPerMinute > 80 && how.narration.wordsPerMinute < 260, JSON.stringify(how.narration));
	assert.ok(how.lines?.length);
	assert.equal(how.events?.filter((event) => event.what === "bullet").length, 3);
	assert.ok(sheet.music && sheet.music.duckedStretches > 0);
	const words = cueSheet(fixture, board, { sceneIds: ["open"], words: true });
	assert.equal(words.scenes.length, 1);
	assert.ok(words.scenes[0]!.words!.length > 3);
});

test("cueSheet finds unvoiced stretches and whether music covers them", () => {
	const sheet = cueSheet(fixture, board);
	const outro = sheet.unvoiced.find((gap) => gap.endSec === sheet.durationSec);
	assert.ok(outro && outro.music);
});

test("pacingIssues flags late reveals and dead air", () => {
	const scenes = structuredClone(fixture.scenes);
	const how = scenes.find((scene) => scene.id === "how")!;
	how.content.bullets![2]!.atFrame = how.durationInFrames - 5;
	const silent = { ...fixture, scenes, audio: fixture.audio.filter((clip) => clip.kind === "narration" && clip.id !== "narration-proof") };
	const issues = pacingIssues(silent, board);
	assert.ok(issues.some((issue) => issue.kind === "late-reveal" && issue.sceneId === "how"));
	assert.ok(issues.some((issue) => issue.kind === "dead-air"));
	assert.ok(!pacingIssues(fixture, board).some((issue) => issue.kind === "dead-air"), "music covers the pauses in the fixture");
});

test("fitIssues grades shrinking and overflow", () => {
	const issues = fitIssues(
		[
			{ probe: "0", box: "open/text", scale: 0.9, squash: 1 },
			{ probe: "1", box: "how/text", scale: 0.7, squash: 1 },
			{ probe: "2", box: "proof/lower-third", scale: 0.5, squash: 1 },
			{ probe: "3", box: "voice/text", scale: 0.3, squash: 0.8 },
		],
		(i) => ({ aspect: "9:16", atSec: i }),
	);
	assert.deepEqual(
		issues.map((issue) => [issue.sceneId, issue.severity, issue.kind]),
		[
			["how", "info", "text-shrunk"],
			["proof", "warning", "text-shrunk"],
			["voice", "error", "text-overflow"],
		],
	);
	assert.match(issues[1]!.message, /lower third/);
});

const analysis = (patch: Partial<AudioAnalysis>): AudioAnalysis => ({
	analysedSec: 30,
	fromSec: 0,
	mix: { lufs: -16, peakDbfs: -3, clippedMs: 0, clipAtSec: [] },
	stems: {},
	speechOverMusic: { medianLu: 16, worstLu: 11 },
	scenes: ["a", "b", "c"].map((id, i) => ({ id, startSec: i * 10, endSec: i * 10 + 10, mixLufs: -16, narrationLufs: -16, musicLufs: -32, speechOverMusicLu: 16, peakDbfs: -3 })),
	silences: [],
	skipped: [],
	...patch,
});

test("audioIssues is quiet about a healthy mix", () => {
	assert.deepEqual(audioIssues(analysis({}), 30), []);
});

test("audioIssues flags clipping, loud music, level jumps and silence", () => {
	const issues = audioIssues(
		analysis({
			mix: { lufs: -24, peakDbfs: 0.2, clippedMs: 40, clipAtSec: [12.3] },
			speechOverMusic: { medianLu: 6, worstLu: 2 },
			scenes: analysis({}).scenes.map((scene, i) => (i === 1 ? { ...scene, narrationLufs: -21 } : scene)),
			silences: [{ startSec: 4, endSec: 7 }],
		}),
		30,
	);
	const kinds = issues.map((issue) => issue.kind);
	for (const kind of ["clipping", "quiet", "music-too-loud", "narration-level-jump", "silence"]) assert.ok(kinds.includes(kind), kind);
	assert.ok(!kinds.includes("no-headroom"), "clipping already covers the peak");
});

test("structureIssues is quiet on a well-paced video", () => {
	const issues = structureIssues(fixture, board);
	assert.deepEqual(
		issues.filter((issue) => issue.severity !== "info").map((issue) => issue.kind),
		[],
	);
});

test("structureIssues flags a late first word, a long still and repeated scene types", () => {
	const late = {
		...fixture,
		captions: fixture.captions.map((cue) => ({ ...cue, startFrame: cue.startFrame + 120, endFrame: cue.endFrame + 120, words: cue.words.map((word) => ({ ...word, startFrame: word.startFrame + 120, endFrame: word.endFrame + 120 })) })),
	};
	assert.ok(structureIssues(late, board).some((issue) => issue.kind === "slow-hook"));

	// The opening title held for 10 s with nothing changing.
	const slow = { ...fixture, scenes: fixture.scenes.map((scene, i) => (i === 0 ? { ...scene, durationInFrames: 300 } : scene)) };
	assert.ok(structureIssues(slow, board).some((issue) => issue.kind === "slow-open" && issue.sceneId === "open"));

	const quotes = { ...fixture, scenes: fixture.scenes.map((scene, i) => (i >= 2 && i <= 4 ? { ...scene, type: "quote" as const, content: {} } : scene)) };
	assert.ok(structureIssues(quotes, board).some((issue) => issue.kind === "repetitive-run"));

	const noCta = { ...fixture, scenes: fixture.scenes.slice(0, -1) };
	assert.ok(structureIssues(noCta, { scenes: board.scenes.slice(0, -1) }).some((issue) => issue.kind === "no-call-to-action"));
});

test("shapeSimilarity and samenessIssues spot a template reused with new words", () => {
	assert.equal(shapeSimilarity(["a", "b", "c"], ["a", "b", "c"]), 1);
	assert.equal(shapeSimilarity(["a", "b", "c", "d"], ["a", "x", "c", "d"]), 0.75);
	const scenes = (words: string) =>
		["title", "media", "bullets", "stat", "split", "outro"].map((type, i) => ({ id: `s${i}`, type: type as "title", narration: `${words} scene ${i} goes here today` }));
	const mine = { scenes: scenes("Here is why our coffee") };
	const others = [
		{ title: "One", storyboard: { scenes: scenes("Here is why our tea") } },
		{ title: "Two", storyboard: { scenes: scenes("Here is why our cocoa") } },
	];
	const kinds = samenessIssues(mine, others).map((issue) => issue.kind);
	assert.ok(kinds.includes("template-sameness"));
	assert.deepEqual(samenessIssues(mine, [others[0]!]).map((issue) => issue.kind), []);
	const copy = { title: "Copy", storyboard: { scenes: scenes("Here is why our coffee") } };
	assert.ok(samenessIssues(mine, [copy]).some((issue) => issue.kind === "same-opening"));
});
