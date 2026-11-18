/**
 * retween: command-line interface.
 *
 * The CLI has almost no knowledge of its own. It downloads the operation
 * manifest from the service and turns each operation into a command:
 *
 *     project.create   →   retween project create --name "Acme"
 *
 * so it always matches what the MCP tools offer. The only commands defined
 * here are the ones that touch the local machine: signing in, uploading a
 * file and downloading one.
 */
import { spawn } from "node:child_process";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

declare const __VERSION__: string;
declare const __DEFAULT_URL__: string;

const VERSION = __VERSION__;
const CLIENT_ID = "retween-cli";
const CONFIG_DIR = process.env.RETWEEN_CONFIG_DIR ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "retween");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");
const MANIFEST_FILE = join(CONFIG_DIR, "manifest.json");

interface Config {
	url?: string;
	token?: string;
}
interface JsonSchema {
	type?: string | string[];
	description?: string;
	properties?: Record<string, JsonSchema>;
	required?: string[];
	enum?: unknown[];
	default?: unknown;
	items?: JsonSchema;
	anyOf?: JsonSchema[];
}
interface Operation {
	name: string;
	title: string;
	description: string;
	inputSchema: JsonSchema;
	admin: boolean;
	paid: boolean;
}

class CliError extends Error {}

const readJson = <T>(file: string): T | undefined => {
	try {
		return JSON.parse(readFileSync(file, "utf8")) as T;
	} catch {
		return undefined;
	}
};
const config: Config = readJson<Config>(CONFIG_FILE) ?? {};
const baseUrl = () => (process.env.RETWEEN_URL ?? config.url ?? __DEFAULT_URL__).replace(/\/$/, "");
const credential = () => process.env.RETWEEN_API_KEY ?? config.token;

function saveConfig(next: Config) {
	mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
	writeFileSync(CONFIG_FILE, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
}

const useColor = process.stderr.isTTY && !process.env.NO_COLOR;
const dim = (text: string) => (useColor ? `\x1b[2m${text}\x1b[0m` : text);
const bold = (text: string) => (useColor ? `\x1b[1m${text}\x1b[0m` : text);
const info = (text: string) => process.stderr.write(`${text}\n`);

async function request(path: string, init: RequestInit & { auth?: boolean } = {}): Promise<Response> {
	const headers = new Headers(init.headers);
	headers.set("user-agent", `retween-cli/${VERSION}`);
	const token = credential();
	if (init.auth !== false && token) headers.set("authorization", `Bearer ${token}`);
	try {
		return await fetch(`${baseUrl()}${path}`, { ...init, headers });
	} catch (error) {
		throw new CliError(`Could not reach ${baseUrl()} (${error instanceof Error ? error.message : error})`);
	}
}

async function unwrap<T>(response: Response): Promise<T> {
	const body = (await response.json().catch(() => null)) as { ok?: boolean; result?: T; error?: { message: string; code: string } } | null;
	if (!response.ok || !body?.ok) {
		if (response.status === 401) throw new CliError("Not signed in. Run `retween login` (or set RETWEEN_API_KEY).");
		throw new CliError(body?.error?.message ?? `Request failed (${response.status})`);
	}
	return body.result as T;
}

function callOp<T = Record<string, unknown>>(name: string, input: unknown = {}): Promise<T> {
	return request(`/api/v1/ops/${name}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) }).then((response) =>
		unwrap<T>(response),
	);
}

/** The operation manifest, cached for an hour so `--help` is instant. */
async function manifest(refresh = false): Promise<Operation[]> {
	const cached = readJson<{ at: number; url: string; signedIn: boolean; operations: Operation[] }>(MANIFEST_FILE);
	const fresh = cached && cached.url === baseUrl() && cached.signedIn === Boolean(credential()) && Date.now() - cached.at < 3_600_000;
	if (cached && fresh && !refresh) return cached.operations;
	const response = await request("/api/v1/ops");
	const body = (await response.json().catch(() => null)) as { operations?: Operation[] } | null;
	if (!response.ok || !body?.operations) {
		if (cached?.url === baseUrl()) return cached.operations;
		throw new CliError(`Could not load the command list from ${baseUrl()} (${response.status})`);
	}
	try {
		mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
		writeFileSync(MANIFEST_FILE, JSON.stringify({ at: Date.now(), url: baseUrl(), signedIn: Boolean(credential()), operations: body.operations }));
	} catch {
		// the cache is only a convenience
	}
	return body.operations;
}

// ------------------------------------------------------------- arguments

const kebab = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
const camel = (name: string) => name.replace(/-([a-z0-9])/g, (_, char: string) => char.toUpperCase());
const typeOf = (schema: JsonSchema | undefined): string => {
	if (!schema) return "string";
	if (schema.enum) return "string";
	const type = Array.isArray(schema.type) ? schema.type.find((t) => t !== "null") : schema.type;
	return type ?? schema.anyOf?.map(typeOf).find((t) => t !== "null") ?? "string";
};

/** Reads a value that may be inline JSON, `@file`, or `-` for standard input. */
function readStructured(value: string, what: string): unknown {
	const text = value === "-" ? readFileSync(0, "utf8") : value.startsWith("@") ? readFileSync(value.slice(1), "utf8") : value;
	try {
		return JSON.parse(text);
	} catch {
		throw new CliError(`${what} must be JSON (inline, @file.json, or - for stdin)`);
	}
}

function coerce(flag: string, value: string | true, schema: JsonSchema | undefined): unknown {
	const type = typeOf(schema);
	if (type === "boolean") return value === true ? true : !/^(false|0|no|off)$/i.test(value);
	if (value === true) throw new CliError(`--${flag} needs a value`);
	if (type === "number" || type === "integer") {
		const number = Number(value);
		if (!Number.isFinite(number)) throw new CliError(`--${flag} must be a number`);
		return number;
	}
	if (type === "array") {
		if (value.startsWith("[") || value.startsWith("@") || value === "-") return readStructured(value, `--${flag}`);
		const itemType = typeOf(schema?.items);
		return value.split(",").map((item) => (itemType === "number" || itemType === "integer" ? Number(item) : item.trim()));
	}
	if (type === "object") return readStructured(value, `--${flag}`);
	return value;
}

interface Parsed {
	positional: string[];
	flags: Map<string, string | true>;
}

function parseArgs(argv: string[], booleans: Set<string>): Parsed {
	const positional: string[] = [];
	const flags = new Map<string, string | true>();
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg === "--") {
			positional.push(...argv.slice(i + 1));
			break;
		}
		if (arg.startsWith("--no-") && booleans.has(camel(arg.slice(5)))) {
			flags.set(camel(arg.slice(5)), "false");
		} else if (arg.startsWith("--")) {
			const [rawName, inline] = arg.slice(2).split(/=(.*)/s) as [string, string | undefined];
			const name = camel(rawName);
			const next = argv[i + 1];
			if (inline !== undefined) flags.set(name, inline);
			else if (booleans.has(name) || next === undefined || (next.startsWith("--") && next !== "-")) flags.set(name, true);
			else flags.set(name, argv[++i]!);
		} else if (arg === "-o") {
			flags.set("output", argv[++i] ?? true);
		} else if (arg === "-h") {
			flags.set("help", true);
		} else positional.push(arg);
	}
	return { positional, flags };
}

// ------------------------------------------------------------------ help

function wrap(text: string, indent: number, width = Math.min(process.stdout.columns ?? 100, 110)): string {
	const lines: string[] = [];
	let line = "";
	for (const word of text.split(/\s+/)) {
		if (line && line.length + word.length + 1 > width - indent) {
			lines.push(line);
			line = word;
		} else line = line ? `${line} ${word}` : word;
	}
	if (line) lines.push(line);
	return lines.join(`\n${" ".repeat(indent)}`);
}

/** `asset.generate_image` → ["asset", "generate-image"] */
const partsOf = (op: Operation): string[] => {
	const [group, ...rest] = op.name.split(".");
	return rest.length ? [group!, rest.join("-").replace(/_/g, "-")] : [group!];
};

const LOCAL_COMMANDS: [string, string][] = [
	["login", "Sign in through your browser (or --key <api key>)"],
	["logout", "Forget the saved sign-in"],
	["asset upload <file…> --project <id>", "Upload local files as assets"],
	["asset download <assetId> [-o file]", "Download an asset's file"],
	["render download <renderId> [-o file]", "Download a finished render"],
	["mcp", "Show how to connect an agent over MCP"],
];

function printOverview(operations: Operation[]) {
	const out = [
		`${bold("retween")} ${VERSION}: make on-brand videos from a storyboard`,
		"",
		`${bold("Usage")}  retween <group> <command> [--flag value …]`,
		"",
		bold("On this machine"),
		...LOCAL_COMMANDS.map(([command, text]) => `  ${command.padEnd(40)} ${dim(text)}`),
		"",
	];
	const groups = new Map<string, Operation[]>();
	for (const op of operations) {
		const group = partsOf(op)[0]!;
		groups.set(group, [...(groups.get(group) ?? []), op]);
	}
	for (const [group, ops] of groups) {
		out.push(bold(group));
		for (const op of ops) out.push(`  ${partsOf(op).join(" ").padEnd(40)} ${dim(op.title)}`);
		out.push("");
	}
	out.push(
		bold("Everywhere"),
		`  ${"--help".padEnd(40)} ${dim("Explain a command and list its flags")}`,
		`  ${"--input <json | @file | ->".padEnd(40)} ${dim("Give the whole input as JSON (flags override it)")}`,
		`  ${"--wait".padEnd(40)} ${dim("Keep waiting until generation or rendering finishes")}`,
		`  ${"-o, --output <file>".padEnd(40)} ${dim("Save the resulting file (preview, render, asset)")}`,
		"",
		dim(`Service: ${baseUrl()}   Config: ${CONFIG_FILE}`),
	);
	console.log(out.join("\n"));
}

function printOpHelp(op: Operation) {
	const properties = op.inputSchema.properties ?? {};
	const required = new Set(op.inputSchema.required ?? []);
	const out = [`${bold(`retween ${partsOf(op).join(" ")}`)}${op.paid ? dim("   (spends generation budget)") : ""}`, "", wrap(op.description, 0), ""];
	const names = Object.keys(properties);
	if (names.length) out.push(bold("Flags"));
	for (const name of names) {
		const schema = properties[name]!;
		const type = typeOf(schema);
		const hint = schema.enum ? schema.enum.join("|") : type === "object" || (type === "array" && typeOf(schema.items) === "object") ? "json|@file" : type === "array" ? "a,b,c" : type;
		const head = `  --${kebab(name)} <${hint}>`;
		const notes = [required.has(name) ? "required" : "", schema.default !== undefined ? `default ${JSON.stringify(schema.default)}` : ""].filter(Boolean).join(", ");
		out.push(`${head}${notes ? dim(`  (${notes})`) : ""}`);
		if (schema.description) out.push(`      ${dim(wrap(schema.description, 6))}`);
	}
	console.log(out.join("\n"));
}

// --------------------------------------------------------------- waiting

type Result = Record<string, any>;
const TERMINAL = new Set(["done", "failed", "cancelled"]);

/** Follows background work to the end, reporting progress on stderr. */
async function follow(result: Result): Promise<Result> {
	let last = "";
	const note = (text: string) => {
		if (text !== last) info(dim(text));
		last = text;
	};
	if (result.video?.status === "preparing") {
		let video = result.video;
		while (video.status === "preparing") {
			note(`preparing: ${video.pipeline?.message ?? "working"}`);
			video = (await callOp<Result>("video.get", { videoId: video.id, waitSeconds: 45 })).video;
		}
		return { ...result, video, note: undefined };
	}
	const renders: Result[] | undefined = result.renders ?? (result.render ? [result.render] : undefined);
	if (renders?.some((render) => !TERMINAL.has(render.status))) {
		const finished: Result[] = [];
		for (let render of renders) {
			while (!TERMINAL.has(render.status)) {
				note(`render ${render.aspect} ${render.resolution}: ${render.status} ${render.progress}%`);
				render = (await callOp<Result>("render.get", { renderId: render.id, waitSeconds: 45 })).render;
			}
			finished.push(render);
		}
		return result.renders ? { ...result, renders: finished, note: undefined } : { ...result, render: finished[0] };
	}
	if (result.asset?.status === "pending") {
		let asset = result.asset;
		while (asset.status === "pending") {
			note(`generating ${asset.kind}: ${asset.name}`);
			asset = (await callOp<Result>("asset.get", { assetId: asset.id, waitSeconds: 45 })).asset;
		}
		return { ...result, asset, note: undefined };
	}
	return result;
}

async function download(url: string, file: string): Promise<number> {
	const response = await fetch(url);
	if (!response.ok || !response.body) throw new CliError(`Download failed (${response.status})`);
	mkdirSync(dirname(file) || ".", { recursive: true });
	await pipeline(Readable.fromWeb(response.body as never), createWriteStream(file));
	return statSync(file).size;
}

const extensionOf = (contentType?: string) =>
	({ "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "video/mp4": "mp4", "video/webm": "webm", "audio/mpeg": "mp3", "audio/wav": "wav" })[contentType ?? ""] ?? "bin";

// -------------------------------------------------------- local commands

async function login(flags: Map<string, string | true>) {
	const url = typeof flags.get("url") === "string" ? (flags.get("url") as string).replace(/\/$/, "") : undefined;
	if (url) config.url = url;
	const key = flags.get("key");
	if (typeof key === "string") {
		saveConfig({ ...config, token: key });
		config.token = key;
		const me = await callOp<Result>("whoami");
		info(`Signed in as ${bold(me.email)} with an API key.`);
		return;
	}
	const start = await request("/api/auth/device/code", {
		method: "POST",
		auth: false,
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ client_id: CLIENT_ID }),
	});
	const device = (await start.json().catch(() => null)) as Result | null;
	if (!start.ok || !device?.device_code) throw new CliError(`Could not start sign-in (${start.status})`);
	const link = device.verification_uri_complete ?? device.verification_uri;
	info(`\nOpen this link to sign in:\n\n  ${bold(link)}\n\nand confirm the code ${bold(device.user_code)}\n`);
	if (!flags.has("noBrowser")) openBrowser(link);

	let interval = (device.interval ?? 5) * 1000;
	const deadline = Date.now() + (device.expires_in ?? 900) * 1000;
	while (Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, interval));
		const poll = await request("/api/auth/device/token", {
			method: "POST",
			auth: false,
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: device.device_code, client_id: CLIENT_ID }),
		});
		const body = (await poll.json().catch(() => null)) as Result | null;
		if (poll.ok && body?.access_token) {
			saveConfig({ ...config, token: body.access_token });
			config.token = body.access_token;
			const me = await request("/api/v1/me").then((response) => response.json() as Promise<Result>);
			info(`Signed in as ${bold(me.user?.email ?? "your account")}.`);
			if (me.user && !me.user.approved) info("This account is waiting for an administrator's approval before it can make videos.");
			return;
		}
		const code = body?.error;
		if (code === "slow_down") interval += 5000;
		else if (code === "access_denied") throw new CliError("Sign-in was denied.");
		else if (code === "expired_token") break;
		else if (code && code !== "authorization_pending") throw new CliError(body?.error_description ?? code);
	}
	throw new CliError("The sign-in code expired. Run `retween login` again.");
}

function openBrowser(url: string) {
	const [command, args] =
		process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
	try {
		spawn(command as string, args as string[], { stdio: "ignore", detached: true }).on("error", () => undefined).unref();
	} catch {
		// the link is printed either way
	}
}

const MIME: Record<string, string> = {
	png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", svg: "image/svg+xml", avif: "image/avif",
	mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm",
	mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", aac: "audio/aac", ogg: "audio/ogg", flac: "audio/flac",
	woff2: "font/woff2", woff: "font/woff", ttf: "font/ttf", otf: "font/otf",
};

/** Files above this go up in parts (one request to the service carries at most about 100 MB). */
const MULTIPART_THRESHOLD = 90 * 1000 * 1000;

/** Uploads a large file in parts, two at a time, retrying each part a few times. */
async function uploadInParts(file: string, size: number, type: string, project: string, query: URLSearchParams): Promise<unknown> {
	const start = await request(`/api/v1/projects/${encodeURIComponent(project)}/uploads`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ name: query.get("name"), contentType: type, bytes: size, tags: query.get("tags") ?? undefined, description: query.get("description") ?? undefined }),
	});
	const plan = await unwrap<{ uploadId: string; partSize: number; parts: number; partUrl: string; completeUrl: string }>(start);
	const done: { partNumber: number; etag: string }[] = [];
	const queue = Array.from({ length: plan.parts }, (_, i) => i + 1);
	let sent = 0;
	const sendPart = async (partNumber: number) => {
		const from = (partNumber - 1) * plan.partSize;
		const to = Math.min(size, from + plan.partSize) - 1;
		for (let attempt = 1; ; attempt++) {
			try {
				const response = await fetch(plan.partUrl.replace("{partNumber}", String(partNumber)), {
					method: "PUT",
					headers: { "content-length": String(to - from + 1), "user-agent": `retween-cli/${VERSION}` },
					body: Readable.toWeb(createReadStream(file, { start: from, end: to })) as never,
					duplex: "half",
				} as RequestInit);
				const part = await unwrap<{ partNumber: number; etag: string }>(response);
				sent += to - from + 1;
				info(dim(`  part ${partNumber}/${plan.parts} done (${Math.round((sent / size) * 100)}%)`));
				return part;
			} catch (error) {
				if (attempt >= 3) throw error;
				info(dim(`  part ${partNumber} failed (${error instanceof Error ? error.message : error}); retrying`));
				await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
			}
		}
	};
	try {
		await Promise.all(
			Array.from({ length: Math.min(2, plan.parts) }, async () => {
				for (let n = queue.shift(); n; n = queue.shift()) done.push(await sendPart(n));
			}),
		);
		const complete = await fetch(plan.completeUrl, {
			method: "POST",
			headers: { "content-type": "application/json", "user-agent": `retween-cli/${VERSION}` },
			body: JSON.stringify({ parts: done }),
		});
		return (await unwrap<Result>(complete)).asset;
	} catch (error) {
		await fetch(plan.completeUrl.replace(/\/complete$/, ""), { method: "DELETE" }).catch(() => undefined);
		throw error;
	}
}

async function upload(files: string[], flags: Map<string, string | true>) {
	const project = flags.get("project") ?? flags.get("projectId");
	if (typeof project !== "string") throw new CliError("Say which project: --project <id>");
	if (!files.length) throw new CliError("Give at least one file to upload");
	const uploaded: unknown[] = [];
	for (const file of files) {
		if (!existsSync(file) || !statSync(file).isFile()) throw new CliError(`No such file: ${file}`);
		const extension = file.split(".").pop()?.toLowerCase() ?? "";
		const type = MIME[extension];
		if (!type) throw new CliError(`${file}: unsupported file type (images, video, audio and fonts can be uploaded)`);
		const query = new URLSearchParams({ name: files.length === 1 && typeof flags.get("name") === "string" ? (flags.get("name") as string) : basename(file) });
		if (typeof flags.get("tags") === "string") query.set("tags", flags.get("tags") as string);
		if (typeof flags.get("description") === "string") query.set("description", flags.get("description") as string);
		const size = statSync(file).size;
		info(dim(`uploading ${basename(file)} (${(size / 1e6).toFixed(1)} MB)`));
		if (size > MULTIPART_THRESHOLD) {
			uploaded.push(await uploadInParts(file, size, type, project, query));
			continue;
		}
		const response = await request(`/api/v1/projects/${encodeURIComponent(project)}/assets?${query}`, {
			method: "PUT",
			headers: { "content-type": type, "content-length": String(size) },
			body: Readable.toWeb(createReadStream(file)) as never,
			duplex: "half",
		} as RequestInit);
		uploaded.push((await unwrap<Result>(response)).asset);
	}
	console.log(JSON.stringify({ assets: uploaded }, null, 2));
}

function printMcp() {
	console.log(
		[
			`MCP server URL:  ${baseUrl()}/mcp`,
			"",
			"Claude Code:",
			`  claude mcp add --transport http retween ${baseUrl()}/mcp`,
			"",
			"Other clients: add a remote (HTTP) MCP server with that URL. The first use opens a browser to sign in.",
			"Clients that cannot open a browser can send an API key instead:  Authorization: Bearer rtw_…",
		].join("\n"),
	);
}

// ------------------------------------------------------------------ main

async function main() {
	const argv = process.argv.slice(2);
	if (argv[0] === "--version" || argv[0] === "-v") return console.log(VERSION);

	// Local commands are resolved before the manifest so they work offline and signed out.
	const first = parseArgs(argv, new Set(["help", "noBrowser", "wait"]));
	const [head, second, ...rest] = first.positional;
	if (head === "login") return login(first.flags);
	if (head === "logout") {
		saveConfig({ ...config, token: undefined });
		return info("Signed out.");
	}
	if (head === "mcp") return printMcp();
	if (head === "asset" && second === "upload") return upload(rest, first.flags);

	const operations = await manifest();
	if (!head || head === "help") return printOverview(operations);

	const wanted = [head, second].filter(Boolean);
	const op =
		operations.find((candidate) => partsOf(candidate).join(" ") === wanted.join(" ")) ??
		operations.find((candidate) => partsOf(candidate).length === 1 && partsOf(candidate)[0] === head);
	const isDownload = second === "download" && (head === "render" || head === "asset");
	if (!op && !isDownload) {
		const group = operations.filter((candidate) => partsOf(candidate)[0] === head);
		if (group.length) {
			console.log(`${bold(head)} commands:\n`);
			for (const item of group) console.log(`  retween ${partsOf(item).join(" ").padEnd(32)} ${dim(item.title)}`);
			if (second && second !== "--help") process.exitCode = 1;
			return;
		}
		throw new CliError(`Unknown command "${wanted.join(" ")}". Run \`retween --help\` to see what is available.`);
	}

	if (isDownload) {
		const id = rest[0];
		if (!id) throw new CliError(`Usage: retween ${head} download <id> [-o file]`);
		const result = head === "render" ? (await callOp<Result>("render.get", { renderId: id })).render : (await callOp<Result>("asset.get", { assetId: id })).asset;
		const url = result.downloadUrl ?? result.url;
		if (!url) throw new CliError(`That ${head} has no file yet (status: ${result.status}).`);
		const file =
			typeof first.flags.get("output") === "string"
				? (first.flags.get("output") as string)
				: head === "render"
					? `${id}-${result.aspect.replace(":", "x")}-${result.resolution}.mp4`
					: `${id}.${extensionOf(result.contentType)}`;
		const bytes = await download(url, file);
		return info(`Saved ${file} (${(bytes / 1e6).toFixed(1)} MB)`);
	}

	const operation = op!;
	const properties = operation.inputSchema.properties ?? {};
	const booleans = new Set(["help", "wait", ...Object.keys(properties).filter((name) => typeOf(properties[name]) === "boolean")]);
	const { flags, positional } = parseArgs(argv, booleans);
	if (flags.has("help")) return printOpHelp(operation);

	const input: Record<string, unknown> = {};
	const whole = flags.get("input") ?? flags.get("json");
	if (typeof whole === "string") Object.assign(input, readStructured(whole, "--input") as object);
	for (const [name, value] of flags) {
		if (["input", "json", "wait", "output", "help"].includes(name)) continue;
		if (!(name in properties)) throw new CliError(`Unknown flag --${kebab(name)} for \`retween ${partsOf(operation).join(" ")}\`. Try --help.`);
		input[name] = coerce(kebab(name), value, properties[name]);
	}
	// A bare argument fills the first required id that was not given as a flag: `retween video get vid_123`.
	const extra = positional.slice(partsOf(operation).length);
	for (const value of extra) {
		const target = (operation.inputSchema.required ?? []).find((name) => !(name in input) && typeOf(properties[name]) === "string");
		if (!target) throw new CliError(`Unexpected argument "${value}". Try --help.`);
		input[target] = value;
	}
	if (flags.has("wait") && "waitSeconds" in properties && !("waitSeconds" in input)) input.waitSeconds = 45;

	let result = await callOp<Result>(operation.name, input);
	if (flags.has("wait")) result = await follow(result);

	const output = flags.get("output");
	if (typeof output === "string") {
		const url = result.downloadUrl ?? result.url ?? result.render?.downloadUrl ?? result.renders?.[0]?.downloadUrl ?? result.asset?.url;
		if (!url) throw new CliError("There is no file to save yet. Use --wait, or check the status and try again.");
		const bytes = await download(url, output);
		info(`Saved ${output} (${(bytes / 1e6).toFixed(2)} MB)`);
	}
	// Briefs and guides are documents: print them as text rather than as a JSON string.
	if (typeof result.brief === "string" && Object.keys(result).length === 1) return console.log(result.brief);
	if (typeof result.guide === "string" && Object.keys(result).length === 1) return console.log(result.guide);
	console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
	if (error instanceof CliError) info(`${useColor ? "\x1b[31m" : ""}error${useColor ? "\x1b[0m" : ""}  ${error.message}`);
	else console.error(error);
	process.exit(1);
});
