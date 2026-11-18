import assert from "node:assert/strict";
import test from "node:test";
import { clipPromptForModel } from "./prompts.ts";

test("colour codes are left out of clip prompts, the colour words stay", () => {
	const prompt = clipPromptForModel("A desk console in periwinkle #8190E8, with a lavender (#C9B8F0) glow.\n\nStyle: soft light, accent #FF5500FF.");
	assert.ok(!/#[0-9a-f]{6}/i.test(prompt));
	assert.ok(prompt.startsWith("A desk console in periwinkle, with a lavender glow.\n\nStyle: soft light, accent."));
});

test("numbers that are not colour codes are kept", () => {
	const prompt = clipPromptForModel("Player #23 and room #123456789 at 10:30.");
	assert.ok(prompt.startsWith("Player #23 and room #123456789 at 10:30."));
});

test("clip prompts ask for no lettering unless they quote words to show", () => {
	assert.match(clipPromptForModel("A truck on a road."), /No on-screen text, letters, numbers, captions or logos anywhere/);
	assert.match(clipPromptForModel('A shop sign reading "Open".'), /other than the words quoted above/);
});
