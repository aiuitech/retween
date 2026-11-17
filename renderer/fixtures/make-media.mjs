// Generates the fixture media into fixtures/media and the fixture timelines
// (fixtures/timeline.json, fixtures/timeline.stress.json).
//
// Nothing is downloaded: pictures and footage are synthesised with ffmpeg,
// logos are hand-written SVG, and the narration is spoken by the macOS `say`
// command when it exists (tone bursts otherwise). Narration is generated per
// scene and measured, and every frame number in the timeline is derived from
// those measurements - the same way the real compose step works.
//
// Requires `ffmpeg` and `ffprobe` on PATH.   Usage: node fixtures/make-media.mjs
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const media = path.join(here, "media");
fs.mkdirSync(media, { recursive: true });
const out = (name) => path.join(media, name);
const ffmpeg = (...args) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: ["ignore", "inherit", "inherit"] });
const durationOf = (file) => Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]).toString().trim());

const FPS = 30;

// --- pictures and footage ----------------------------------------------------
// A dusk landscape drawn with a per-pixel expression: sky gradient, sun, three ridgelines.
function landscape({ w, h, sky, sun, ridges }) {
	const ridge = (i) => {
		const [base, a1, f1, p1, a2, f2] = [0.6 + i * 0.105, 0.045 - i * 0.004, 0.0037 - i * 0.0009, i * 2.1, 0.02, 0.0125 + i * 0.004];
		return `(H*${base}+H*${a1}*sin(X*${f1}*2400/W+${p1})+H*${a2}*sin(X*${f2}*2400/W+${i}))`;
	};
	const channel = (c) => {
		const t = `pow(clip(Y/(H*0.66),0,1),1.6)`;
		const skyExpr = `(${sky[0][c]}+(${sky[1][c]}-${sky[0][c]})*${t})`;
		const d = `hypot(X-W*${sun.x},Y-H*${sun.y})`;
		const withSun = `if(lt(${d},H*0.058),${sun.color[c]},clip(${skyExpr}+${sun.glow[c]}*exp(-${d}/(H*0.16)),0,255))`;
		return `if(gt(Y,${ridge(2)}),${ridges[2][c]},if(gt(Y,${ridge(1)}),${ridges[1][c]},if(gt(Y,${ridge(0)}),${ridges[0][c]},${withSun})))`;
	};
	return `color=c=black:s=${w}x${h},format=rgb24,geq=r='${channel(0)}':g='${channel(1)}':b='${channel(2)}',noise=alls=5:allf=t`;
}

console.log("photo.jpg");
ffmpeg(
	"-f", "lavfi",
	"-i", landscape({ w: 2400, h: 1600, sky: [[24, 38, 84], [246, 150, 96]], sun: { x: 0.7, y: 0.52, color: [255, 240, 214], glow: [70, 44, 20] }, ridges: [[112, 96, 126], [62, 60, 96], [22, 26, 48]] }),
	"-frames:v", "1", "-q:v", "3", out("photo.jpg"),
);

// A second, cooler picture for the split scene.
console.log("photo-2.jpg");
ffmpeg(
	"-f", "lavfi",
	"-i", landscape({ w: 1800, h: 2000, sky: [[12, 44, 66], [150, 206, 196]], sun: { x: 0.34, y: 0.4, color: [250, 252, 240], glow: [40, 50, 44] }, ridges: [[70, 124, 128], [32, 82, 92], [10, 36, 46]] }),
	"-frames:v", "1", "-q:v", "3", out("photo-2.jpg"),
);

// Footage: a slow slide across a wider plate, with quiet room tone so `volume` has something to act on.
console.log("clip.mp4");
ffmpeg(
	"-f", "lavfi",
	"-i", landscape({ w: 1760, h: 720, sky: [[40, 22, 70], [240, 120, 110]], sun: { x: 0.42, y: 0.5, color: [255, 228, 210], glow: [80, 36, 30] }, ridges: [[120, 70, 110], [70, 44, 90], [26, 18, 44]] }),
	"-frames:v", "1", out("plate.png"),
);
ffmpeg(
	"-loop", "1", "-framerate", String(FPS), "-i", out("plate.png"),
	"-f", "lavfi", "-i", "anoisesrc=color=brown:amplitude=0.25:duration=6",
	"-filter_complex", `[0:v]crop=1280:720:x='min(480,t*80)':y=0,format=yuv420p[v]`,
	"-map", "[v]", "-map", "1:a", "-t", "6", "-r", String(FPS),
	"-c:v", "libx264", "-preset", "medium", "-crf", "20", "-g", "30", "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", out("clip.mp4"),
);
fs.rmSync(out("plate.png"));

// --- music and sfx -----------------------------------------------------------
// An 8 second pad (A minor add9) that loops cleanly: every partial completes whole cycles in 8s.
console.log("music.mp3");
ffmpeg(
	"-f", "lavfi",
	"-i", "aevalsrc='0.16*sin(2*PI*110*t)+0.12*sin(2*PI*164.75*t)+0.1*sin(2*PI*220*t)*(0.6+0.4*sin(2*PI*0.25*t))+0.08*sin(2*PI*261.625*t)+0.06*sin(2*PI*329.625*t)*(0.5+0.5*sin(2*PI*0.125*t+1))+0.05*sin(2*PI*493.875*t)*(0.5+0.5*sin(2*PI*0.375*t))':s=44100:d=8",
	"-ac", "2", "-c:a", "libmp3lame", "-b:a", "160k", out("music.mp3"),
);

console.log("whoosh.wav");
ffmpeg(
	"-f", "lavfi", "-i", "anoisesrc=color=pink:amplitude=0.9:duration=0.7",
	"-af", "highpass=f=300,lowpass=f=5000,afade=t=in:d=0.32:curve=exp,afade=t=out:st=0.34:d=0.36,volume=0.9",
	"-ar", "44100", "-ac", "2", out("whoosh.wav"),
);

// --- logo and watermark (SVG, drawn with strokes so no font is needed) --------
const LETTERS = {
	N: ["M0,80 L0,0 L50,80 L50,0", 50],
	O: ["M27,0 A27,40 0 1 0 27,80 A27,40 0 1 0 27,0 Z", 54],
	R: ["M0,80 L0,0 L26,0 A20,20 0 0 1 26,40 L0,40 M24,40 L48,80", 48],
	T: ["M0,0 L52,0 M26,0 L26,80", 52],
	H: ["M0,0 L0,80 M0,40 L50,40 M50,0 L50,80", 50],
	W: ["M0,0 L16,80 L34,18 L52,80 L68,0", 68],
	I: ["M0,0 L0,80", 0],
	D: ["M0,0 L0,80 L16,80 A34,40 0 0 0 16,0 Z", 50],
};
const mark = (ink, accent) =>
	`<circle cx="50" cy="50" r="42" fill="none" stroke="${ink}" stroke-width="9"/><path d="M50,18 L64,50 L50,82 L36,50 Z" fill="${accent}" transform="rotate(38 50 50)"/>`;
function logoSvg(ink, accent) {
	let x = 136;
	const glyphs = [..."NORTHWIND"].map((ch) => {
		const [d, width] = LETTERS[ch];
		const g = `<path d="${d}" transform="translate(${x},10)"/>`;
		x += width + 30;
		return g;
	});
	const width = x - 30 + 6;
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="100" viewBox="0 0 ${width} 100">${mark(ink, accent)}<g fill="none" stroke="${ink}" stroke-width="10" stroke-linecap="round" stroke-linejoin="round">${glyphs.join("")}</g></svg>`;
}
fs.writeFileSync(out("logo.svg"), logoSvg("#15171C", "#E4572E"));
fs.writeFileSync(out("logo-dark.svg"), logoSvg("#FFFFFF", "#FF7A4D"));
fs.writeFileSync(out("watermark.svg"), `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100">${mark("#FFFFFF", "#FFFFFF")}</svg>`);

// --- narration ---------------------------------------------------------------
const SCENES = [
	{ id: "open", say: "Meet Northwind. The calm way to plan a busy week." },
	{ id: "view", say: "It starts with a single view of everything on your plate." },
	{ id: "how", say: "Capture tasks in seconds. Let the schedule arrange itself. Then protect time for deep work." },
	{ id: "proof", say: "Teams using Northwind win back four hours every week." },
	{ id: "together", say: "Your calendar and your to-do list finally live in the same place." },
	{ id: "voice", say: "It feels like someone tidied my week before I even woke up." },
];

let canSay = process.platform === "darwin";
if (canSay) {
	try {
		execFileSync("say", ["-o", out("probe.aiff"), "ok"]);
		fs.rmSync(out("probe.aiff"));
	} catch {
		canSay = false;
	}
}

for (const scene of SCENES) {
	const file = out(`narration-${scene.id}.m4a`);
	console.log(path.basename(file));
	if (canSay) {
		const aiff = out(`narration-${scene.id}.aiff`);
		execFileSync("say", ["-r", "178", "-o", aiff, scene.say]);
		ffmpeg("-i", aiff, "-af", "silenceremove=start_periods=1:start_threshold=-50dB,areverse,silenceremove=start_periods=1:start_threshold=-50dB,areverse,loudnorm=I=-18", "-ar", "44100", "-ac", "1", "-c:a", "aac", "-b:a", "96k", file);
		fs.rmSync(aiff);
	} else {
		// One short tone per word: silly to listen to, but the word timings are exact.
		const words = scene.say.split(/\s+/);
		let t = 0;
		const terms = words.map((w, i) => {
			const d = 0.09 + w.replace(/\W/g, "").length * 0.045;
			const term = `0.3*sin(2*PI*${260 + (i % 5) * 40}*t)*between(t,${t.toFixed(3)},${(t + d).toFixed(3)})`;
			t += d + (/[.,]$/.test(w) ? 0.28 : 0.07);
			return term;
		});
		ffmpeg("-f", "lavfi", "-i", `aevalsrc='${terms.join("+")}':s=44100:d=${t.toFixed(3)}`, "-c:a", "aac", "-b:a", "96k", file);
	}
	scene.seconds = durationOf(file);
}

// Word timings: spread over the measured duration by word length, with a beat after punctuation.
function wordTimings(text, startFrame, frames) {
	const words = text.split(/\s+/);
	const weights = words.map((w) => w.replace(/\W/g, "").length + 1.5 + (/[.,!?]$/.test(w) ? 3.5 : 0));
	const total = weights.reduce((a, b) => a + b, 0);
	let acc = 0;
	return words.map((word, i) => {
		const start = startFrame + Math.round((acc / total) * frames);
		acc += weights[i];
		const pause = /[.,!?]$/.test(word) ? 3.5 / weights[i] : 0;
		const end = startFrame + Math.round(((acc - weights[i] * pause) / total) * frames);
		return { text: word, startFrame: start, endFrame: Math.max(start + 1, end) };
	});
}

// --- the timeline ------------------------------------------------------------
const theme = {
	colors: { primary: "#1F3A5F", secondary: "#B9A58A", accent: "#E4572E", background: "#F4F1EA", surface: "#FFFFFF", text: "#15171C", mutedText: "#5E6470" },
	fonts: { heading: { family: "Fraunces", weight: 600 }, body: { family: "DM Sans", weight: 400 } },
	radius: 14,
	motion: { energy: "balanced", textAnimation: "rise", kenBurns: "subtle" },
	captions: { enabled: true, mode: "karaoke", position: "bottom", uppercase: false, highlightColor: "#FFB23E", background: "pill" },
	scrim: 0.5,
	logo: { src: "asset://logo.svg", darkSrc: "asset://logo-dark.svg" },
	watermark: { src: "asset://watermark.svg", position: "top-right", opacity: 0.7, scale: 0.05 },
};

const LEAD = 16; // frames of air before the narration starts
const TAIL = 14; // and after it ends
const plan = [
	{ id: "open", type: "title", transition: ["cut", 0], background: { kind: "brand" }, layout: ["left", "center", "right"], content: { kicker: "Introducing", heading: "The calm way to plan a busy week", subheading: "Northwind turns a crowded calendar into a clear plan.", showLogo: true } },
	{ id: "view", type: "media", transition: ["fade", 18], background: { kind: "video", src: "asset://clip.mp4", fit: "cover", startFromSec: 0.5, loop: true, volume: 0.25, playbackRate: 1, focus: { x: 0.4, y: 0.5 } }, layout: ["left", "bottom", "right"], content: { kicker: "One view", heading: "Everything on your plate, in one place", lowerThird: { title: "Maya Okafor", subtitle: "Product lead, Northwind" } } },
	{ id: "how", type: "bullets", transition: ["slide-left", 20], background: { kind: "solid", color: "#FFFFFF" }, layout: ["left", "center", "right"], content: { kicker: "How it works", heading: "Three steps to a lighter week", bullets: ["Capture tasks in seconds", "Let the schedule arrange itself", "Protect time for deep work"] } },
	{ id: "proof", type: "stat", transition: ["zoom", 18], background: { kind: "image", src: "asset://photo.jpg", fit: "cover", focus: { x: 0.7, y: 0.5 } }, layout: ["center", "center", "right"], content: { kicker: "The result", stat: { value: "4.2 hrs", numeric: 4.2, decimals: 1, suffix: "hrs", label: "won back by every team member, every week" }, showLogo: true } },
	{ id: "together", type: "split", transition: ["wipe", 20], background: { kind: "image", src: "asset://photo-2.jpg", fit: "cover", focus: { x: 0.34, y: 0.4 } }, layout: ["left", "center", "right"], content: { kicker: "Together at last", heading: "Calendar and to-dos in the same place", body: "Drag a task onto your day and Northwind finds the time for it. Move a meeting and everything else follows." } },
	{ id: "voice", type: "quote", transition: ["slide-up", 20], background: { kind: "gradient", colors: ["#1F3A5F", "#132640"], angle: 160 }, layout: ["left", "center", "right"], content: { quote: "It feels like someone tidied my week before I even woke up.", attribution: "Priya Raman, Head of Operations at Lumen" } },
	{ id: "close", type: "outro", transition: ["fade", 20], background: { kind: "brand" }, layout: ["center", "center", "right"], content: { heading: "Plan less. Do more.", subheading: "Free for teams of up to five.", cta: { text: "Start free today", url: "https://northwind.example/start" } }, hold: 105 },
];

function build({ themeOverride = {}, mutate } = {}) {
	const scenes = [];
	const audio = [];
	const captions = [];
	const duck = [];
	let cursor = 0;

	for (const item of plan) {
		const spoken = SCENES.find((s) => s.id === item.id);
		const lead = Math.max(LEAD, item.transition[1] + 4);
		const speech = spoken ? Math.ceil(spoken.seconds * FPS) : 0;
		const durationInFrames = spoken ? lead + speech + TAIL : item.hold;
		const content = structuredClone(item.content);

		if (spoken) {
			const start = cursor + lead;
			audio.push({ id: `narration-${item.id}`, kind: "narration", src: `asset://narration-${item.id}.m4a`, startFrame: start, durationInFrames: speech, trimStartSec: 0, volume: 1, loop: false, fadeInFrames: 0, fadeOutFrames: 0 });
			duck.push([start, start + speech]);
			const words = wordTimings(spoken.say, start, speech);
			// One caption cue per sentence.
			let cue = [];
			for (const word of words) {
				cue.push(word);
				if (/[.!?]$/.test(word.text)) {
					captions.push({ startFrame: cue[0].startFrame, endFrame: Math.min(cursor + durationInFrames, word.endFrame + 8), text: cue.map((w) => w.text).join(" "), words: cue });
					cue = [];
				}
			}
			if (content.bullets) {
				// Each bullet lands as its sentence begins.
				const sentenceStarts = captions.filter((c) => c.startFrame >= start && c.startFrame < start + speech).map((c) => c.startFrame - cursor);
				content.bullets = content.bullets.map((text, i) => ({ text, atFrame: Math.max(0, (sentenceStarts[i] ?? lead) - 3) }));
			}
		}

		scenes.push({
			id: item.id,
			type: item.type,
			startFrame: cursor,
			durationInFrames,
			transition: { type: item.transition[0], durationInFrames: item.transition[1] },
			background: item.background,
			layout: { align: item.layout[0], textPosition: item.layout[1], mediaSide: item.layout[2] },
			content,
		});
		cursor += durationInFrames;
	}

	const total = cursor;
	audio.push({ id: "music", kind: "music", src: "asset://music.mp3", startFrame: 0, durationInFrames: total, trimStartSec: 0, volume: 0.5, loop: true, fadeInFrames: 20, fadeOutFrames: 45, duck: { volume: 0.12, ranges: duck, rampFrames: 10 } });
	const proof = scenes.find((s) => s.id === "proof");
	audio.push({ id: "whoosh", kind: "sfx", src: "asset://whoosh.wav", startFrame: proof.startFrame, durationInFrames: 21, trimStartSec: 0, volume: 0.7, loop: false, fadeInFrames: 0, fadeOutFrames: 4 });

	const timeline = { version: 1, fps: FPS, durationInFrames: total, theme: { ...theme, ...themeOverride }, scenes, audio, captions };
	mutate?.(timeline);
	return timeline;
}

const timeline = build();
fs.writeFileSync(path.join(here, "timeline.json"), `${JSON.stringify(timeline, null, "\t")}\n`);

// The stress variant: a dark, punchy theme with a font that does not exist, long copy everywhere,
// a missing picture, a broken clip, a missing narration file, and boxed upper-case captions at the top.
const stress = build({
	themeOverride: {
		colors: { primary: "#7C5CFF", secondary: "#19C2A0", accent: "#FFD23F", background: "#0E0F13", surface: "#1A1C23", text: "#F5F6F8", mutedText: "#9AA1AE" },
		fonts: { heading: { family: "Definitely Not A Real Font", weight: 800 }, body: { family: "Space Grotesk", weight: 400 } },
		radius: 40,
		motion: { energy: "punchy", textAnimation: "pop", kenBurns: "strong" },
		captions: { enabled: true, mode: "phrase", position: "top", uppercase: true, highlightColor: "#FFD23F", background: "box" },
		scrim: 0.6,
		watermark: { src: "asset://watermark.svg", position: "bottom-right", opacity: 0.5, scale: 0.09 },
	},
	mutate(t) {
		const scene = (id) => t.scenes.find((s) => s.id === id);
		scene("open").content.heading = "An unreasonably long headline that keeps going well past the point where a sensible editor would have stopped it, to prove nothing overflows";
		scene("open").content.subheading = "Followed by a subheading that is also far longer than it should be, because real customers paste whole paragraphs into every field they are given.";
		scene("open").layout.align = "center";
		scene("view").background.src = "asset://missing-clip.mp4";
		scene("how").content.bullets.push(
			{ text: "A fourth point with a Supercalifragilisticexpialidocious-length word and a long tail of extra explanation", atFrame: 150 },
			{ text: "And a fifth, because lists grow", atFrame: 170 },
		);
		scene("how").background = { kind: "brand" };
		scene("proof").background.src = "asset://missing-photo.jpg";
		scene("proof").content.stat = { value: "1,284,000", numeric: 1284000, prefix: "$", label: "in pipeline influenced during the first quarter after launch" };
		scene("together").layout.mediaSide = "left";
		scene("together").content.bullets = [{ text: "Works with the tools you have", atFrame: 30 }, { text: "No migration weekend", atFrame: 60 }];
		scene("voice").layout.align = "center";
		scene("voice").content.quote = "We replaced three planning tools, two spreadsheets and a standing Monday meeting, and nobody on the team has asked for any of them back since.";
		scene("close").content.heading = "Start planning the calm way";
		t.audio.find((a) => a.id === "narration-voice").src = "asset://missing-narration.m4a";
	},
});
fs.writeFileSync(path.join(here, "timeline.stress.json"), `${JSON.stringify(stress, null, "\t")}\n`);

console.log(`timeline.json: ${timeline.scenes.length} scenes, ${timeline.durationInFrames} frames (${(timeline.durationInFrames / FPS).toFixed(1)}s), narration by ${canSay ? "say" : "tone bursts"}`);
for (const s of timeline.scenes) console.log(`  ${String(s.startFrame).padStart(4)}  ${s.type.padEnd(8)} ${s.id.padEnd(9)} ${s.durationInFrames}f  ${s.transition.type}`);
