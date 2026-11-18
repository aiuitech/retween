import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { captionsVtt, embedSnippet, frameAncestors, normalizeOrigins, parseStart, readPlayOptions, streamPlayerParams, withPlayOptions } from "./hosting.ts";
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

test("a fixed-width embed keeps the video's shape", () => {
	assert.match(embedSnippet("https://retween.app/embed/hst_1", "t", 1920, 1080, 640), /width="640" height="360"/);
});

test("start times read the way people write them", () => {
	assert.equal(parseStart("90"), 90);
	assert.equal(parseStart("1:30"), 90);
	assert.equal(parseStart("1:02:05"), 3725);
	assert.equal(parseStart("1m30"), undefined);
	assert.equal(parseStart(""), undefined);
});

test("play options survive a round trip through the URL", () => {
	const options = { autoplay: true, loop: true, hideControls: true, startSec: 42 };
	const url = withPlayOptions("https://retween.app/embed/hst_1", options);
	assert.equal(url, "https://retween.app/embed/hst_1?autoplay=1&loop=1&controls=0&t=42");
	assert.deepEqual(readPlayOptions(new URL(url).searchParams), options);
	assert.equal(withPlayOptions("https://retween.app/v/hst_1", {}), "https://retween.app/v/hst_1");
	assert.deepEqual(readPlayOptions(new URLSearchParams("t=junk&autoplay=yes")), { autoplay: undefined, loop: undefined, hideControls: undefined, startSec: undefined });
});

test("autoplay is always muted, as browsers require", () => {
	assert.deepEqual(streamPlayerParams({ autoplay: true, startSec: 5 }), { autoplay: "true", muted: "true", startTime: "5s" });
});
