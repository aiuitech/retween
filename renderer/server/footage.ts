/**
 * Footage processing: turns a person's own recording (a phone video of them
 * talking, a voice memo) into material the editor can use.
 *
 *   video.mp4  H.264, constant 30 fps, upright, SDR, short side at most 1080 px,
 *              a keyframe every second (fast, exact seeking), the original sound as AAC
 *   audio.m4a  the voice: mono 48 kHz AAC, high-passed (optionally de-noised) and
 *              loudness-normalised to -16 LUFS (two-pass loudnorm)
 *
 * plus where the picture cuts (scene-change detection) and where the sound goes
 * silent. Phone footage is usually HEVC, often HDR, variable frame rate and
 * rotated by metadata; Chrome and Remotion cope badly with all four, so the
 * edit master fixes them once.
 *
 * Uses real ffmpeg/ffprobe from PATH (FFMPEG_PATH / FFPROBE_PATH override): the
 * build Remotion ships has no encoders worth using and no TLS.
 */
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, statSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";

const FFMPEG = process.env.FFMPEG_PATH ?? "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH ?? "ffprobe";
const ROOT = path.join(process.env.OUTPUT_DIR ?? tmpdir(), "footage");
const MAX_SECONDS = 3 * 3600;
const FPS = 30;
const MAX_SHORT_SIDE = 1080;
const KEEP_JOBS = 3;
/**
 * The voice track is mono, and the video plays mono on both channels at full
 * level, which measures 3 dB louder (BS.1770 sums the channels). So the file is
 * levelled to -19 for the voice to play at -16 LUFS, like generated narration.
 */
const TARGET_LUFS = -19;
/** What a mono level measures once played on both channels. */
const AS_PLAYED = 3.01;

export interface FootageResult {
	/** Of the outputs. */
	durationSec: number;
	hasVideo: boolean;
	hasAudio: boolean;
	video?: {
		width: number;
		height: number;
		fps: number;
		sourceFps: number;
		variableFrameRate: boolean;
		/** Clockwise degrees the source asked to be turned (already applied to the output). */
		rotation: number;
		hdr: boolean;
		sourceCodec: string;
		bytes: number;
	};
	audio?: { bytes: number; sourceLufs: number | null; lufs: number | null; peakDbfs: number | null; channels: 1 };
	/** Seconds where the picture cuts to a new shot, ascending, excluding 0. */
	shots: number[];
	/** [start, end] seconds with no sound for at least 0.6 s (measured on the normalised voice). */
	silences: [number, number][];
	warnings: string[];
}

export type FootageStage = "downloading" | "probing" | "transcoding" | "audio" | "done";

export interface FootageStatus {
	jobId: string;
	state: "running" | "done" | "error";
	stage: FootageStage;
	progress: number;
	error?: string;
	result?: FootageResult;
}

interface Job {
	status: FootageStatus;
	dir: string;
}

const jobs = new Map<string, Job>();

/** Signed links must never reach a caller or a log. */
const redact = (text: string) => text.replace(/(https?:\/\/[^\s?"')\]]+)\?[^\s"')\]]*/g, "$1");

export const getFootageStatus = (jobId: string): FootageStatus | undefined => jobs.get(jobId)?.status;

export function footageRunning(): string | undefined {
	for (const [id, job] of jobs) if (job.status.state === "running") return id;
	return undefined;
}

/** The output file of a job, if it exists. */
export function footageOutput(jobId: string, file: "video" | "audio"): string | undefined {
	const job = jobs.get(jobId);
	if (!job || job.status.state !== "done") return undefined;
	const out = path.join(job.dir, file === "video" ? "video.mp4" : "audio.m4a");
	return existsSync(out) ? out : undefined;
}

export async function deleteFootage(jobId: string): Promise<boolean> {
	const job = jobs.get(jobId);
	if (!job) return false;
	if (job.status.state === "running") throw new Error("the job is still running");
	jobs.delete(jobId);
	await rm(job.dir, { recursive: true, force: true });
	return true;
}

/**
 * Starts a job in the background and returns its status. The same jobId again
 * returns the existing job (callers retry); a different one while a job runs throws.
 */
export function startFootage(jobId: string, src: string, options: { denoise?: boolean } = {}): FootageStatus {
	const existing = jobs.get(jobId);
	if (existing && existing.status.state !== "error") return existing.status;
	const running = footageRunning();
	if (running && running !== jobId) throw Object.assign(new Error(`footage job ${running} is still running`), { busy: true });

	const dir = path.join(ROOT, jobId.replace(/[^\w.-]+/g, "_"));
	const job: Job = { status: { jobId, state: "running", stage: "downloading", progress: 0 }, dir };
	jobs.delete(jobId);
	jobs.set(jobId, job);
	// Forget the oldest finished jobs and their files.
	for (const [id, old] of jobs) {
		if (jobs.size <= KEEP_JOBS) break;
		if (old.status.state === "running" || id === jobId) continue;
		jobs.delete(id);
		void rm(old.dir, { recursive: true, force: true });
	}
	processFootage(job, src, options).then(
		(result) => {
			job.status = { jobId, state: "done", stage: "done", progress: 1, result };
		},
		(err: unknown) => {
			job.status = { ...job.status, state: "error", error: redact(err instanceof Error ? err.message : String(err)).slice(0, 600) };
		},
	);
	return job.status;
}

/** Runs a job to the end in the foreground (tests, scripts). */
export async function runFootage(jobId: string, src: string, options: { denoise?: boolean } = {}): Promise<FootageStatus> {
	startFootage(jobId, src, options);
	for (;;) {
		const status = jobs.get(jobId)!.status;
		if (status.state !== "running") return status;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

// --- processes ----------------------------------------------------------------------

interface RunResult {
	stderr: string;
}

/**
 * Runs ffmpeg/ffprobe. stdout lines go to `onStdout` (ffmpeg's -progress), stderr
 * lines to `onStderr`; the last stderr lines become the error on failure.
 */
function run(bin: string, args: string[], hooks: { onStdout?: (line: string) => void; onStderr?: (line: string) => void; keepStderr?: boolean } = {}): Promise<RunResult & { stdout: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		const tail: string[] = [];
		const lines = (onLine: ((line: string) => void) | undefined, sink: (text: string) => void) => {
			let rest = "";
			return (chunk: Buffer) => {
				const text = chunk.toString();
				sink(text);
				rest += text;
				const parts = rest.split(/\r?\n|\r/);
				rest = parts.pop() ?? "";
				for (const line of parts) onLine?.(line);
			};
		};
		child.stdout.on(
			"data",
			lines(hooks.onStdout, (text) => {
				if (!hooks.onStdout) stdout += text;
			}),
		);
		child.stderr.on(
			"data",
			lines(
				(line) => {
					if (line.trim()) {
						tail.push(line.trim());
						if (tail.length > 40) tail.shift();
					}
					hooks.onStderr?.(line);
				},
				(text) => {
					if (hooks.keepStderr) stderr += text;
				},
			),
		);
		child.on("error", (err) => reject(new Error(`${path.basename(bin)} could not start: ${err.message}`)));
		child.on("close", (code) => {
			if (code === 0) return resolve({ stdout, stderr });
			// Skip ffmpeg's closing statistics and generic sign-off so the cause is what remains.
			const noise = /^\s*(Press|frame=|size=)|Qavg|Conversion failed|Nothing was written|Terminating thread|Task finished|\] (frame [IPB]|mb [IPB]|consecutive|kb\/s|8x8|coded y|i16|i8|i4|Weighted|ref [PB]|video:|audio:)/;
			const reason = tail.filter((line) => !noise.test(line)).slice(-2).join(" ") || `exit code ${code}`;
			reject(new Error(`${path.basename(bin)} failed: ${redact(reason)}`));
		});
	});
}

let zscale: Promise<boolean> | undefined;
/** Whether this ffmpeg has the zscale filter (needed for a proper HDR -> SDR tone map). */
function hasZscale(): Promise<boolean> {
	zscale ??= run(FFMPEG, ["-hide_banner", "-filters"]).then(
		({ stdout }) => /\szscale\s/.test(stdout),
		() => false,
	);
	return zscale;
}

// --- probing ----------------------------------------------------------------------------

interface ProbeStream {
	index: number;
	codec_type?: string;
	codec_name?: string;
	width?: number;
	height?: number;
	r_frame_rate?: string;
	avg_frame_rate?: string;
	color_transfer?: string;
	channels?: number;
	duration?: string;
	disposition?: { attached_pic?: number };
	tags?: Record<string, string>;
	side_data_list?: { side_data_type?: string; rotation?: number }[];
}

interface Probe {
	streams?: ProbeStream[];
	format?: { duration?: string };
}

async function probe(file: string): Promise<Probe> {
	const { stdout } = await run(FFPROBE, ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", file]);
	return JSON.parse(stdout) as Probe;
}

const rate = (fraction?: string): number => {
	const [n, d] = (fraction ?? "0/1").split("/").map(Number);
	return n && d ? n / d : 0;
};

/** Clockwise degrees, 0/90/180/270. A display matrix rotation is counter-clockwise. */
function rotationOf(stream: ProbeStream): number {
	const matrix = stream.side_data_list?.find((side) => typeof side.rotation === "number");
	const degrees = matrix ? -matrix.rotation! : Number(stream.tags?.rotate ?? 0);
	return (((Math.round(degrees / 90) * 90) % 360) + 360) % 360;
}

const durationOf = (info: Probe) => {
	const values = [Number(info.format?.duration), ...(info.streams ?? []).map((stream) => Number(stream.duration))].filter((v) => Number.isFinite(v) && v > 0);
	return values.length ? Math.max(...values) : 0;
};

/** Output size: upright, short side at most 1080, never upscaled, even. */
function targetSize(width: number, height: number, rotation: number): { width: number; height: number } {
	const [w, h] = rotation % 180 === 90 ? [height, width] : [width, height];
	const k = Math.min(1, MAX_SHORT_SIDE / Math.min(w, h));
	const even = (n: number) => Math.max(2, Math.round((n * k) / 2) * 2);
	return { width: even(w), height: even(h) };
}

// --- the job ------------------------------------------------------------------------------

async function download(src: string, file: string, onProgress: (fraction: number) => void): Promise<void> {
	const response = await fetch(src, { signal: AbortSignal.timeout(30 * 60_000) });
	if (!response.ok || !response.body) throw new Error(`could not download the footage (HTTP ${response.status})`);
	const total = Number(response.headers.get("content-length")) || 0;
	let received = 0;
	const body = Readable.fromWeb(response.body as WebReadableStream<Uint8Array>);
	body.on("data", (chunk: Buffer) => {
		received += chunk.length;
		if (total) onProgress(Math.min(1, received / total));
	});
	await pipeline(body, createWriteStream(file));
}

/** ffmpeg's -progress output: out_time_us as a fraction of `seconds`. */
const progressOf = (seconds: number, report: (fraction: number) => void) => (line: string) => {
	const m = /^out_time_us=(\d+)/.exec(line);
	if (m && seconds > 0) report(Math.min(1, Number(m[1]) / 1e6 / seconds));
};

/** The last JSON object ffmpeg printed (loudnorm's report). */
function lastJson(stderr: string): Record<string, string> | null {
	const end = stderr.lastIndexOf("}");
	const start = stderr.lastIndexOf("{", end);
	if (start < 0 || end < 0) return null;
	try {
		return JSON.parse(stderr.slice(start, end + 1)) as Record<string, string>;
	} catch {
		return null;
	}
}

const finite = (value: string | undefined): number | null => {
	const n = Number(value);
	return Number.isFinite(n) ? Math.round(n * 10) / 10 : null;
};

async function processFootage(job: Job, src: string, options: { denoise?: boolean }): Promise<FootageResult> {
	const set = (stage: FootageStage, progress: number) => {
		job.status = { ...job.status, stage, progress: Math.round(progress * 1000) / 1000 };
	};
	await rm(job.dir, { recursive: true, force: true });
	await mkdir(job.dir, { recursive: true });
	const source = path.join(job.dir, "source");
	await download(src, source, (f) => set("downloading", f * 0.1));

	set("probing", 0.1);
	const info = await probe(source).catch((err: Error) => {
		throw new Error(`this file could not be read as video or audio (${err.message.replace(/^ffprobe failed: /, "")})`);
	});
	const streams = info.streams ?? [];
	const videoStream = streams.find((s) => s.codec_type === "video" && !s.disposition?.attached_pic);
	const audioStream = streams.find((s) => s.codec_type === "audio");
	if (!videoStream && !audioStream) throw new Error("this file has neither a picture nor sound");
	const sourceSec = durationOf(info);
	if (sourceSec > MAX_SECONDS) throw new Error(`the footage is ${(sourceSec / 3600).toFixed(1)} hours long; at most ${MAX_SECONDS / 3600} hours can be processed`);
	if (!(sourceSec > 0)) throw new Error("the footage has no duration (is it a still image?)");

	const warnings: string[] = [];
	const shots: number[] = [];
	const silences: [number, number][] = [];
	const result: FootageResult = { durationSec: 0, hasVideo: Boolean(videoStream), hasAudio: Boolean(audioStream), shots, silences, warnings };
	// Progress budget: video takes most of the time when there is one.
	const videoShare = videoStream ? (audioStream ? 0.7 : 0.9) : 0;
	const audioFrom = 0.1 + videoShare;

	if (videoStream) {
		set("transcoding", 0.1);
		const rotation = rotationOf(videoStream);
		const hdr = /smpte2084|arib-std-b67/.test(videoStream.color_transfer ?? "");
		const size = targetSize(videoStream.width ?? 1920, videoStream.height ?? 1080, rotation);
		const filters: string[] = [];
		if (hdr) {
			if (await hasZscale()) {
				filters.push("zscale=t=linear:npl=100", "format=gbrpf32le", "zscale=p=bt709", "tonemap=tonemap=hable:desat=0", "zscale=t=bt709:m=bt709:r=tv");
			} else {
				warnings.push("The footage is HDR and this ffmpeg cannot tone-map it, so its colours may look flat or washed out.");
			}
		}
		filters.push(`scale=${size.width}:${size.height}:flags=lanczos`, "setsar=1", `fps=${FPS}`, "format=yuv420p");
		// The detection branch always passes the first frame (ignored below): a single take with no cuts would
		// otherwise send nothing to the null output, which newer ffmpeg treats as an error.
		const graph = `[0:${videoStream.index}]${filters.join(",")},split=2[enc][det];[det]scale=192:-2,select='eq(n\\,0)+gt(scene\\,0.3)',showinfo[cuts]`;
		const output = path.join(job.dir, "video.mp4");
		await run(
			FFMPEG,
			[
				"-hide_banner",
				"-nostdin",
				"-y",
				"-loglevel",
				"info",
				"-nostats",
				"-progress",
				"pipe:1",
				"-i",
				source,
				"-filter_complex",
				graph,
				"-map",
				"[enc]",
				...(audioStream ? ["-map", `0:${audioStream.index}`, "-c:a", "aac", "-b:a", "160k", "-ac", String(Math.min(2, audioStream.channels ?? 2))] : []),
				"-c:v",
				"libx264",
				"-preset",
				"veryfast",
				"-crf",
				"20",
				"-pix_fmt",
				"yuv420p",
				"-profile:v",
				"high",
				"-g",
				String(FPS),
				"-keyint_min",
				String(FPS),
				"-sc_threshold",
				"0",
				"-r",
				String(FPS),
				"-color_primaries",
				"bt709",
				"-color_trc",
				"bt709",
				"-colorspace",
				"bt709",
				"-movflags",
				"+faststart",
				"-map_metadata",
				"-1",
				output,
				"-map",
				"[cuts]",
				"-f",
				"null",
				"-",
			],
			{
				onStdout: progressOf(sourceSec, (f) => set("transcoding", 0.1 + f * videoShare)),
				onStderr: (line) => {
					if (!line.includes("Parsed_showinfo")) return;
					const m = /pts_time:\s*([\d.]+)/.exec(line);
					const at = m ? Math.round(Number(m[1]) * 100) / 100 : 0;
					if (at > 0.05 && (!shots.length || at - shots.at(-1)! > 0.2)) shots.push(at);
				},
			},
		);
		const out = await probe(output);
		const outVideo = out.streams?.find((s) => s.codec_type === "video");
		const sourceFps = rate(videoStream.avg_frame_rate) || rate(videoStream.r_frame_rate);
		const nominal = rate(videoStream.r_frame_rate);
		result.video = {
			width: outVideo?.width ?? size.width,
			height: outVideo?.height ?? size.height,
			fps: FPS,
			sourceFps: Math.round(sourceFps * 100) / 100,
			variableFrameRate: nominal > 0 && sourceFps > 0 && Math.abs(nominal - sourceFps) / nominal > 0.01,
			rotation,
			hdr,
			sourceCodec: videoStream.codec_name ?? "unknown",
			bytes: statSync(output).size,
		};
		result.durationSec = durationOf(out);
	}

	if (audioStream) {
		set("audio", audioFrom);
		const share = 1 - audioFrom;
		const chain = ["aformat=channel_layouts=mono", "highpass=f=70", ...(options.denoise ? ["afftdn=nr=10:nf=-40"] : [])];
		// Pass 1: measure.
		const measure = await run(
			FFMPEG,
			["-hide_banner", "-nostdin", "-nostats", "-progress", "pipe:1", "-i", source, "-map", `0:${audioStream.index}`, "-af", [...chain, `loudnorm=I=${TARGET_LUFS}:TP=-1.5:LRA=11:print_format=json`].join(","), "-f", "null", "-"],
			{ onStdout: progressOf(sourceSec, (f) => set("audio", audioFrom + f * share * 0.4)), keepStderr: true },
		);
		const measured = lastJson(measure.stderr);
		// Reported as the video will play it (see AS_PLAYED), so it compares with narration and with video.audio.
		const played = (lufs: number | null) => (lufs === null ? null : Math.round((lufs + AS_PLAYED) * 10) / 10);
		const sourceLufs = played(finite(measured?.input_i));
		// Pass 2: apply (linear when loudnorm can), then find silences on the normalised voice.
		const normalise =
			measured && sourceLufs !== null
				? `loudnorm=I=${TARGET_LUFS}:TP=-1.5:LRA=11:measured_I=${measured.input_i}:measured_TP=${measured.input_tp}:measured_LRA=${measured.input_lra}:measured_thresh=${measured.input_thresh}:offset=${measured.target_offset}:linear=true:print_format=json`
				: null;
		if (!normalise) warnings.push("The sound is silent or could not be measured, so its level was left as it is.");
		const output = path.join(job.dir, "audio.m4a");
		let silentFrom: number | null = null;
		const apply = await run(
			FFMPEG,
			[
				"-hide_banner",
				"-nostdin",
				"-y",
				"-nostats",
				"-progress",
				"pipe:1",
				"-i",
				source,
				"-map",
				`0:${audioStream.index}`,
				"-af",
				[...chain, ...(normalise ? [normalise] : []), "aresample=48000", "silencedetect=n=-40dB:d=0.6"].join(","),
				"-c:a",
				"aac",
				"-b:a",
				"128k",
				"-ar",
				"48000",
				"-ac",
				"1",
				"-movflags",
				"+faststart",
				"-map_metadata",
				"-1",
				output,
			],
			{
				onStdout: progressOf(sourceSec, (f) => set("audio", audioFrom + share * (0.4 + f * 0.6))),
				onStderr: (line) => {
					const start = /silence_start:\s*(-?[\d.]+)/.exec(line);
					if (start) silentFrom = Math.max(0, Number(start[1]));
					const end = /silence_end:\s*([\d.]+)/.exec(line);
					if (end && silentFrom !== null) {
						silences.push([Math.round(silentFrom * 100) / 100, Math.round(Number(end[1]) * 100) / 100]);
						silentFrom = null;
					}
				},
				keepStderr: true,
			},
		);
		const out = await probe(output);
		const audioSec = durationOf(out);
		// A silence still open at the end runs to the end of the file.
		if (silentFrom !== null && audioSec - silentFrom >= 0.6) silences.push([Math.round((silentFrom as number) * 100) / 100, Math.round(audioSec * 100) / 100]);
		const applied = normalise ? lastJson(apply.stderr) : null;
		result.audio = {
			bytes: statSync(output).size,
			sourceLufs,
			lufs: normalise ? played(finite(applied?.output_i) ?? TARGET_LUFS) : sourceLufs,
			peakDbfs: finite(applied?.output_tp ?? measured?.input_tp),
			channels: 1,
		};
		if (!result.durationSec) result.durationSec = audioSec;
	}

	result.durationSec = Math.round(result.durationSec * 1000) / 1000;
	await rm(source, { force: true });
	return result;
}
