/**
 * Everything that talks to Remotion: one shared browser, one render job at a
 * time, and stills. The bundle is built ahead of time (`npm run build:bundle`,
 * done in the Docker build) - nothing is bundled per request.
 */
import { type BrowserLog, type HeadlessBrowser, makeCancelSignal, openBrowser, renderMedia, renderStill, selectComposition } from "@remotion/renderer";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RenderProps } from "../../shared/timeline.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
// server/engine.ts and dist/server.mjs both sit one level below the package root.
export const BUNDLE_DIR = process.env.REMOTION_BUNDLE ?? path.resolve(here, "../build");
export const OUTPUT_DIR = process.env.OUTPUT_DIR ?? path.join(os.tmpdir(), "retween-renderer");
const COMPOSITION_ID = "Video";
type LogLevel = "trace" | "verbose" | "info" | "warn" | "error";
// Remotion's own console output. Problems worth knowing about are logged by this server as JSON lines
// (render.warning, browser.warning, browser.error), so Remotion itself only speaks up for errors.
const LOG_LEVEL = (process.env.REMOTION_LOG_LEVEL ?? "error") as LogLevel;
type X264Preset = "ultrafast" | "superfast" | "veryfast" | "faster" | "fast" | "medium" | "slow" | "slower" | "veryslow";
// Measured on 4 CPUs at 1080p: "veryfast" renders ~45% faster than "medium" for an SSIM difference
// of about 0.001 and a smaller file, because the encoder competes with Chrome for the same cores.
const X264_PRESET = (process.env.RENDER_X264_PRESET ?? "veryfast") as X264Preset;

// Signed asset URLs are not CORS-enabled by default; the page only ever loads our own bundle and
// the timeline's media, so web security buys nothing here and would force slower fallbacks.
const chromiumOptions = { disableWebSecurity: true, enableMultiProcessOnLinux: true };

export const log = (event: string, fields: Record<string, unknown> = {}) =>
	console.log(JSON.stringify({ time: new Date().toISOString(), event, ...fields }));

/** CPUs this process may really use: the cgroup quota when there is one, else the visible cores. */
export function availableCpus(): number {
	let cpus = os.availableParallelism();
	try {
		const [quota, period] = fs.readFileSync("/sys/fs/cgroup/cpu.max", "utf8").trim().split(" ");
		if (quota && quota !== "max" && period) cpus = Math.min(cpus, Math.max(1, Math.floor(Number(quota) / Number(period))));
	} catch {
		// No cgroup v2 (macOS, older kernels): the core count is the answer.
	}
	return cpus;
}

/** One tab per CPU, capped: past 8 tabs the encoder and Chrome start starving each other. */
export const defaultConcurrency = () => {
	const fromEnv = Number(process.env.RENDER_CONCURRENCY);
	return Number.isInteger(fromEnv) && fromEnv > 0 ? fromEnv : Math.max(1, Math.min(8, availableCpus()));
};

export type Stage = "preparing" | "rendering" | "encoding" | "done";
export type Output = { bytes: number; width: number; height: number; fps: number; durationInFrames: number; contentType: "video/mp4" };
export type Status = {
	state: "idle" | "rendering" | "done" | "error";
	jobId: string | null;
	stage: Stage;
	progress: number;
	renderedFrames: number;
	totalFrames: number;
	error?: string;
	output?: Output;
	/** Non-fatal problems: media that fell back to the brand backdrop, dropped audio, font fallbacks. */
	warnings: string[];
};

const idle = (): Status => ({ state: "idle", jobId: null, stage: "preparing", progress: 0, renderedFrames: 0, totalFrames: 0, warnings: [] });

let status: Status = idle();
let outputPath: string | null = null;
let cancelCurrent: (() => void) | null = null;
let currentJob: Promise<void> = Promise.resolve();
let browser: Promise<HeadlessBrowser> | null = null;

export const getStatus = (): Status => status;
export const getOutputPath = () => (status.state === "done" ? outputPath : null);

/** The shared browser. Opened once and reused: launching Chrome costs about a second per call otherwise. */
export function getBrowser(): Promise<HeadlessBrowser> {
	browser ??= openBrowser("chrome", { chromiumOptions, logLevel: LOG_LEVEL }).catch((err) => {
		browser = null;
		throw err;
	});
	return browser;
}

async function dropBrowser() {
	const current = browser;
	browser = null;
	try {
		await (await current)?.close({ silent: true });
	} catch {
		// Already gone.
	}
}

function browserLogHandler(warnings: string[], jobId: string | null) {
	// Every render tab reports the same thing; say it once.
	const seen = new Set<string>();
	return (entry: BrowserLog) => {
		// The composition reports recoverable problems with this prefix (see src/lib/preflight.ts).
		const tagged = /\[retween\] (.*)/s.exec(entry.text);
		if (tagged) {
			const message = tagged[1]!.trim();
			if (!warnings.includes(message)) {
				warnings.push(message);
				log("render.warning", { jobId, message });
			}
		} else if (entry.type === "error" || entry.type === "warning") {
			const message = entry.text.slice(0, 500);
			if (seen.has(message)) return;
			seen.add(message);
			log(entry.type === "error" ? "browser.error" : "browser.warning", { jobId, message });
		}
	};
}

async function compose(props: RenderProps, warnings: string[], jobId: string | null) {
	const composition = await selectComposition({
		serveUrl: BUNDLE_DIR,
		id: COMPOSITION_ID,
		inputProps: props,
		puppeteerInstance: await getBrowser(),
		// The preflight probes every asset and resolves fonts inside this call.
		timeoutInMilliseconds: 150_000,
		onBrowserLog: browserLogHandler(warnings, jobId),
		logLevel: LOG_LEVEL,
	});
	// The preflight's own list is authoritative; console forwarding is only a second channel.
	const resolved = (composition.props as { resolved?: { warnings?: string[] } }).resolved;
	for (const w of resolved?.warnings ?? []) {
		if (!warnings.includes(w)) {
			warnings.push(w);
			log("render.warning", { jobId, message: w });
		}
	}
	return composition;
}

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err)).split("\n").slice(0, 6).join("\n").slice(0, 2000);

export type RenderOptions = { crf?: number; concurrency?: number };

/** Starts a render in the background. The caller has already checked that none is running. */
export function startRender(jobId: string, props: RenderProps, options: RenderOptions = {}): void {
	const { cancelSignal, cancel } = makeCancelSignal();
	let cancelled = false;
	const cancelThis = () => {
		cancelled = true;
		cancel();
	};
	cancelCurrent = cancelThis;
	const job: Status = { state: "rendering", jobId, stage: "preparing", progress: 0, renderedFrames: 0, totalFrames: props.timeline.durationInFrames, warnings: [] };
	status = job;
	const started = Date.now();
	// Remotion refuses more tabs than there are cores, so a larger request is capped rather than failed.
	const concurrency = Math.min(options.concurrency ?? defaultConcurrency(), availableCpus());

	// Only one output is kept: the disk is small and ephemeral.
	fs.rmSync(OUTPUT_DIR, { recursive: true, force: true });
	fs.mkdirSync(OUTPUT_DIR, { recursive: true });
	const file = path.join(OUTPUT_DIR, `${createHash("sha1").update(jobId).digest("hex").slice(0, 16)}.mp4`);
	outputPath = null;

	const setStage = (stage: Stage, fields: Record<string, unknown> = {}) => {
		if (job.stage === stage) return;
		job.stage = stage;
		log("render.stage", { jobId, stage, elapsedMs: Date.now() - started, ...fields });
	};
	log("render.stage", { jobId, stage: "preparing", width: props.width, height: props.height, fps: props.timeline.fps, frames: props.timeline.durationInFrames, concurrency });

	currentJob = (async () => {
		const composition = await compose(props, job.warnings, jobId);
		if (cancelled) throw new Error("cancelled");
		job.totalFrames = composition.durationInFrames;
		let renderStarted = Date.now();

		await renderMedia({
			composition,
			serveUrl: BUNDLE_DIR,
			inputProps: props,
			codec: "h264",
			audioCodec: "aac",
			pixelFormat: "yuv420p",
			colorSpace: "bt709",
			crf: options.crf,
			x264Preset: X264_PRESET,
			// Always write an audio stream, even for a silent timeline: players and platforms expect one.
			enforceAudioTrack: true,
			// Only used when shared-memory capture is unavailable and frames go through screenshots.
			imageFormat: "jpeg",
			jpegQuality: 92,
			outputLocation: file,
			overwrite: true,
			concurrency,
			puppeteerInstance: await getBrowser(),
			timeoutInMilliseconds: 90_000,
			cancelSignal,
			logLevel: LOG_LEVEL,
			onBrowserLog: browserLogHandler(job.warnings, jobId),
			onStart: ({ frameCount, resolvedConcurrency }) => {
				job.totalFrames = frameCount;
				renderStarted = Date.now();
				setStage("rendering", { frames: frameCount, concurrency: resolvedConcurrency });
			},
			onProgress: ({ renderedFrames, progress }) => {
				job.renderedFrames = renderedFrames;
				// Never report 1 before the file is closed and measured.
				job.progress = Math.min(0.99, progress);
				if (renderedFrames >= job.totalFrames && job.totalFrames > 0) setStage("encoding");
			},
		});

		const { size } = fs.statSync(file);
		outputPath = file;
		job.renderedFrames = job.totalFrames;
		job.progress = 1;
		job.output = { bytes: size, width: composition.width, height: composition.height, fps: composition.fps, durationInFrames: composition.durationInFrames, contentType: "video/mp4" };
		job.state = "done";
		const seconds = (Date.now() - renderStarted) / 1000;
		setStage("done", { bytes: size, renderSeconds: Math.round(seconds * 10) / 10, framesPerSecond: Math.round((job.totalFrames / seconds) * 10) / 10, warnings: job.warnings.length });
	})()
		.catch(async (err) => {
			fs.rmSync(file, { force: true });
			if (status !== job) return;
			if (cancelled) {
				log("render.cancelled", { jobId, elapsedMs: Date.now() - started });
				status = idle();
				return;
			}
			job.state = "error";
			job.error = errorMessage(err);
			log("render.error", { jobId, stage: job.stage, elapsedMs: Date.now() - started, error: job.error });
			// A failed render may leave the browser in a bad state; start the next one clean.
			await dropBrowser();
		})
		.finally(() => {
			if (cancelCurrent === cancelThis) cancelCurrent = null;
		});
}

/**
 * Cancels the running render, if any, and waits for it to wind down (the state
 * is back to "idle" when this resolves). Returns whether there was one.
 */
export async function cancelRender(): Promise<boolean> {
	if (status.state !== "rendering" || !cancelCurrent) return false;
	cancelCurrent();
	await Promise.race([currentJob, new Promise((resolve) => setTimeout(resolve, 20_000))]);
	return true;
}

// Stills of the same props usually come in bursts (an agent looking at several frames), so the
// preflight result is reused briefly. Renders always run a fresh preflight.
const compositions = new Map<string, { at: number; value: ReturnType<typeof compose>; warnings: string[] }>();
const COMPOSITION_TTL_MS = 3 * 60_000;

let stillQueue: Promise<unknown> = Promise.resolve();

export type StillOptions = { frame: number; format: "jpeg" | "png"; scale: number };

export function renderStillImage(props: RenderProps, options: StillOptions): Promise<{ buffer: Buffer; contentType: string; warnings: string[] }> {
	const run = async () => {
		const started = Date.now();
		const key = createHash("sha1").update(JSON.stringify(props)).digest("hex");
		for (const [k, entry] of compositions) if (Date.now() - entry.at > COMPOSITION_TTL_MS) compositions.delete(k);
		let entry = compositions.get(key);
		if (!entry) {
			const warnings: string[] = [];
			entry = { at: Date.now(), value: compose(props, warnings, null), warnings };
			compositions.set(key, entry);
			entry.value.catch(() => compositions.delete(key));
			while (compositions.size > 4) compositions.delete(compositions.keys().next().value!);
		}
		const composition = await entry.value;
		if (options.frame >= composition.durationInFrames) {
			throw new RangeError(`frame ${options.frame} is out of range: the timeline has ${composition.durationInFrames} frames (0-${composition.durationInFrames - 1})`);
		}
		const result = await renderStill({
			composition,
			serveUrl: BUNDLE_DIR,
			inputProps: props,
			frame: options.frame,
			imageFormat: options.format,
			jpegQuality: options.format === "jpeg" ? 88 : undefined,
			scale: options.scale,
			// A scale other than 1 has to be set when the browser launches, so those stills get their own.
			...(options.scale === 1 ? { puppeteerInstance: await getBrowser() } : { chromiumOptions }),
			timeoutInMilliseconds: 90_000,
			logLevel: LOG_LEVEL,
			onBrowserLog: browserLogHandler(entry.warnings, null),
		});
		if (!result.buffer) throw new Error("renderStill returned no image");
		log("still.done", { frame: options.frame, format: options.format, scale: options.scale, width: composition.width, height: composition.height, bytes: result.buffer.length, elapsedMs: Date.now() - started });
		return { buffer: result.buffer, contentType: options.format === "png" ? "image/png" : "image/jpeg", warnings: entry.warnings };
	};
	// One still at a time: each is a full-resolution page and they would only slow each other down.
	const next = stillQueue.then(run, run);
	stillQueue = next.catch(() => undefined);
	return next;
}

/** Stops the render and the browser. Used on SIGTERM / SIGINT. */
export async function shutdown(): Promise<void> {
	await cancelRender();
	await dropBrowser();
}
