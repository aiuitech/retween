import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { captionsVtt, embedSnippet, frameAncestors, normalizeOrigins } from "./hosting.ts";
import { Timeline } from "./timeline.ts";

const fixture = Timeline.parse(JSON.parse(readFileSync(new URL("../renderer/fixtures/timeline.json", import.meta.url), "utf8")));

test("captions become WebVTT with dotted milliseconds", () => {
	const vtt = captionsVtt(fixture);
	if (!fixture.captions.length) return assert.equal(vtt, "");
	assert.match(vtt, /^WEBVTT\n\n/);
	assert.match(vtt, /\d\d:\d\d:\d\d\.\d{3} --> \d\d:\d\d:\d\d\.\d{3}\n\S/);
	assert.doesNotMatch(vtt, /\d,\d{3} -->/);
});

test("no narration, no captions", () => {
	assert.equal(captionsVtt({ ...fixture, captions: [] }), "");
});

test("embedding sites are reduced to origins", () => {
	assert.deepEqual(normalizeOrigins(["example.com", "https://www.example.com/page?x=1", "*.Example.org", "http://localhost:3000", " "]), [
		"https://example.com",
		"https://www.example.com",
		"https://*.example.org",
		"http://localhost:3000",
	]);
	assert.throws(() => normalizeOrigins(["javascript:alert(1)"]));
	assert.throws(() => normalizeOrigins(["not a host"]));
	assert.throws(() => normalizeOrigins(["example.com; script-src *"]));
});

test("frame-ancestors allows anywhere unless sites are listed", () => {
	assert.equal(frameAncestors([]), "frame-ancestors *");
	assert.equal(frameAncestors(["https://example.com"]), "frame-ancestors 'self' https://example.com");
});

test("the embed snippet keeps the video's shape and escapes its title", () => {
	const html = embedSnippet("https://retween.app/embed/hst_1", 'Say "hi" <now>', 1080, 1920);
	assert.match(html, /aspect-ratio:1080 \/ 1920/);
	assert.match(html, /title="Say &quot;hi&quot; &lt;now>"/);
});
