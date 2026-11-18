import assert from "node:assert/strict";
import test from "node:test";
import { mergePatch, unsetPath } from "./patch.ts";

const scene = { id: "a", type: "media", text: { heading: "Old", body: "Keep" }, visual: { source: "stock", query: "coffee", look: { blur: 4 } }, sfx: [{ prompt: "whoosh" }] };

test("objects merge field by field; arrays and values are replaced", () => {
	const next = mergePatch(scene, { text: { heading: "New" }, visual: { look: { brightness: 0.8 } }, sfx: [] });
	assert.deepEqual(next.text, { heading: "New", body: "Keep" });
	assert.deepEqual(next.visual, { source: "stock", query: "coffee", look: { blur: 4, brightness: 0.8 } });
	assert.deepEqual(next.sfx, []);
	assert.equal(scene.text.heading, "Old");
});

test("null removes a field", () => {
	const next = mergePatch(scene, { text: { body: null }, visual: null });
	assert.deepEqual(next.text, { heading: "Old" });
	assert.equal("visual" in next, false);
});

test("unsetPath removes a nested field", () => {
	assert.deepEqual(unsetPath(scene, "visual.look").visual, { source: "stock", query: "coffee" });
	assert.equal(unsetPath(scene, "nope.deeper"), scene);
});
