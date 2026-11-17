import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Timeline, collectAssetRefs, dropMissingAssetRefs, resolveAssetRefs } from "./timeline.ts";

const fixture = JSON.parse(readFileSync(new URL("../renderer/fixtures/timeline.json", import.meta.url), "utf8"));

const scene = (id: string, startFrame: number, extra: Partial<Timeline["scenes"][number]>): Timeline["scenes"][number] => ({
	id,
	type: "bullets",
	startFrame,
	durationInFrames: 90,
	transition: { type: "cut", durationInFrames: 0 },
	background: { kind: "brand" },
	layout: { align: "left", textPosition: "center", mediaSide: "right" },
	content: {},
	...extra,
});

const timeline = Timeline.parse({
	version: fixture.version,
	fps: 30,
	durationInFrames: 270,
	theme: { ...fixture.theme, logo: { src: "asset://logo", darkSrc: "asset://gone-dark" }, watermark: undefined },
	scenes: [
		scene("bullets", 0, {
			content: {
				icon: { src: "asset://icon-heading", mono: true },
				heading: "Why it works",
				bullets: [
					{ text: "Fast", atFrame: 0, icon: { src: "asset://icon-rocket", mono: true } },
					{ text: "Gone", atFrame: 20, icon: { src: "asset://gone-icon", mono: true } },
					{ text: "Plain", atFrame: 40 },
				],
			},
		}),
		scene("cutout", 90, {
			type: "media",
			background: { kind: "image", src: "asset://photo", fit: "cover", cutout: { src: "asset://gone-cutout", mode: "parallax" } },
		}),
		scene("lottie", 180, { type: "title", background: { kind: "lottie", src: "asset://anim", loop: true } }),
	],
	audio: [
		{ id: "vo", kind: "narration", src: "asset://voice", startFrame: 0, durationInFrames: 270, trimStartSec: 0, volume: 1, loop: false, fadeInFrames: 0, fadeOutFrames: 0 },
		{ id: "bed", kind: "music", src: "asset://gone-music", startFrame: 0, durationInFrames: 270, trimStartSec: 0, volume: 0.2, loop: true, fadeInFrames: 0, fadeOutFrames: 0 },
	],
	captions: [],
});

// What resolveTimeline in src/worker/services/renders.ts does, with "gone-*" assets deleted.
const resolve = (input: Timeline) => {
	const urls = new Map(collectAssetRefs(input).filter((id) => !id.startsWith("gone")).map((id) => [id, `https://media.test/${id}?sig=1`]));
	return resolveAssetRefs(
		dropMissingAssetRefs(input, (id) => urls.has(id)),
		(id) => urls.get(id)!,
	);
};

test("collects icon, cutout and Lottie refs, not just backgrounds and audio", () => {
	assert.deepEqual(
		collectAssetRefs(timeline).sort(),
		["anim", "gone-cutout", "gone-dark", "gone-icon", "gone-music", "icon-heading", "icon-rocket", "logo", "photo", "voice"],
	);
});

test("a bullet icon gets a signed URL", () => {
	const out = resolve(timeline);
	const bullets = out.scenes[0]!.content.bullets!;
	assert.deepEqual(bullets[0]!.icon, { src: "https://media.test/icon-rocket?sig=1", mono: true });
	assert.equal(out.scenes[0]!.content.icon?.src, "https://media.test/icon-heading?sig=1");
	assert.deepEqual(out.scenes[2]!.background, { kind: "lottie", src: "https://media.test/anim?sig=1", loop: true });
});

test("deleted media falls back instead of dangling", () => {
	const out = resolve(timeline);
	const bullets = out.scenes[0]!.content.bullets!;
	assert.equal(bullets[1]!.icon, undefined);
	assert.equal(bullets[1]!.text, "Gone");
	assert.equal(bullets[2]!.icon, undefined);
	assert.deepEqual(out.scenes[1]!.background, { kind: "image", src: "https://media.test/photo?sig=1", fit: "cover", cutout: undefined });
	assert.deepEqual(out.theme.logo, { src: "https://media.test/logo?sig=1", darkSrc: undefined });
	assert.deepEqual(out.audio.map((clip) => clip.id), ["vo"]);

	const noBackground = resolve({ ...timeline, scenes: [scene("x", 0, { background: { kind: "video", src: "asset://gone-clip", fit: "cover", startFromSec: 0, loop: false, volume: 0, playbackRate: 1 } })] });
	assert.deepEqual(noBackground.scenes[0]!.background, { kind: "brand" });
	assert.equal(noBackground.theme.logo?.src, "https://media.test/logo?sig=1");
});

test("no asset:// ref survives resolution", () => {
	assert.doesNotMatch(JSON.stringify(resolve(timeline)), /asset:\/\//);
	assert.doesNotThrow(() => Timeline.parse(resolve(timeline)));
});
