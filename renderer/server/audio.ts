/**
 * Listens to a timeline without rendering it: every audio clip is decoded with
 * the ffmpeg Remotion ships, mixed the way AudioLayer mixes it (same trims,
 * loops, fades and ducking, via the same `volumeAt`), and the mix and its stems
 * are measured.
 *
 * Loudness follows ITU-R BS.1770 / EBU R128 (K-weighting, 400 ms blocks,
 * absolute and relative gating), so the numbers line up with what YouTube and
 * other platforms measure.
 */
import { RenderInternals } from "@remotion/renderer";
import type { Timeline, TimelineAudio } from "../../shared/timeline.ts";
import { volumeAt } from "../src/lib/audio.ts";

/** Analysis sample rate. Loudness is defined at any rate; 24 kHz keeps buffers small. */
const RATE = 24_000;
/** Loudness is computed on 100 ms hops; a 400 ms block is four of them. */
const HOP = RATE / 10;
const SILENCE_LUFS = -50;
const MAX_SECONDS = 20 * 60;

type Stereo = { l: Float32Array; r: Float32Array };
type StemKind = "narration" | "music" | "sfx" | "clip";

/**
 * The samples of a 16-bit WAV stream as stereo floats. ffmpeg writing to a pipe
 * cannot go back to fill in sizes, so the data chunk simply runs to the end.
 *
 * Mono is copied to both sides at full level, the way the rendered video plays
 * it (ffmpeg's own upmix would put it 3 dB lower). Beyond two channels, the
 * first two are used.
 */
function wavSamples(all: Buffer): Stereo {
	let channels = 2;
	let offset = 12;
	while (offset + 8 <= all.length && all.toString("ascii", offset, offset + 4) !== "data") {
		if (all.toString("ascii", offset, offset + 4) === "fmt ") channels = all.readUInt16LE(offset + 10);
		offset += 8 + all.readUInt32LE(offset + 4);
	}
	const data = all.subarray(Math.min(all.length, offset + 8));
	const stride = 2 * Math.max(1, channels);
	const samples = Math.floor(data.length / stride);
	const l = new Float32Array(samples);
	const r = new Float32Array(samples);
	for (let i = 0; i < samples; i++) {
		l[i] = data.readInt16LE(i * stride) / 32768;
		r[i] = channels > 1 ? data.readInt16LE(i * stride + 2) / 32768 : l[i]!;
	}
	return { l, r };
}

/** Decodes up to `seconds` of a file from `startSec`, as stereo PCM at RATE (the bundled ffmpeg only writes PCM as WAV). */
function decode(src: string, startSec: number, seconds: number): Promise<Stereo> {
	return new Promise((resolve, reject) => {
		const task = RenderInternals.callFf({
			bin: "ffmpeg",
			args: [
				"-hide_banner",
				"-loglevel",
				"error",
				...(startSec > 0 ? ["-ss", startSec.toFixed(3)] : []),
				"-t",
				seconds.toFixed(3),
				"-i",
				src,
				"-vn",
				"-ar",
				String(RATE),
				"-c:a",
				"pcm_s16le",
				"-f",
				"wav",
				"pipe:1",
			],
			indent: false,
			logLevel: "error",
			binariesDirectory: null,
			cancelSignal: undefined,
			// Streamed rather than buffered: ten minutes of PCM is larger than execa's buffer limit.
			options: { buffer: false },
		});
		const chunks: Buffer[] = [];
		let stderr = "";
		task.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
		task.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
		task.then(() => resolve(wavSamples(Buffer.concat(chunks))), (err: Error) => {
			const reason = stderr.trim().split("\n").slice(-2).join(" ") || err.message;
			reject(new Error(reason.replace(/(https?:\/\/[^\s?"')]+)\?[^\s"')]*/g, "$1")));
		});
	});
}

// --- loudness ------------------------------------------------------------------

/** K-weighting as two biquads (pre-filter shelf + RLB high-pass), coefficients for RATE (libebur128's derivation). */
function kWeight(input: Float32Array): Float32Array {
	const out = new Float32Array(input.length);
	let f0 = 1681.974450955533;
	const G = 3.999843853973347;
	let Q = 0.7071752369554196;
	let K = Math.tan((Math.PI * f0) / RATE);
	const Vh = 10 ** (G / 20);
	const Vb = Vh ** 0.4996667741545416;
	let a0 = 1 + K / Q + K * K;
	const b = [(Vh + (Vb * K) / Q + K * K) / a0, (2 * (K * K - Vh)) / a0, (Vh - (Vb * K) / Q + K * K) / a0];
	const a = [(2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0];
	f0 = 38.13547087602444;
	Q = 0.5003270373238773;
	K = Math.tan((Math.PI * f0) / RATE);
	a0 = 1 + K / Q + K * K;
	const c = [(2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0];
	let x1 = 0, x2 = 0, y1 = 0, y2 = 0, z1 = 0, z2 = 0;
	for (let i = 0; i < input.length; i++) {
		const x = input[i]!;
		const y = b[0]! * x + b[1]! * x1 + b[2]! * x2 - a[0]! * y1 - a[1]! * y2;
		x2 = x1;
		x1 = x;
		// High-pass: numerator [1, -2, 1].
		const z = y - 2 * y1 + y2 - c[0]! * z1 - c[1]! * z2;
		y2 = y1;
		y1 = y;
		z2 = z1;
		z1 = z;
		out[i] = z;
	}
	return out;
}

/** Mean square of the K-weighted signal per 100 ms hop, both channels summed (BS.1770 channel weights are 1 for L/R). */
function hopPower(signal: Stereo): Float64Array {
	const l = kWeight(signal.l);
	const r = kWeight(signal.r);
	const hops = Math.floor(l.length / HOP);
	const power = new Float64Array(hops);
	for (let h = 0; h < hops; h++) {
		let sum = 0;
		for (let i = h * HOP; i < (h + 1) * HOP; i++) sum += l[i]! * l[i]! + r[i]! * r[i]!;
		power[h] = sum / HOP;
	}
	return power;
}

const lufs = (power: number) => (power > 0 ? -0.691 + 10 * Math.log10(power) : -Infinity);

/** Momentary loudness (400 ms) ending at each hop. */
function momentary(power: Float64Array): Float64Array {
	const out = new Float64Array(power.length);
	for (let h = 0; h < power.length; h++) {
		let sum = 0;
		let n = 0;
		for (let k = Math.max(0, h - 3); k <= h; k++, n++) sum += power[k]!;
		out[h] = lufs(sum / Math.max(1, n));
	}
	return out;
}

/** Gated integrated loudness over hops [from, to). -Infinity when the stretch is silent. */
function integrated(power: Float64Array, from = 0, to = power.length): number {
	const blocks: number[] = [];
	for (let h = Math.max(from + 3, 3); h < to; h++) blocks.push((power[h - 3]! + power[h - 2]! + power[h - 1]! + power[h]!) / 4);
	if (!blocks.length && to - from > 0) {
		let sum = 0;
		for (let h = from; h < to; h++) sum += power[h]!;
		blocks.push(sum / (to - from));
	}
	const loud = blocks.filter((z) => lufs(z) > -70);
	if (!loud.length) return -Infinity;
	const threshold = lufs(loud.reduce((s, z) => s + z, 0) / loud.length) - 10;
	const gated = loud.filter((z) => lufs(z) > threshold);
	return lufs(gated.reduce((s, z) => s + z, 0) / gated.length);
}

const median = (values: number[]) => {
	if (!values.length) return NaN;
	const sorted = [...values].sort((x, y) => x - y);
	return sorted[Math.floor(sorted.length / 2)]!;
};
const round1 = (n: number) => (Number.isFinite(n) ? Math.round(n * 10) / 10 : null);
const dbfs = (amplitude: number) => (amplitude > 0 ? 20 * Math.log10(amplitude) : -Infinity);

// --- analysis --------------------------------------------------------------------

export type AudioAnalysis = {
	analysedSec: number;
	fromSec: number;
	mix: { lufs: number | null; peakDbfs: number | null; clippedMs: number; clipAtSec: number[] };
	stems: Partial<Record<StemKind, { lufs: number | null }>>;
	/** Narration minus music, LU, over the moments someone is speaking (median and the worst tenth). */
	speechOverMusic: { medianLu: number | null; worstLu: number | null } | null;
	scenes: {
		id: string;
		startSec: number;
		endSec: number;
		mixLufs: number | null;
		narrationLufs: number | null;
		musicLufs: number | null;
		speechOverMusicLu: number | null;
		peakDbfs: number | null;
	}[];
	/** Stretches where the mix is close to silent, at least a second long. */
	silences: { startSec: number; endSec: number }[];
	/** Mix momentary loudness once a second, LUFS (null = silent). */
	profile?: (number | null)[];
	/** Clips that could not be decoded and were left out of the measurement. */
	skipped: { id: string; reason: string }[];
};

/** A clip's audio as the timeline plays it, written into `into` (which starts at `originFrame`). */
async function mixClip(
	clip: Pick<TimelineAudio, "src" | "startFrame" | "durationInFrames" | "trimStartSec" | "loop"> & { gain: (frame: number) => number },
	fps: number,
	into: Stereo,
	originFrame: number,
): Promise<void> {
	const clipSec = clip.durationInFrames / fps;
	const source = await decode(clip.src, clip.trimStartSec, clipSec);
	const length = source.l.length;
	if (!length) return;
	const start = Math.round(((clip.startFrame - originFrame) / fps) * RATE);
	const samples = Math.round(clipSec * RATE);
	for (let i = 0; i < samples; i++) {
		const at = start + i;
		if (at < 0) continue;
		if (at >= into.l.length) break;
		let s = i;
		if (s >= length) {
			if (!clip.loop) break;
			s %= length;
		}
		const frame = clip.startFrame + Math.floor((i * fps) / RATE);
		const v = clip.gain(frame);
		if (v === 0) continue;
		into.l[at]! += source.l[s]! * v;
		into.r[at]! += source.r[s]! * v;
	}
}

export async function analyseAudio(timeline: Timeline, options: { fromFrame?: number; toFrame?: number; profile?: boolean } = {}): Promise<AudioAnalysis> {
	const { fps } = timeline;
	const fromFrame = Math.max(0, options.fromFrame ?? 0);
	const toFrame = Math.min(timeline.durationInFrames, options.toFrame ?? timeline.durationInFrames);
	if (toFrame <= fromFrame) throw new RangeError("the range to analyse is empty");
	const seconds = (toFrame - fromFrame) / fps;
	if (seconds > MAX_SECONDS) throw new RangeError(`at most ${MAX_SECONDS / 60} minutes can be analysed at once`);
	const samples = Math.ceil(seconds * RATE);
	const blank = (): Stereo => ({ l: new Float32Array(samples), r: new Float32Array(samples) });
	const stems: Partial<Record<StemKind, Stereo>> = {};
	const skipped: AudioAnalysis["skipped"] = [];

	type Job = { id: string; kind: StemKind; clip: Parameters<typeof mixClip>[0] };
	const work: Job[] = timeline.audio.map((clip) => ({ id: clip.id, kind: clip.kind, clip: { ...clip, gain: (frame: number) => volumeAt(clip, frame) } }));
	// Footage with its own sound turned up plays under the scene, like the narration does.
	for (const scene of timeline.scenes) {
		const bg = scene.background;
		if (bg.kind !== "video" || bg.volume <= 0) continue;
		work.push({
			id: `clip-${scene.id}`,
			kind: "clip",
			clip: { src: bg.src, startFrame: scene.startFrame, durationInFrames: scene.durationInFrames, trimStartSec: bg.startFromSec, loop: bg.loop, gain: () => bg.volume },
		});
	}
	const overlapping = work.filter(({ clip }) => clip.startFrame < toFrame && clip.startFrame + clip.durationInFrames > fromFrame);

	// A few decodes at a time: each is its own ffmpeg process.
	const queue = [...overlapping];
	await Promise.all(
		Array.from({ length: 4 }, async () => {
			for (let job = queue.shift(); job; job = queue.shift()) {
				const stem = (stems[job.kind] ??= blank());
				try {
					await mixClip(job.clip, fps, stem, fromFrame);
				} catch (err) {
					skipped.push({ id: job.id, reason: (err instanceof Error ? err.message : String(err)).slice(0, 200) });
				}
			}
		}),
	);

	const mix = blank();
	for (const stem of Object.values(stems)) {
		for (let i = 0; i < samples; i++) {
			mix.l[i]! += stem.l[i]!;
			mix.r[i]! += stem.r[i]!;
		}
	}
	let peak = 0;
	let clipped = 0;
	const clipAt: number[] = [];
	for (let i = 0; i < samples; i++) {
		const a = Math.max(Math.abs(mix.l[i]!), Math.abs(mix.r[i]!));
		if (a > peak) peak = a;
		if (a >= 1) {
			clipped++;
			const sec = Math.round((fromFrame / fps + i / RATE) * 10) / 10;
			if (clipAt.length < 10 && clipAt.at(-1) !== sec) clipAt.push(sec);
		}
	}

	const mixPower = hopPower(mix);
	const mixMomentary = momentary(mixPower);
	const stemPower = Object.fromEntries(Object.entries(stems).map(([kind, stem]) => [kind, hopPower(stem)])) as Partial<Record<StemKind, Float64Array>>;
	const narrationMomentary = stemPower.narration ? momentary(stemPower.narration) : null;
	const musicMomentary = stemPower.music ? momentary(stemPower.music) : null;
	const hops = mixPower.length;
	const hopAt = (frame: number) => Math.max(0, Math.min(hops, Math.round(((frame - fromFrame) / fps) * 10)));

	/** Narration-over-music gaps on the hops in [from, to) where someone is speaking over music. */
	const gaps = (from: number, to: number) => {
		const out: number[] = [];
		if (!narrationMomentary || !musicMomentary) return out;
		for (let h = from; h < to; h++) {
			const speech = narrationMomentary[h]!;
			const music = musicMomentary[h]!;
			if (speech > -40 && music > -70) out.push(speech - music);
		}
		return out;
	};
	const allGaps = gaps(0, hops);
	const sortedGaps = [...allGaps].sort((x, y) => x - y);

	const silences: AudioAnalysis["silences"] = [];
	let quietFrom = -1;
	for (let h = 0; h <= hops; h++) {
		const quiet = h < hops && !(mixMomentary[h]! > SILENCE_LUFS);
		if (quiet && quietFrom < 0) quietFrom = h;
		if (!quiet && quietFrom >= 0) {
			if (h - quietFrom >= 10) silences.push({ startSec: round1(fromFrame / fps + quietFrom / 10)!, endSec: round1(fromFrame / fps + h / 10)! });
			quietFrom = -1;
		}
	}

	const scenes = timeline.scenes
		.filter((scene) => scene.startFrame < toFrame && scene.startFrame + scene.durationInFrames > fromFrame)
		.map((scene) => {
			const a = hopAt(Math.max(fromFrame, scene.startFrame));
			const b = hopAt(Math.min(toFrame, scene.startFrame + scene.durationInFrames));
			let scenePeak = 0;
			const s0 = Math.round(((Math.max(fromFrame, scene.startFrame) - fromFrame) / fps) * RATE);
			const s1 = Math.min(samples, Math.round(((Math.min(toFrame, scene.startFrame + scene.durationInFrames) - fromFrame) / fps) * RATE));
			for (let i = s0; i < s1; i++) scenePeak = Math.max(scenePeak, Math.abs(mix.l[i]!), Math.abs(mix.r[i]!));
			return {
				id: scene.id,
				startSec: round1(scene.startFrame / fps)!,
				endSec: round1((scene.startFrame + scene.durationInFrames) / fps)!,
				mixLufs: round1(integrated(mixPower, a, b)),
				narrationLufs: stemPower.narration ? round1(integrated(stemPower.narration, a, b)) : null,
				musicLufs: stemPower.music ? round1(integrated(stemPower.music, a, b)) : null,
				speechOverMusicLu: round1(median(gaps(a, b))),
				peakDbfs: round1(dbfs(scenePeak)),
			};
		});

	return {
		analysedSec: round1(seconds)!,
		fromSec: round1(fromFrame / fps)!,
		mix: { lufs: round1(integrated(mixPower)), peakDbfs: round1(dbfs(peak)), clippedMs: Math.round((clipped / RATE) * 1000), clipAtSec: clipAt },
		stems: Object.fromEntries(Object.entries(stemPower).map(([kind, power]) => [kind, { lufs: round1(integrated(power)) }])),
		speechOverMusic: allGaps.length ? { medianLu: round1(median(allGaps)), worstLu: round1(sortedGaps[Math.floor(sortedGaps.length * 0.1)]!) } : null,
		scenes,
		silences,
		...(options.profile ? { profile: Array.from({ length: Math.ceil(hops / 10) }, (_, s) => round1(mixMomentary[Math.min(hops - 1, s * 10 + 9)]!)) } : {}),
		skipped,
	};
}
