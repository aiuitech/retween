/**
 * HTTP front for the renderer. Plain node:http - five routes do not need a framework.
 *
 *   GET  /ping     -> 200 "ok"
 *   POST /render   -> 202 { jobId }   (409 while a render is running, 400 on bad input)
 *   GET  /status   -> job state and progress (?jobId= for one of the last few jobs)
 *   GET  /output   -> the finished MP4, with Range support (?jobId= likewise)
 *   POST /still    -> one frame as JPEG / PNG
 *   POST /sheet    -> a contact sheet (many frames or media files on one image), as JSON
 *   POST /audio    -> loudness, balance and silence measurements of a timeline's mix, as JSON
 *   POST /cancel   -> stops the running render
 *   POST /footage          -> 202, starts processing a recording into an edit master + voice track (footage.ts)
 *   GET  /footage/status   -> that job's state, progress and result (?jobId=)
 *   GET  /footage/output   -> ?jobId=&file=video|audio, with Range support
 *   DELETE /footage        -> ?jobId=, removes the job's files
 */
import fs from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { pipeline } from "node:stream/promises";
import { ThumbnailOverlay } from "../../shared/thumbnail.ts";
import { RenderProps, Timeline } from "../../shared/timeline.ts";
import type { SheetTile } from "../src/Sheet.tsx";
import { analyseAudio } from "./audio.ts";
import { deleteFootage, footageOutput, getFootageStatus, startFootage } from "./footage.ts";
import {
	availableCpus,
	BUNDLE_DIR,
	cancelRender,
	defaultConcurrency,
	getBrowser,
	getJobStatus,
	getOutputPath,
	getStatus,
	log,
	renderSheetImage,
	renderStillImage,
	shutdown,
	startRender,
} from "./engine.ts";

const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? "0.0.0.0";
const MAX_BODY_BYTES = 32 * 1024 * 1024;

// Asset URLs are signed. Remotion and Chrome print failing URLs verbatim, so everything this process
// writes has query strings stripped from URLs before it reaches the container logs.
let stopping = false;
for (const stream of [process.stdout, process.stderr]) {
	const write = stream.write.bind(stream) as (...args: unknown[]) => boolean;
	stream.write = ((chunk: unknown, ...args: unknown[]) => {
		// Once shutdown has begun, Remotion's complaints about tabs closing under it are just noise.
		if (stopping && stream === process.stderr) return true;
		return write(typeof chunk === "string" ? chunk.replace(/(https?:\/\/[^\s?"')\]]+)\?[^\s"')\]]*/g, "$1") : chunk, ...args);
	}) as typeof stream.write;
}

class HttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

const json = (res: ServerResponse, status: number, body: unknown) => {
	const data = Buffer.from(JSON.stringify(body));
	res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": data.length, "cache-control": "no-store" });
	res.end(data);
};

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > MAX_BODY_BYTES) throw new HttpError(413, `request body is larger than ${MAX_BODY_BYTES} bytes`);
		chunks.push(chunk);
	}
	let body: unknown;
	try {
		body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch (err) {
		throw new HttpError(400, `request body is not valid JSON: ${err instanceof Error ? err.message : err}`);
	}
	if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "request body must be a JSON object");
	return body as Record<string, unknown>;
}

/** Validates `props` against the shared contract and returns a readable message when it does not fit. */
function parseProps(input: unknown): RenderProps {
	const result = RenderProps.safeParse(input);
	if (!result.success) {
		const issues = result.error.issues.slice(0, 12).map((issue) => `${issue.path.length ? `props.${issue.path.join(".")}` : "props"}: ${issue.message}`);
		const more = result.error.issues.length - issues.length;
		throw new HttpError(400, `invalid props - ${issues.join("; ")}${more > 0 ? `; and ${more} more` : ""}`);
	}
	const props = result.data;
	if (props.width % 2 !== 0 || props.height % 2 !== 0) throw new HttpError(400, `invalid props - width and height must be even for H.264 (got ${props.width}x${props.height})`);
	if (props.width > 4096 || props.height > 4096) throw new HttpError(400, `invalid props - ${props.width}x${props.height} is larger than the 4096px limit`);
	const { timeline } = props;
	const srcs = [
		timeline.theme.logo?.src,
		timeline.theme.logo?.darkSrc,
		timeline.theme.watermark?.src,
		...timeline.scenes.map((s) => (s.background.kind === "image" || s.background.kind === "video" ? s.background.src : undefined)),
		...timeline.audio.map((a) => a.src),
	];
	const unresolved = srcs.find((src) => src?.startsWith("asset://"));
	if (unresolved) throw new HttpError(400, `invalid props - "${unresolved}" is an unresolved asset reference; swap asset:// refs for signed URLs before rendering`);
	return props;
}

const int = (value: unknown, name: string, min: number, max: number): number => {
	if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw new HttpError(400, `${name} must be an integer between ${min} and ${max}`);
	return value;
};

async function handleRender(req: IncomingMessage, res: ServerResponse) {
	const body = await readJson(req);
	if (typeof body.jobId !== "string" || body.jobId.length === 0 || body.jobId.length > 200) throw new HttpError(400, "jobId must be a non-empty string");
	const props = parseProps(body.props);
	const options = (body.options ?? {}) as Record<string, unknown>;
	if (typeof options !== "object" || Array.isArray(options)) throw new HttpError(400, "options must be an object");
	const crf = options.crf === undefined ? undefined : int(options.crf, "options.crf", 1, 51);
	const concurrency = options.concurrency === undefined ? undefined : int(options.concurrency, "options.concurrency", 1, 32);
	if (options.draft !== undefined && typeof options.draft !== "boolean") throw new HttpError(400, "options.draft must be a boolean");
	let frameRange: [number, number] | undefined;
	if (options.frameRange !== undefined) {
		const range = options.frameRange;
		if (!Array.isArray(range) || range.length !== 2) throw new HttpError(400, "options.frameRange must be [first, last]");
		const last = props.timeline.durationInFrames - 1;
		frameRange = [int(range[0], "options.frameRange[0]", 0, last), int(range[1], "options.frameRange[1]", 0, last)];
		if (frameRange[1] < frameRange[0]) throw new HttpError(400, "options.frameRange must not end before it starts");
	}

	let master: { lufs: number; truePeak: number } | undefined;
	if (options.master !== undefined && options.master !== null) {
		const target = options.master as Record<string, unknown>;
		if (typeof target !== "object" || typeof target.lufs !== "number" || typeof target.truePeak !== "number") throw new HttpError(400, "options.master must be { lufs, truePeak }");
		if (target.lufs < -40 || target.lufs > -5 || target.truePeak < -9 || target.truePeak > 0) throw new HttpError(400, "options.master is out of range");
		master = { lufs: target.lufs, truePeak: target.truePeak };
	}

	// Checked last and synchronously before starting, so two racing requests cannot both get in.
	if (getStatus().state === "rendering") throw new HttpError(409, `a render is already running (jobId ${getStatus().jobId})`);
	startRender(body.jobId, props, { crf, concurrency, draft: options.draft === true, frameRange, master });
	json(res, 202, { jobId: body.jobId });
}

/** Stills and sheets wait for a full render to finish, but run alongside a draft (which leaves a core free for them). */
function assertStillsAllowed() {
	const current = getStatus();
	if (current.state === "rendering" && !current.draft) throw new HttpError(409, "a render is running; stills are available when it finishes");
}

async function handleStill(req: IncomingMessage, res: ServerResponse) {
	assertStillsAllowed();
	const body = await readJson(req);
	const props = parseProps(body.props);
	const frame = int(body.frame, "frame", 0, props.timeline.durationInFrames - 1);
	const format = body.format ?? "jpeg";
	if (format !== "jpeg" && format !== "png") throw new HttpError(400, 'format must be "jpeg" or "png"');
	const scale = body.scale ?? 1;
	if (typeof scale !== "number" || !(scale >= 0.1 && scale <= 2)) throw new HttpError(400, "scale must be a number between 0.1 and 2");

	const { buffer, contentType, warnings } = await renderStillImage(props, { frame, format, scale });
	res.writeHead(200, {
		"content-type": contentType,
		"content-length": buffer.length,
		"cache-control": "no-store",
		// Same list a render would report in /status, so the caller can see fallbacks without a second request.
		"x-render-warnings": String(warnings.length),
		...(warnings.length ? { "x-render-warning": encodeURIComponent(warnings.join(" | ").slice(0, 1500)) } : {}),
	});
	res.end(buffer);
}

const MAX_SHEET_TILES = 32;

function parseTile(input: unknown, i: number): SheetTile {
	if (!input || typeof input !== "object") throw new HttpError(400, `tiles[${i}] must be an object`);
	const tile = input as Record<string, unknown>;
	const label = tile.label === undefined ? undefined : String(tile.label).slice(0, 120);
	const src = () => {
		if (typeof tile.src !== "string" || !/^(https?:|data:)/.test(tile.src)) throw new HttpError(400, `tiles[${i}].src must be an http(s) URL`);
		if (tile.src.startsWith("asset://")) throw new HttpError(400, `tiles[${i}].src is an unresolved asset reference`);
		return tile.src;
	};
	switch (tile.kind) {
		case "frame": {
			const width = int(tile.width, `tiles[${i}].width`, 16, 4096);
			const height = int(tile.height, `tiles[${i}].height`, 16, 4096);
			return { kind: "frame", frame: int(tile.frame, `tiles[${i}].frame`, 0, 10_000_000), width, height, label };
		}
		case "image":
			return { kind: "image", src: src(), label };
		case "video": {
			const atSec = tile.atSec ?? 0;
			if (typeof atSec !== "number" || !(atSec >= 0)) throw new HttpError(400, `tiles[${i}].atSec must be a number of seconds`);
			return { kind: "video", src: src(), atSec, label };
		}
		case "thumbnail": {
			const width = int(tile.width, `tiles[${i}].width`, 16, 4096);
			const height = int(tile.height, `tiles[${i}].height`, 16, 4096);
			const overlay = ThumbnailOverlay.safeParse(tile.overlay);
			if (!overlay.success) throw new HttpError(400, `tiles[${i}].overlay - ${overlay.error.issues.slice(0, 4).map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
			if (overlay.data.subject && !/^(https?:|data:)/.test(overlay.data.subject.src)) throw new HttpError(400, `tiles[${i}].overlay.subject.src must be an http(s) URL`);
			const displayHeight = tile.displayHeight === undefined ? undefined : int(tile.displayHeight, `tiles[${i}].displayHeight`, 32, 2160);
			const badge = tile.badge === undefined ? undefined : String(tile.badge).slice(0, 12);
			return { kind: "thumbnail", frame: int(tile.frame, `tiles[${i}].frame`, 0, 10_000_000), width, height, overlay: overlay.data, label, displayHeight, badge };
		}
		default:
			throw new HttpError(400, `tiles[${i}].kind must be "frame", "image", "video" or "thumbnail"`);
	}
}

async function handleSheet(req: IncomingMessage, res: ServerResponse) {
	assertStillsAllowed();
	const body = await readJson(req);
	if (!Array.isArray(body.tiles) || body.tiles.length === 0 || body.tiles.length > MAX_SHEET_TILES) throw new HttpError(400, `tiles must be an array of 1-${MAX_SHEET_TILES} tiles`);
	const tiles = body.tiles.map(parseTile);
	let timeline: Timeline | undefined;
	const framed = (tile: SheetTile) => tile.kind === "frame" || tile.kind === "thumbnail";
	if (tiles.some(framed)) {
		// The same checks a render gets, with the first frame tile's size standing in for the export's.
		const first = tiles.find(framed) as Extract<SheetTile, { kind: "frame" | "thumbnail" }>;
		timeline = parseProps({ timeline: body.timeline, width: first.width, height: first.height }).timeline;
		for (const tile of tiles) {
			if (framed(tile) && (tile as { frame: number }).frame >= timeline.durationInFrames) {
				throw new HttpError(400, `frame ${(tile as { frame: number }).frame} is out of range: the timeline has ${timeline.durationInFrames} frames`);
			}
		}
	}
	const tileHeight = body.tileHeight === undefined ? 240 : int(body.tileHeight, "tileHeight", 48, 2160);
	const maxWidth = body.maxWidth === undefined ? 1600 : int(body.maxWidth, "maxWidth", 160, 4096);
	const format = body.format ?? "jpeg";
	if (format !== "jpeg" && format !== "png") throw new HttpError(400, 'format must be "jpeg" or "png"');
	const quality = body.quality === undefined ? 82 : int(body.quality, "quality", 30, 100);
	const bare = body.bare === true && tiles.length === 1;

	const result = await renderSheetImage({ timeline, tiles, tileHeight, maxWidth, bare }, { format, quality });
	json(res, 200, {
		image: result.buffer.toString("base64"),
		contentType: result.contentType,
		width: result.width,
		height: result.height,
		tiles: result.tiles,
		failed: result.failed,
		fits: result.fits,
		warnings: result.warnings,
	});
}

async function handleAudio(req: IncomingMessage, res: ServerResponse) {
	const body = await readJson(req);
	const parsed = Timeline.safeParse(body.timeline);
	if (!parsed.success) throw new HttpError(400, `invalid timeline - ${parsed.error.issues.slice(0, 6).map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
	const timeline = parsed.data;
	const unresolved = timeline.audio.find((clip) => clip.src.startsWith("asset://"));
	if (unresolved) throw new HttpError(400, `"${unresolved.src}" is an unresolved asset reference`);
	const last = timeline.durationInFrames;
	const fromFrame = body.fromFrame === undefined ? undefined : int(body.fromFrame, "fromFrame", 0, last);
	const toFrame = body.toFrame === undefined ? undefined : int(body.toFrame, "toFrame", 1, last);
	const started = Date.now();
	const analysis = await analyseAudio(timeline, { fromFrame, toFrame, profile: body.profile === true });
	log("audio.done", { seconds: analysis.analysedSec, clips: timeline.audio.length, skipped: analysis.skipped.length, elapsedMs: Date.now() - started });
	json(res, 200, analysis);
}

/** `?jobId=` picks one of the last few jobs; without it, the current one. */
const jobIdOf = (req: IncomingMessage) => new URL(req.url ?? "/", "http://localhost").searchParams.get("jobId") ?? undefined;

async function handleFootage(req: IncomingMessage, res: ServerResponse) {
	const body = await readJson(req);
	if (typeof body.jobId !== "string" || !/^[\w.-]{1,200}$/.test(body.jobId)) throw new HttpError(400, "jobId must be 1-200 letters, digits, dots, dashes or underscores");
	if (typeof body.src !== "string" || !/^https?:\/\//.test(body.src)) throw new HttpError(400, "src must be an http(s) URL");
	if (body.denoise !== undefined && typeof body.denoise !== "boolean") throw new HttpError(400, "denoise must be a boolean");
	const known = getFootageStatus(body.jobId);
	let status;
	try {
		status = startFootage(body.jobId, body.src, { denoise: body.denoise === true });
	} catch (err) {
		if ((err as { busy?: boolean }).busy) throw new HttpError(409, (err as Error).message);
		throw err;
	}
	// A retry of a job this instance already has answers with where it stands.
	if (known && known.state !== "error") return json(res, 200, status);
	log("footage.start", { jobId: body.jobId, denoise: body.denoise === true });
	json(res, 202, { ok: true, jobId: body.jobId });
}

async function handleFootageOutput(req: IncomingMessage, res: ServerResponse) {
	const query = new URL(req.url ?? "/", "http://localhost").searchParams;
	const jobId = query.get("jobId") ?? "";
	const which = query.get("file");
	if (which !== "video" && which !== "audio") throw new HttpError(400, 'file must be "video" or "audio"');
	const file = footageOutput(jobId, which);
	if (!file) throw new HttpError(404, `no ${which} output for footage job ${jobId}`);
	await serveFile(req, res, file, which === "video" ? "video/mp4" : "audio/mp4");
}

async function handleFootageDelete(req: IncomingMessage, res: ServerResponse) {
	const jobId = jobIdOf(req);
	if (!jobId) throw new HttpError(400, "jobId is required");
	try {
		json(res, 200, { deleted: await deleteFootage(jobId) });
	} catch (err) {
		throw new HttpError(409, (err as Error).message);
	}
}

async function handleOutput(req: IncomingMessage, res: ServerResponse) {
	const file = getOutputPath(jobIdOf(req));
	if (!file || !fs.existsSync(file)) throw new HttpError(404, "no finished output");
	await serveFile(req, res, file, "video/mp4");
}

/** Sends a file, honouring a single Range (the Worker copies large files into R2 in ranged parts). */
async function serveFile(req: IncomingMessage, res: ServerResponse, file: string, contentType: string) {
	const { size } = fs.statSync(file);
	const base = { "content-type": contentType, "accept-ranges": "bytes", "cache-control": "no-store" };
	const range = req.headers.range;
	let start = 0;
	let end = size - 1;
	let partial = false;

	if (range) {
		// Single ranges only: "bytes=a-b", "bytes=a-" and "bytes=-n".
		const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
		if (!m || (m[1] === "" && m[2] === "")) throw new HttpError(416, `unsupported Range "${range}"`);
		if (m[1] === "") {
			start = Math.max(0, size - Number(m[2]));
		} else {
			start = Number(m[1]);
			if (m[2] !== "") end = Math.min(end, Number(m[2]));
		}
		if (start > end || start >= size) {
			res.writeHead(416, { ...base, "content-range": `bytes */${size}`, "content-length": 0 });
			res.end();
			return;
		}
		partial = true;
	}

	res.writeHead(partial ? 206 : 200, { ...base, "content-length": end - start + 1, ...(partial ? { "content-range": `bytes ${start}-${end}/${size}` } : {}) });
	if (req.method === "HEAD") {
		res.end();
		return;
	}
	await pipeline(fs.createReadStream(file, { start, end }), res).catch(() => undefined);
}

const routes: Record<string, Partial<Record<string, (req: IncomingMessage, res: ServerResponse) => Promise<void> | void>>> = {
	"/ping": {
		GET: (_req, res) => {
			res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "content-length": 2 });
			res.end("ok");
		},
	},
	"/status": {
		GET: (req, res) => {
			const jobId = jobIdOf(req);
			const current = jobId ? getJobStatus(jobId) : getStatus();
			if (!current) throw new HttpError(404, `no job ${jobId} on this instance (it may have restarted)`);
			const { warnings, ...status } = current;
			json(res, 200, warnings.length ? { ...status, warnings } : status);
		},
	},
	"/render": { POST: handleRender },
	"/still": { POST: handleStill },
	"/sheet": { POST: handleSheet },
	"/audio": { POST: handleAudio },
	"/output": { GET: handleOutput, HEAD: handleOutput },
	"/cancel": { POST: async (_req, res) => json(res, 200, { cancelled: await cancelRender() }) },
	"/footage": { POST: handleFootage, DELETE: handleFootageDelete },
	"/footage/status": {
		GET: (req, res) => {
			const jobId = jobIdOf(req);
			const status = jobId ? getFootageStatus(jobId) : undefined;
			if (!status) throw new HttpError(404, `no footage job ${jobId ?? ""} on this instance (it may have restarted)`);
			json(res, 200, status);
		},
	},
	"/footage/output": { GET: handleFootageOutput, HEAD: handleFootageOutput },
};

const server = http.createServer(async (req, res) => {
	const path = new URL(req.url ?? "/", "http://localhost").pathname.replace(/\/+$/, "") || "/";
	try {
		const route = routes[path];
		if (!route) throw new HttpError(404, `no route for ${path}`);
		const handler = route[req.method ?? "GET"];
		if (!handler) {
			res.setHeader("allow", Object.keys(route).join(", "));
			throw new HttpError(405, `${req.method} is not allowed on ${path}`);
		}
		await handler(req, res);
	} catch (err) {
		const status = err instanceof HttpError ? err.status : err instanceof RangeError ? 400 : 500;
		const message = err instanceof Error ? err.message : String(err);
		if (status >= 500) log("http.error", { path, error: message.slice(0, 1000) });
		if (res.headersSent) res.destroy();
		else json(res, status, { error: message.split("\n").slice(0, 6).join("\n").slice(0, 2000) });
	}
});

// Renders run for minutes and /still holds its response open: no request or idle timeouts.
server.requestTimeout = 0;
server.keepAliveTimeout = 65_000;

if (!fs.existsSync(`${BUNDLE_DIR}/index.html`)) {
	log("server.fatal", { error: `no Remotion bundle at ${BUNDLE_DIR}; run "pnpm build:bundle" first` });
	process.exit(1);
}

server.listen(PORT, HOST, () => {
	log("server.listening", { host: HOST, port: PORT, cpus: availableCpus(), concurrency: defaultConcurrency(), bundle: BUNDLE_DIR });
	// Warm the browser so the first request does not pay for the launch. /ping answers regardless.
	const started = Date.now();
	getBrowser().then(
		() => log("browser.ready", { elapsedMs: Date.now() - started }),
		(err) => log("browser.error", { message: String(err).slice(0, 500) }),
	);
});

// Remotion only ends the process on SIGTERM when nobody else listens for it, so this handler owns the exit.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
	process.on(signal, () => {
		if (stopping) return;
		stopping = true;
		log("server.stopping", { signal, state: getStatus().state });
		setTimeout(() => process.exit(0), 10_000).unref();
		server.close();
		server.closeAllConnections();
		shutdown().finally(() => process.exit(0));
	});
}
