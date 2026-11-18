/**
 * Everything that talks to Remotion: one shared browser, one render job at a
 * time, stills and contact sheets. The bundle is built ahead of time
 * (`pnpm build:bundle`, done in the Docker build) - nothing is bundled per request.
 *
 * A render instance runs one export and is thrown away. A preview instance is
 * kept warm per person and serves stills, sheets and the occasional draft
 * render (a low-quality slice), so it remembers the last few jobs and their
 * files: a draft can finish and wait to be collected while the next one runs.
 */
import { type BrowserLog, type HeadlessBrowser, makeCancelSignal, openBrowser, renderMedia, renderStill, selectComposition } from "@remotion/renderer";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RenderProps, Timeline } from "../../shared/timeline.ts";
import { FIT_REPORT_PREFIX, type FitReport } from "../src/lib/report.ts";
import type { SheetProps } from "../src/Sheet.tsx";
import type { Resolved } from "../src/types.ts";

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
// Map scenes draw with WebGL. In the container (no GPU) Chrome falls back to software WebGL by itself;
// forcing "swangle" was measured slower for every scene (about 20% on plain scenes, 18% on maps at
// 1080p on 4 CPUs), so Chrome picks unless RENDER_GL names a backend. If a future Chrome stops falling
// back, map scenes still render (pins over the brand backdrop, with a warning) and RENDER_GL=swangle restores them.
type Gl = "swangle" | "angle" | "egl" | "swiftshader" | "vulkan" | "angle-egl";
const GL = (process.env.RENDER_GL || undefined) as Gl | undefined;
const chromiumOptions = { disableWebSecurity: true, enableMultiProcessOnLinux: true, ...(GL ? { gl: GL } : {}) };

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
	/** A draft (fast, low-quality preset). Stills and sheets may run alongside it. */
	draft?: boolean;
	/** Frames rendered, when only part of the timeline was asked for: [first, last], inclusive. */
	frameRange?: [number, number];
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
let cancelCurrent: (() => void) | null = null;
let currentJob: Promise<void> = Promise.resolve();
let browser: Promise<HeadlessBrowser> | null = null;

/** The last few jobs, newest last, with their output files. Only kept on preview instances in practice. */
const KEEP_JOBS = 3;
const jobs = new Map<string, { status: Status; file: string | null }>();

export const getStatus = (): Status => status;
/** A job's status by id: the current one, or one of the last few. */
export const getJobStatus = (jobId: string): Status | null => (status.jobId === jobId ? status : (jobs.get(jobId)?.status ?? null));
/** The finished file of a job (the latest job when no id is given). */
export function getOutputPath(jobId?: string): string | null {
	const job = jobs.get(jobId ?? status.jobId ?? "");
	return job && job.status.state === "done" ? job.file : null;
}

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

function browserLogHandler(warnings: string[], jobId: string | null, fits?: FitReport[]) {
	// Every render tab reports the same thing; say it once.
	const seen = new Set<string>();
	return (entry: BrowserLog) => {
		if (entry.text.startsWith(FIT_REPORT_PREFIX)) {
			if (!fits) return;
			try {
				const report = JSON.parse(entry.text.slice(FIT_REPORT_PREFIX.length)) as FitReport;
				// A box re-fits when its fonts land; the last word on each box is the one that counts.
				const at = fits.findIndex((other) => other.box === report.box && other.probe === report.probe);
				if (at >= 0) fits[at] = report;
				else fits.push(report);
			} catch {
				// Not ours after all.
			}
			return;
		}
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

export type RenderOptions = {
	crf?: number;
	concurrency?: number;
	/** Fast, low-quality encode for watching a cut, not for publishing. */
	draft?: boolean;
	/** Render only these frames, [first, last] inclusive. */
	frameRange?: [number, number];
};

/** Starts a render in the background. The caller has already checked that none is running. */
export function startRender(jobId: string, props: RenderProps, options: RenderOptions = {}): void {
	const { cancelSignal, cancel } = makeCancelSignal();
	let cancelled = false;
	const cancelThis = () => {
		cancelled = true;
		cancel();
	};
	cancelCurrent = cancelThis;
	const { draft = false, frameRange } = options;
	const totalFrames = frameRange ? frameRange[1] - frameRange[0] + 1 : props.timeline.durationInFrames;
	const job: Status = { state: "rendering", jobId, draft, frameRange, stage: "preparing", progress: 0, renderedFrames: 0, totalFrames, warnings: [] };
	status = job;
	const started = Date.now();
	// Remotion refuses more tabs than there are cores, so a larger request is capped rather than failed.
	// A draft leaves a core free so stills keep answering while it runs.
	const cpus = availableCpus();
	const concurrency = Math.min(options.concurrency ?? (draft ? Math.max(1, cpus - 1) : defaultConcurrency()), cpus);

	// The disk is small and ephemeral: only the last few outputs are kept.
	fs.mkdirSync(OUTPUT_DIR, { recursive: true });
	const file = path.join(OUTPUT_DIR, `${createHash("sha1").update(jobId).digest("hex").slice(0, 16)}.mp4`);
	jobs.delete(jobId);
	jobs.set(jobId, { status: job, file: null });
	while (jobs.size > KEEP_JOBS) {
		const [oldest, entry] = jobs.entries().next().value!;
		if (entry.file) fs.rmSync(entry.file, { force: true });
		jobs.delete(oldest);
	}

	const setStage = (stage: Stage, fields: Record<string, unknown> = {}) => {
		if (job.stage === stage) return;
		job.stage = stage;
		log("render.stage", { jobId, stage, elapsedMs: Date.now() - started, ...fields });
	};
	log("render.stage", { jobId, stage: "preparing", width: props.width, height: props.height, fps: props.timeline.fps, frames: props.timeline.durationInFrames, concurrency });

	currentJob = (async () => {
		const composition = await compose(props, job.warnings, jobId);
		if (cancelled) throw new Error("cancelled");
		if (frameRange && frameRange[1] >= composition.durationInFrames) throw new RangeError(`frameRange ends after the last frame (${composition.durationInFrames - 1})`);
		job.totalFrames = frameRange ? totalFrames : composition.durationInFrames;
		let renderStarted = Date.now();

		await renderMedia({
			composition,
			serveUrl: BUNDLE_DIR,
			inputProps: props,
			codec: "h264",
			audioCodec: "aac",
			pixelFormat: "yuv420p",
			colorSpace: "bt709",
			crf: options.crf ?? (draft ? 30 : undefined),
			x264Preset: draft ? "ultrafast" : X264_PRESET,
			frameRange: frameRange ?? null,
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
		const entry = jobs.get(jobId);
		if (entry) entry.file = file;
		job.renderedFrames = job.totalFrames;
		job.progress = 1;
		job.output = { bytes: size, width: composition.width, height: composition.height, fps: composition.fps, durationInFrames: job.totalFrames, contentType: "video/mp4" };
		job.state = "done";
		const seconds = (Date.now() - renderStarted) / 1000;
		setStage("done", { bytes: size, renderSeconds: Math.round(seconds * 10) / 10, framesPerSecond: Math.round((job.totalFrames / seconds) * 10) / 10, warnings: job.warnings.length });
	})()
		.catch(async (err) => {
			fs.rmSync(file, { force: true });
			if (status !== job) return;
			if (cancelled) {
				log("render.cancelled", { jobId, elapsedMs: Date.now() - started });
				jobs.delete(jobId);
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

// --- contact sheets -------------------------------------------------------------

/** A URL without its query string. Signed links change on every request; the file behind them does not. */
const base = (url: string) => url.split("?")[0]!;

/**
 * The preflight (media probes, fonts) for a timeline, reused for a few minutes.
 * Signed URLs differ on every request, so the cache is keyed on the timeline
 * with query strings removed and the result is re-keyed to the URLs at hand.
 */
const preflights = new Map<string, { at: number; value: Promise<{ resolved: Resolved; warnings: string[] }> }>();

async function preflightFor(timeline: Timeline): Promise<{ resolved: Resolved; warnings: string[] }> {
	const json = JSON.stringify(timeline);
	const key = createHash("sha1").update(json.replace(/\?[^"\s]*/g, "")).digest("hex");
	for (const [k, entry] of preflights) if (Date.now() - entry.at > COMPOSITION_TTL_MS) preflights.delete(k);
	let entry = preflights.get(key);
	if (!entry) {
		const warnings: string[] = [];
		const value = compose({ timeline, width: 640, height: 360 }, warnings, null).then((composition) => ({
			resolved: (composition.props as { resolved: Resolved }).resolved,
			warnings,
		}));
		entry = { at: Date.now(), value };
		preflights.set(key, entry);
		value.catch(() => preflights.delete(key));
		while (preflights.size > 4) preflights.delete(preflights.keys().next().value!);
	}
	const { resolved, warnings } = await entry.value;
	const current = new Map<string, string>();
	for (const match of json.matchAll(/https?:\/\/[^"\s]+/g)) current.set(base(match[0]), match[0]);
	const media: Resolved["media"] = {};
	for (const [src, info] of Object.entries(resolved.media)) media[current.get(base(src)) ?? src] = info;
	return { resolved: { ...resolved, media }, warnings };
}

export type SheetSpec = Omit<SheetProps, "resolved" | "geometry" | "failed">;
export type SheetResult = {
	buffer: Buffer;
	contentType: string;
	width: number;
	height: number;
	/** Where each tile landed in the image. */
	tiles: { x: number; y: number; w: number; h: number }[];
	/** Media tiles that could not be shown, by tile index. */
	failed: Record<number, string>;
	/** Text boxes that had to shrink to fit; `probe` is the tile index. */
	fits: FitReport[];
	warnings: string[];
};

/** Renders a contact sheet (see src/Sheet.tsx) as one image. Runs in the same queue as stills. */
export function renderSheetImage(spec: SheetSpec, options: { format: "jpeg" | "png"; quality: number }): Promise<SheetResult> {
	const run = async () => {
		const started = Date.now();
		const warnings: string[] = [];
		let resolved: Resolved | undefined;
		if (spec.timeline && spec.tiles.some((tile) => tile.kind === "frame")) {
			const preflight = await preflightFor(spec.timeline);
			resolved = preflight.resolved;
			warnings.push(...preflight.warnings);
		}
		const inputProps: SheetProps = { ...spec, resolved };
		const browser = await getBrowser();
		const composition = await selectComposition({
			serveUrl: BUNDLE_DIR,
			id: "Sheet",
			inputProps,
			puppeteerInstance: browser,
			timeoutInMilliseconds: 60_000,
			onBrowserLog: browserLogHandler(warnings, null),
			logLevel: LOG_LEVEL,
		});
		const fits: FitReport[] = [];
		const result = await renderStill({
			composition,
			serveUrl: BUNDLE_DIR,
			inputProps,
			frame: 0,
			imageFormat: options.format,
			jpegQuality: options.format === "jpeg" ? options.quality : undefined,
			puppeteerInstance: browser,
			timeoutInMilliseconds: 150_000,
			logLevel: LOG_LEVEL,
			onBrowserLog: browserLogHandler(warnings, null, fits),
		});
		if (!result.buffer) throw new Error("renderStill returned no image");
		const props = composition.props as SheetProps;
		log("sheet.done", { tiles: spec.tiles.length, width: composition.width, height: composition.height, bytes: result.buffer.length, fits: fits.length, elapsedMs: Date.now() - started });
		return {
			buffer: result.buffer,
			contentType: options.format === "png" ? "image/png" : "image/jpeg",
			width: composition.width,
			height: composition.height,
			tiles: props.geometry?.tiles ?? [],
			failed: props.failed ?? {},
			fits,
			warnings,
		};
	};
	const next = stillQueue.then(run, run);
	stillQueue = next.catch(() => undefined);
	return next;
}

/** Stops the render and the browser. Used on SIGTERM / SIGINT. */
export async function shutdown(): Promise<void> {
	await cancelRender();
	await dropBrowser();
}
