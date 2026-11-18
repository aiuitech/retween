import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { chapterBlock, chaptersFor, stamp } from "./publish.ts";
import type { Storyboard } from "./storyboard.ts";
import { Timeline } from "./timeline.ts";

const fixture = Timeline.parse(JSON.parse(readFileSync(new URL("../renderer/fixtures/timeline.json", import.meta.url), "utf8")));
const board = (chapters: Record<string, string>): Storyboard => ({ scenes: fixture.scenes.map((scene) => ({ id: scene.id, type: scene.type, chapter: chapters[scene.id] })) });

test("stamp writes times the way YouTube reads them", () => {
	assert.equal(stamp(0), "0:00");
	assert.equal(stamp(83.9), "1:23");
	assert.equal(stamp(3725), "1:02:05");
});

test("chapters start at 0:00 and fold ones that are too short", () => {
	// Scenes start at 0, 4.3, 7.9, 15.2, 19.2, 23.9 and 28.2 seconds; the video is 31.7 s long.
	const { chapters, problems } = chaptersFor(fixture, board({ view: "What it is", how: "How it works", together: "Together", close: "Get it" }));
	assert.deepEqual(chapters.map((chapter) => chapter.title), ["What it is", "Together"]);
	assert.equal(chapters[0]!.atSec, 0);
	assert.ok(problems.some((problem) => /folded/.test(problem)));
	assert.ok(problems.some((problem) => /at least 3/.test(problem)));
	assert.equal(chapterBlock(chapters), "");
});

test("no chapters asked for is no problem", () => {
	assert.deepEqual(chaptersFor(fixture, board({})), { chapters: [], problems: [] });
});

test("chapterBlock lists three or more chapters", () => {
	assert.equal(
		chapterBlock([
			{ atSec: 0, title: "Intro" },
			{ atSec: 75, title: "Why <it> works" },
			{ atSec: 200, title: "Get it" },
		]),
		"0:00 Intro\n1:15 Why it works\n3:20 Get it",
	);
});
