// Fixture media and timeline for the motion-graphics scenes: charts, maps,
// icons, a Lottie animation, a self-drawing SVG and subject cut-outs.
//
// Like make-media.mjs, nothing is downloaded: the photo and its cut-out are
// drawn with ffmpeg, the icons, illustration and Lottie are written by hand.
// Run make-media.mjs first (the theme's logo and the base photo come from it).
//
// Requires `ffmpeg`.   Usage: node fixtures/make-motion-media.mjs
// Map scenes fetch tiles from OpenFreeMap while rendering, so they need network access.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const media = path.join(here, "media");
const out = (name) => path.join(media, name);
const ffmpeg = (...args) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: ["ignore", "inherit", "inherit"] });
if (!fs.existsSync(out("photo.jpg"))) throw new Error("Run fixtures/make-media.mjs first");

const FPS = 30;

// --- a photo with a clear subject, and that subject cut out ----------------------
// The subject is a shaded sphere on a plinth; its alpha is the same shape, so the
// cut-out lines up with the photo exactly (as a real background removal would).
console.log("subject.png, subject-photo.jpg");
const W = 2400;
const H = 1600;
const sphere = `lte(hypot(X-W*0.62,Y-H*0.42),H*0.24)`;
const plinth = `between(X,W*0.5,W*0.74)*between(Y,H*0.64,H*0.86)`;
const inside = `max(${sphere},${plinth})`;
const shade = `(1-0.55*clip(hypot(X-W*0.56,Y-H*0.33)/(H*0.3),0,1))`;
ffmpeg(
	"-f", "lavfi",
	"-i", `color=c=black:s=${W}x${H},format=rgba,geq=r='if(${sphere},235*${shade},if(${plinth},70,0))':g='if(${sphere},120*${shade},if(${plinth},76,0))':b='if(${sphere},80*${shade},if(${plinth},92,0))':a='255*${inside}'`,
	"-frames:v", "1", out("subject.png"),
);
ffmpeg("-i", out("photo.jpg"), "-i", out("subject.png"), "-filter_complex", `[0]scale=${W}:${H}[bg];[bg][1]overlay=0:0`, "-frames:v", "1", "-q:v", "3", out("subject-photo.jpg"));

// --- icons (lucide-style strokes in currentColor) and one multi-colour icon --------
const stroke = (body) =>
	`<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</g></svg>`;
const icons = {
	"icon-rocket.svg": stroke('<path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09"/><path d="M12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/>'),
	"icon-shield.svg": stroke('<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>'),
	"icon-chart.svg": stroke('<path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="m19 9-5 5-4-4-3 3"/>'),
	"icon-globe.svg": stroke('<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20M2 12h20"/>'),
	"icon-party.svg":
		'<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><path fill="#FFB02E" d="M3 29l7-20 13 13z"/><path fill="#F70A8D" d="M8 15l9 9-3 1-7-7z"/><circle cx="22" cy="6" r="2.5" fill="#00A6ED"/><circle cx="27" cy="13" r="2" fill="#F92F60"/><path fill="none" stroke="#8D65C5" stroke-width="2" stroke-linecap="round" d="M15 7c2-2 1-4 3-5M25 17c2-2 4-1 5-3"/></svg>',
};
for (const [name, svg] of Object.entries(icons)) fs.writeFileSync(out(name), svg);
console.log(Object.keys(icons).join(", "));

// --- a flat vector illustration (what a vector visual looks like) ------------------
console.log("illustration.svg");
fs.writeFileSync(
	out("illustration.svg"),
	`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 900">
<rect width="1600" height="900" fill="#F4F1EA"/>
<circle cx="1180" cy="250" r="120" fill="#E4572E"/>
<path d="M0 640 Q300 470 620 600 T1200 560 T1600 520 V900 H0Z" fill="#B9A58A"/>
<path d="M0 720 Q400 600 800 700 T1600 660 V900 H0Z" fill="#1F3A5F"/>
<rect x="380" y="430" width="260" height="210" fill="#FFFFFF"/>
<path d="M360 440 L510 320 L660 440Z" fill="#E4572E"/>
<rect x="480" y="530" width="64" height="110" fill="#1F3A5F"/>
<rect x="410" y="470" width="50" height="50" fill="#B9A58A"/>
<rect x="560" y="470" width="50" height="50" fill="#B9A58A"/>
<rect x="836" y="500" width="22" height="120" fill="#5E4B3C"/>
<circle cx="847" cy="470" r="70" fill="#2F6B4F"/>
<rect x="1006" y="520" width="18" height="100" fill="#5E4B3C"/>
<circle cx="1015" cy="495" r="55" fill="#3E8A65"/>
<path d="M180 210 q30 -30 60 0 q30 -30 60 0" fill="none" stroke="#15171C" stroke-width="6" stroke-linecap="round"/>
<path d="M260 150 q22 -22 44 0 q22 -22 44 0" fill="none" stroke="#15171C" stroke-width="5" stroke-linecap="round"/>
</svg>`,
);

// --- a Lottie animation: a pulsing disc inside a turning ring, 2 s loop --------------
console.log("pulse.json");
const keyframes = (values, frames) => values.map((s, i) => ({ t: frames[i], s, ...(i < values.length - 1 ? { i: { x: [0.4], y: [1] }, o: { x: [0.6], y: [0] } } : {}) }));
const ellipse = (size) => ({ ty: "el", p: { a: 0, k: [0, 0] }, s: { a: 0, k: [size, size] } });
const transform = (extra = {}) => ({ ty: "tr", p: { a: 0, k: [0, 0] }, a: { a: 0, k: [0, 0] }, s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 }, ...extra });
const layer = (name, shapes, ks) => ({
	ddd: 0, ind: name.length, ty: 4, nm: name, sr: 1, ip: 0, op: 60, st: 0, bm: 0,
	ks: { o: { a: 0, k: 100 }, r: { a: 0, k: 0 }, p: { a: 0, k: [256, 256, 0] }, a: { a: 0, k: [0, 0, 0] }, s: { a: 0, k: [100, 100, 100] }, ...ks },
	shapes,
});
const lottie = {
	v: "5.7.4", fr: FPS, ip: 0, op: 60, w: 512, h: 512, nm: "pulse", ddd: 0, assets: [],
	layers: [
		layer("disc", [{ ty: "gr", it: [ellipse(220), { ty: "fl", c: { a: 0, k: [0.894, 0.341, 0.18, 1] }, o: { a: 0, k: 100 } }, transform()] }], {
			s: { a: 1, k: keyframes([[80, 80, 100], [110, 110, 100], [80, 80, 100]], [0, 30, 60]) },
		}),
		layer("ring", [{ ty: "gr", it: [ellipse(380), { ty: "st", c: { a: 0, k: [0.122, 0.227, 0.373, 1] }, o: { a: 0, k: 100 }, w: { a: 0, k: 18 }, lc: 2, lj: 2 }, { ty: "tm", s: { a: 0, k: 0 }, e: { a: 0, k: 70 }, o: { a: 0, k: 0 }, m: 1 }, transform()] }], {
			r: { a: 1, k: keyframes([[0], [360]], [0, 60]) },
		}),
	],
};
fs.writeFileSync(out("pulse.json"), JSON.stringify(lottie));

// --- the timeline ------------------------------------------------------------------
const base = JSON.parse(fs.readFileSync(path.join(here, "timeline.json"), "utf8"));
const theme = { ...base.theme, captions: { ...base.theme.captions, enabled: false } };
const icon = (name, mono = true) => ({ src: `asset://${name}`, mono });
const left = { align: "left", textPosition: "center", mediaSide: "right" };
const at = (seconds) => Math.round(seconds * FPS);
const brisk = (n, from = 0.6, gap = 0.32) => Array.from({ length: n }, (_, i) => at(from + i * gap));

const scenes = [
	{
		id: "columns",
		type: "chart",
		seconds: 5,
		layout: left,
		content: {
			kicker: "Growth",
			heading: "Weekly active teams",
			icon: icon("icon-chart.svg"),
			chart: {
				kind: "column",
				showValues: true,
				suffix: "k",
				points: ["Jan", "Feb", "Mar", "Apr", "May", "Jun"].map((label, i) => ({ label, value: [12, 18, 21, 29, 34, 47][i], atFrame: brisk(6)[i], highlight: i === 5 })),
			},
		},
	},
	{
		id: "donut",
		type: "chart",
		seconds: 5,
		layout: left,
		content: {
			heading: "Where the time goes",
			chart: {
				kind: "donut",
				showValues: true,
				points: [
					["Deep work", 46],
					["Meetings", 24],
					["Email", 18],
					["Admin", 12],
				].map(([label, value], i) => ({ label, value, atFrame: brisk(4)[i] })),
			},
		},
	},
	{
		id: "line",
		type: "chart",
		seconds: 5,
		layout: left,
		content: {
			kicker: "Response time",
			heading: "Twice as fast since spring",
			chart: {
				kind: "line",
				showValues: true,
				suffix: " ms",
				points: [420, 410, 380, 350, 300, 280, 240, 230, 210, 205].map((value, i) => ({ label: `W${i + 1}`, value, atFrame: brisk(10, 0.5, 0.22)[i] })),
			},
		},
	},
	{
		id: "bars",
		type: "chart",
		seconds: 5,
		layout: left,
		content: {
			heading: "Most requested features",
			chart: {
				kind: "bar",
				showValues: true,
				suffix: "%",
				points: [
					["Calendar sync", 72],
					["Focus mode", 58],
					["Shared plans", 41],
					["Templates", 27],
				].map(([label, value], i) => ({ label, value, atFrame: brisk(4)[i], highlight: i === 1 })),
			},
		},
	},
	{
		id: "map-overview",
		type: "map",
		seconds: 6,
		layout: { align: "left", textPosition: "top", mediaSide: "right" },
		content: {
			kicker: "Offices",
			heading: "Three cities, one team",
			map: {
				camera: "overview",
				route: true,
				style: "light",
				places: [
					["Lisbon", 38.7223, -9.1393],
					["Berlin", 52.52, 13.405],
					["Warsaw", 52.2297, 21.0122],
				].map(([name, lat, lng], i) => ({ name, lat, lng, atFrame: brisk(3, 0.8, 0.9)[i] })),
			},
		},
	},
	{
		id: "map-tour",
		type: "map",
		seconds: 8,
		layout: { align: "left", textPosition: "bottom", mediaSide: "right" },
		content: {
			heading: "The route",
			map: {
				camera: "tour",
				route: true,
				style: "dark",
				places: [
					["Porto", 41.1579, -8.6291],
					["Madrid", 40.4168, -3.7038],
					["Barcelona", 41.3874, 2.1686],
				].map(([name, lat, lng], i) => ({ name, lat, lng, atFrame: [at(1.2), at(3.6), at(6)][i] })),
			},
		},
	},
	{
		id: "icons",
		type: "bullets",
		seconds: 5,
		layout: left,
		content: {
			heading: "Built for busy weeks",
			bullets: [
				{ text: "Plans itself around your meetings", atFrame: at(0.6), icon: icon("icon-rocket.svg") },
				{ text: "Private by default", atFrame: at(1.4), icon: icon("icon-shield.svg") },
				{ text: "Works in every time zone", atFrame: at(2.2), icon: icon("icon-globe.svg") },
				{ text: "Celebrates the wins", atFrame: at(3), icon: icon("icon-party.svg", false) },
			],
		},
	},
	{
		id: "parallax",
		type: "media",
		seconds: 5,
		background: { kind: "image", src: "asset://subject-photo.jpg", fit: "cover", cutout: { src: "asset://subject.png", mode: "parallax" } },
		layout: { align: "left", textPosition: "bottom", mediaSide: "right" },
		content: { heading: "Depth from a single still" },
	},
	{
		id: "isolate-split",
		type: "split",
		seconds: 5,
		background: { kind: "image", src: "asset://subject-photo.jpg", fit: "cover", cutout: { src: "asset://subject.png", mode: "isolate" } },
		layout: left,
		content: { kicker: "Product", heading: "The subject, on its own", subheading: "Background removed, brand backdrop behind." },
	},
	{
		id: "isolate-full",
		type: "media",
		seconds: 5,
		background: { kind: "image", src: "asset://subject-photo.jpg", fit: "cover", cutout: { src: "asset://subject.png", mode: "isolate" } },
		layout: left,
		content: { heading: "Room for the words", subheading: "The subject takes the other half." },
	},
	{
		id: "drawn",
		type: "media",
		seconds: 5,
		background: { kind: "image", src: "asset://illustration.svg", fit: "cover", draw: true },
		layout: { align: "left", textPosition: "bottom", mediaSide: "right" },
		content: { heading: "Illustrations that draw themselves" },
	},
	{
		id: "lottie",
		type: "media",
		seconds: 4,
		background: { kind: "lottie", src: "asset://pulse.json", loop: true },
		layout: { align: "center", textPosition: "bottom", mediaSide: "right" },
		content: { heading: "Lottie, on the brand backdrop", icon: icon("icon-rocket.svg") },
	},
];

let cursor = 0;
const timeline = {
	version: 1,
	fps: FPS,
	durationInFrames: 0,
	theme,
	scenes: scenes.map(({ seconds, background, ...scene }, i) => {
		const durationInFrames = at(seconds);
		const out = {
			...scene,
			startFrame: cursor,
			durationInFrames,
			transition: i === 0 ? { type: "cut", durationInFrames: 0 } : { type: "fade", durationInFrames: 12 },
			background: background ?? { kind: "brand" },
		};
		cursor += durationInFrames;
		return out;
	}),
	audio: [],
	captions: [],
};
timeline.durationInFrames = cursor;
fs.writeFileSync(path.join(here, "timeline.motion.json"), `${JSON.stringify(timeline, null, "\t")}\n`);
console.log(`timeline.motion.json: ${timeline.scenes.length} scenes, ${cursor} frames`);
for (const scene of timeline.scenes) console.log(`  ${scene.id.padEnd(14)} frames ${scene.startFrame}-${scene.startFrame + scene.durationInFrames - 1}`);
