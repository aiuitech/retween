/**
 * R2 storage: object keys, signed download URLs and Range-aware serving.
 *
 * Nothing in the bucket is public. Anything that needs to read an object
 * without a session (the render container, a download link handed to an
 * agent) gets a URL signed with a key derived from the auth secret.
 */
import { env } from "cloudflare:workers";
import { AppError, base64Url } from "../lib/util.ts";

export const assetKey = (projectId: string, assetId: string, extension: string) =>
	`projects/${projectId}/assets/${assetId}.${extension}`;
export const renderKey = (projectId: string, renderId: string) => `projects/${projectId}/renders/${renderId}.mp4`;

let signingKey: Promise<CryptoKey> | undefined;
function getSigningKey(): Promise<CryptoKey> {
	signingKey ??= crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(`retween-file-url:${env.BETTER_AUTH_SECRET}`),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign", "verify"],
	);
	return signingKey;
}

async function sign(payload: string): Promise<string> {
	const signature = await crypto.subtle.sign("HMAC", await getSigningKey(), new TextEncoder().encode(payload));
	return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface SignedUrlOptions {
	/** Seconds until the link stops working. Default 1 hour. */
	expiresIn?: number;
	/** Sets Content-Disposition so browsers save the file under this name. */
	downloadAs?: string;
}

/** A time-limited URL for one object. */
export async function signedUrl(key: string, options: SignedUrlOptions = {}): Promise<string> {
	const expires = Math.floor(Date.now() / 1000) + (options.expiresIn ?? 3600);
	const encoded = base64Url.encode(key);
	const signature = await sign(`${encoded}.${expires}`);
	const query = new URLSearchParams({ exp: String(expires), sig: signature });
	if (options.downloadAs) query.set("dl", options.downloadAs);
	return `${env.APP_URL}/api/files/${encoded}?${query}`;
}

/** Checks the `exp` and `sig` of a signed URL against the payload it should carry. */
async function verifySignature(url: URL, payload: (expires: number) => string): Promise<boolean> {
	const expires = Number(url.searchParams.get("exp"));
	const signature = url.searchParams.get("sig") ?? "";
	if (!Number.isFinite(expires) || expires < Date.now() / 1000) return false;
	const expected = await sign(payload(expires));
	if (expected.length !== signature.length) return false;
	let diff = 0;
	for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
	return diff === 0;
}

/** Returns the object key if the signed URL is valid and unexpired. */
export async function verifySignedUrl(url: URL): Promise<string | null> {
	const encoded = url.pathname.split("/").pop() ?? "";
	if (!encoded || !(await verifySignature(url, (expires) => `${encoded}.${expires}`))) return null;
	try {
		return base64Url.decode(encoded);
	} catch {
		return null;
	}
}

/**
 * A time-limited URL that adds files to one project on behalf of the user who
 * asked for it, with no sign-in. It can only upload: it cannot read, list or
 * delete anything. The `upload:` prefix keeps these signatures from ever
 * matching a download link's.
 */
export async function signedUploadUrl(projectId: string, userId: string, expiresIn: number): Promise<{ url: string; expiresAt: Date }> {
	const expires = Math.floor(Date.now() / 1000) + expiresIn;
	const grant = base64Url.encode(`${projectId}:${userId}`);
	const signature = await sign(`upload:${grant}.${expires}`);
	return {
		url: `${env.APP_URL}/api/uploads/${grant}?${new URLSearchParams({ exp: String(expires), sig: signature })}`,
		expiresAt: new Date(expires * 1000),
	};
}

/** The project and user a signed upload URL was issued for, if it is valid and unexpired. */
export async function verifyUploadUrl(url: URL): Promise<{ projectId: string; userId: string } | null> {
	const grant = url.pathname.split("/").pop() ?? "";
	if (!grant || !(await verifySignature(url, (expires) => `upload:${grant}.${expires}`))) return null;
	try {
		const [projectId, userId] = base64Url.decode(grant).split(":");
		return projectId && userId ? { projectId, userId } : null;
	} catch {
		return null;
	}
}

/** What a multipart upload token carries: enough to add parts and finish without a session. */
export interface MultipartGrant {
	assetId: string;
	projectId: string;
	userId: string;
	/** R2 object key. */
	key: string;
	/** R2's multipart upload id. */
	uploadId: string;
	partSize: number;
	bytes: number;
	/** Unix seconds. */
	exp: number;
}

/**
 * An opaque, expiring token for one multipart upload. The `multipart:` prefix
 * keeps its signature from ever matching a download or upload-link signature.
 */
export async function multipartToken(grant: Omit<MultipartGrant, "exp">, expiresIn: number): Promise<string> {
	const payload = base64Url.encode(JSON.stringify({ ...grant, exp: Math.floor(Date.now() / 1000) + expiresIn }));
	return `${payload}.${await sign(`multipart:${payload}`)}`;
}

/** The grant inside a multipart token, if it is genuine and unexpired. */
export async function verifyMultipartToken(token: string): Promise<MultipartGrant | null> {
	const [payload, signature = ""] = token.split(".");
	if (!payload) return null;
	const expected = await sign(`multipart:${payload}`);
	if (expected.length !== signature.length) return null;
	let diff = 0;
	for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
	if (diff !== 0) return null;
	try {
		const grant = JSON.parse(base64Url.decode(payload)) as MultipartGrant;
		return grant.exp >= Date.now() / 1000 ? grant : null;
	} catch {
		return null;
	}
}

/** Streams an object, honouring Range and conditional headers. */
export async function serveObject(request: Request, key: string, downloadAs?: string | null): Promise<Response> {
	const object = await env.MEDIA.get(key, { range: request.headers, onlyIf: request.headers });
	if (!object) return new Response("Not found", { status: 404 });

	const headers = new Headers();
	object.writeHttpMetadata(headers);
	headers.set("etag", object.httpEtag);
	headers.set("accept-ranges", "bytes");
	headers.set("cache-control", "private, max-age=3600");
	if (downloadAs) headers.set("content-disposition", `attachment; filename="${downloadAs.replace(/[^\w.\- ]/g, "_")}"`);

	if (!("body" in object) || !object.body) return new Response(null, { status: 304, headers });

	const range = object.range as { offset?: number; length?: number; suffix?: number } | undefined;
	if (range && request.headers.has("range")) {
		const offset = range.offset ?? (range.suffix !== undefined ? object.size - range.suffix : 0);
		const length = range.length ?? object.size - offset;
		headers.set("content-range", `bytes ${offset}-${offset + length - 1}/${object.size}`);
		headers.set("content-length", String(length));
		return new Response(object.body, { status: 206, headers });
	}
	headers.set("content-length", String(object.size));
	return new Response(object.body, { headers });
}

export async function readObject(key: string): Promise<{ bytes: Uint8Array; contentType: string }> {
	const object = await env.MEDIA.get(key);
	if (!object) throw new AppError(404, "Stored file is missing", "not_found");
	return {
		bytes: new Uint8Array(await object.arrayBuffer()),
		contentType: object.httpMetadata?.contentType ?? "application/octet-stream",
	};
}

const EXTENSIONS: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/webp": "webp",
	"image/gif": "gif",
	"image/svg+xml": "svg",
	"image/avif": "avif",
	"video/mp4": "mp4",
	"video/webm": "webm",
	"video/quicktime": "mov",
	"video/ogg": "ogv",
	"audio/mpeg": "mp3",
	"audio/mp3": "mp3",
	"audio/wav": "wav",
	"audio/x-wav": "wav",
	"audio/ogg": "ogg",
	"audio/aac": "aac",
	"audio/mp4": "m4a",
	"audio/x-m4a": "m4a",
	"audio/flac": "flac",
	"font/woff2": "woff2",
	"font/woff": "woff",
	"font/ttf": "ttf",
	"font/otf": "otf",
	"application/json": "json",
};
const MIME_BY_EXTENSION: Record<string, string> = {
	...Object.fromEntries(Object.entries(EXTENSIONS).map(([mime, ext]) => [ext, mime])),
	jpeg: "image/jpeg",
	mp3: "audio/mpeg",
	wav: "audio/wav",
	m4a: "audio/mp4",
	oga: "audio/ogg",
};

export function extensionFor(contentType: string, fallbackName?: string): string {
	const known = EXTENSIONS[contentType.split(";")[0]!.trim().toLowerCase()];
	if (known) return known;
	const fromName = fallbackName?.split("?")[0]?.match(/\.([a-z0-9]{2,5})$/i)?.[1]?.toLowerCase();
	return fromName ?? "bin";
}

/** Best content type from a header value and/or a file name. */
export function contentTypeFor(header: string | null | undefined, name?: string): string {
	const fromHeader = header?.split(";")[0]?.trim().toLowerCase();
	if (fromHeader && fromHeader !== "application/octet-stream" && fromHeader !== "binary/octet-stream") return fromHeader;
	const extension = name?.split("?")[0]?.match(/\.([a-z0-9]{2,5})$/i)?.[1]?.toLowerCase();
	return (extension && MIME_BY_EXTENSION[extension]) || fromHeader || "application/octet-stream";
}

export function kindFor(contentType: string): "image" | "video" | "audio" | "font" | "animation" | "other" {
	const mime = contentType.split(";")[0]!.trim().toLowerCase();
	// JSON is accepted only as a Lottie animation; storeAsset checks that it really is one.
	if (mime === "application/json" || mime === "application/lottie+json") return "animation";
	const type = mime.split("/")[0];
	if (type === "image" || type === "video" || type === "audio" || type === "font") return type;
	return "other";
}

/** Deletes every object under a key prefix. Returns how many were removed. */
export async function deletePrefix(prefix: string): Promise<number> {
	let removed = 0;
	let cursor: string | undefined;
	do {
		const page = await env.MEDIA.list({ prefix, cursor, limit: 500 });
		if (page.objects.length) await env.MEDIA.delete(page.objects.map((object) => object.key));
		removed += page.objects.length;
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
	return removed;
}
