import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { sceneRetention, watchingAt, worstScenes } from "./retention.ts";
import { Timeline } from "./timeline.ts";

const fixture = Timeline.parse(JSON.parse(readFileSync(new URL("../renderer/fixtures/timeline.json", import.meta.url), "utf8")));

test("watchingAt draws straight lines between reported points", () => {
	const curve = [
		{ at: 0, watching: 1 },
		{ at: 0.5, watching: 0.6 },
		{ at: 1, watching: 0.4 },
	];
	assert.equal(watchingAt(curve, 0.25), 0.8);
	assert.equal(watchingAt(curve, 1.2), 0.4);
});

test("sceneRetention finds the scene where viewers leave fastest", () => {
	// A steady slide, then a cliff during the stat scene (15.2 s to 19.2 s of 31.7 s).
	const curve = Array.from({ length: 101 }, (_, i) => {
		const at = i / 100;
		const sec = at * 31.67;
		return { at, watching: sec < 15.2 ? 1 - sec * 0.01 : sec < 19.2 ? 0.848 - (sec - 15.2) * 0.08 : 0.528 - (sec - 19.2) * 0.005, relative: 0.5 };
	});
	const scenes = sceneRetention(fixture, curve);
	assert.equal(scenes.length, fixture.scenes.length);
	assert.equal(worstScenes(scenes)[0]!.id, "proof");
	assert.equal(scenes[0]!.relative, 0.5);
	assert.ok(scenes[0]!.start > scenes.at(-1)!.end);
});
