/**
 * HTTP front for the renderer. Plain node:http - five routes do not need a framework.
 *
 *   GET  /ping     -> 200 "ok"
 *   POST /render   -> 202 { jobId }   (409 while a render is running, 400 on bad input)
 *   GET  /status   -> job state and progress
 *   GET  /output   -> the finished MP4, with Range support
 *   POST /still    -> one frame as JPEG / PNG
 *   POST /cancel   -> stops the running render
 */
import fs from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { pipeline } from "node:stream/promises";
import { RenderProps } from "../../shared/timeline.ts";
import { availableCpus, BUNDLE_DIR, cancelRender, defaultConcurrency, getBrowser, getOutputPath, getStatus, log, renderStillImage, shutdown, startRender } from "./engine.ts";

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

	// Checked last and synchronously before starting, so two racing requests cannot both get in.
	if (getStatus().state === "rendering") throw new HttpError(409, `a render is already running (jobId ${getStatus().jobId})`);
	startRender(body.jobId, props, { crf, concurrency });
	json(res, 202, { jobId: body.jobId });
}

async function handleStill(req: IncomingMessage, res: ServerResponse) {
	if (getStatus().state === "rendering") throw new HttpError(409, "a render is running; stills are available when it finishes");
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

async function handleOutput(req: IncomingMessage, res: ServerResponse) {
	const file = getOutputPath();
	if (!file || !fs.existsSync(file)) throw new HttpError(404, "no finished output");
	const { size } = fs.statSync(file);
	const base = { "content-type": "video/mp4", "accept-ranges": "bytes", "cache-control": "no-store" };
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
		GET: (_req, res) => {
			const { warnings, ...status } = getStatus();
			json(res, 200, warnings.length ? { ...status, warnings } : status);
		},
	},
	"/render": { POST: handleRender },
	"/still": { POST: handleStill },
	"/output": { GET: handleOutput, HEAD: handleOutput },
	"/cancel": { POST: async (_req, res) => json(res, 200, { cancelled: await cancelRender() }) },
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
	log("server.fatal", { error: `no Remotion bundle at ${BUNDLE_DIR}; run "npm run build:bundle" first` });
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
