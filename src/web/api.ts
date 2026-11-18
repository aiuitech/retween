import { apiKeyClient } from "@better-auth/api-key/client";
import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import { deviceAuthorizationClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";
import { callOp } from "./rpc.ts";

export type { Me } from "./rpc.ts";

export const authClient = createAuthClient({
	plugins: [oauthProviderClient(), deviceAuthorizationClient(), apiKeyClient()],
});

export class ApiError extends Error {
	constructor(
		message: string,
		readonly code: string,
		readonly status: number,
	) {
		super(message);
	}
}

async function read<T>(response: Response): Promise<T> {
	const body = (await response.json().catch(() => null)) as { ok?: boolean; error?: { message: string; code: string }; message?: string } | null;
	if (!response.ok || body?.ok === false) {
		throw new ApiError(body?.error?.message ?? body?.message ?? `Request failed (${response.status})`, body?.error?.code ?? "error", response.status);
	}
	return body as T;
}

/** Runs a service operation: the same operations the CLI and MCP tools use. Works while rendering on the server and in the browser. */
export async function op<T = Record<string, unknown>>(name: string, input: object = {}): Promise<T> {
	const reply = await callOp({ data: { name, input: JSON.stringify(input) } });
	if (!reply.ok) throw new ApiError(reply.message, reply.code, reply.status);
	return JSON.parse(reply.json) as T;
}

/** Files above this go up in parts (one Worker request carries at most about 100 MB). */
const MULTIPART_THRESHOLD = 90 * 1000 * 1000;

type UploadedAsset = { id: string; name: string };
type Envelope<T> = { ok?: boolean; result?: T; error?: { message: string; code: string } } | null;

/** One PUT with upload progress. XHR rather than fetch so progress can be shown. */
function put<T>(url: string, body: Blob, contentType: string | null, onProgress?: (loaded: number) => void): Promise<T> {
	return new Promise((resolve, reject) => {
		const xhr = new XMLHttpRequest();
		xhr.open("PUT", url);
		if (contentType) xhr.setRequestHeader("content-type", contentType);
		xhr.upload.onprogress = (event) => event.lengthComputable && onProgress?.(event.loaded);
		xhr.onload = () => {
			let parsed: Envelope<T> = null;
			try {
				parsed = JSON.parse(xhr.responseText);
			} catch {
				// not JSON, e.g. the platform's own "request too large" page
			}
			if (xhr.status >= 200 && xhr.status < 300 && parsed?.result) return resolve(parsed.result);
			const message =
				parsed?.error?.message ?? (xhr.status === 413 ? "This file is too large to upload. Try a smaller or more compressed export." : `Upload failed (${xhr.status})`);
			reject(new ApiError(message, parsed?.error?.code ?? "error", xhr.status));
		};
		xhr.onerror = () => reject(new ApiError("Network error while uploading", "network", 0));
		xhr.send(body);
	});
}

async function postJson<T>(url: string, body: unknown, method = "POST"): Promise<T> {
	const response = await fetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
	return (await read<{ result: T }>(response)).result;
}

/**
 * Uploads one file into a project as an asset (the same endpoints the CLI
 * uses). Large files go up in parts, three at a time, each retried once.
 */
export async function uploadAsset(
	projectId: string,
	file: File,
	options: { tags?: string; onProgress?: (fraction: number) => void } = {},
): Promise<UploadedAsset> {
	// An empty type (common for fonts) lets the server go by the file extension.
	const type = file.type || "application/octet-stream";
	if (file.size <= MULTIPART_THRESHOLD) {
		const query = new URLSearchParams({ name: file.name });
		if (options.tags?.trim()) query.set("tags", options.tags);
		const result = await put<{ asset: UploadedAsset }>(
			`/api/v1/projects/${encodeURIComponent(projectId)}/assets?${query}`,
			file,
			type,
			(loaded) => options.onProgress?.(loaded / file.size),
		);
		return result.asset;
	}

	const upload = await postJson<{ uploadId: string; partSize: number; parts: number; partUrl: string; completeUrl: string }>(
		`/api/v1/projects/${encodeURIComponent(projectId)}/uploads`,
		{ name: file.name, contentType: file.type || undefined, bytes: file.size, tags: options.tags?.trim() || undefined },
	);
	const loaded = new Array<number>(upload.parts).fill(0);
	const report = () => options.onProgress?.(loaded.reduce((a, b) => a + b, 0) / file.size);
	const done: { partNumber: number; etag: string }[] = [];
	const queue = Array.from({ length: upload.parts }, (_, i) => i + 1);
	const sendPart = async (partNumber: number) => {
		const slice = file.slice((partNumber - 1) * upload.partSize, partNumber * upload.partSize);
		const url = upload.partUrl.replace("{partNumber}", String(partNumber));
		for (let attempt = 0; ; attempt++) {
			try {
				return await put<{ partNumber: number; etag: string }>(url, slice, null, (bytes) => {
					loaded[partNumber - 1] = bytes;
					report();
				});
			} catch (error) {
				loaded[partNumber - 1] = 0;
				if (attempt >= 1 || (error instanceof ApiError && error.status >= 400 && error.status < 500)) throw error;
			}
		}
	};
	try {
		await Promise.all(
			Array.from({ length: Math.min(3, upload.parts) }, async () => {
				for (let n = queue.shift(); n; n = queue.shift()) done.push(await sendPart(n));
			}),
		);
		return (await postJson<{ asset: UploadedAsset }>(upload.completeUrl, { parts: done })).asset;
	} catch (error) {
		// Leave nothing half-uploaded behind.
		void fetch(upload.completeUrl.replace(/\/complete$/, ""), { method: "DELETE" }).catch(() => undefined);
		throw error;
	}
}

/** Calls a better-auth endpoint that has no typed client method here. */
export async function authApi<T>(path: string, init?: { method?: "GET" | "POST"; body?: object }): Promise<T> {
	const response = await fetch(`/api/auth${path}`, {
		method: init?.method ?? "GET",
		headers: init?.body ? { "content-type": "application/json" } : undefined,
		body: init?.body ? JSON.stringify(init.body) : undefined,
	});
	return read<T>(response);
}

export const usd = (value: number) => `$${value.toFixed(2)}`;

// Dates are formatted in one fixed locale and in UTC so the server-rendered page and the browser agree.
const DAY = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const MINUTE = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
type Moment = string | number | Date | null | undefined;
export const when = (value: Moment) => (value ? DAY.format(new Date(value)) : "");
export const whenExactly = (value: Moment) => (value ? `${MINUTE.format(new Date(value))} UTC` : "");

export const sizeOf = (bytes?: number | null) =>
	bytes == null ? "" : bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} KB`;

/** 75.4 → "1:15". */
export const clock = (seconds?: number | null) => {
	if (seconds == null) return "";
	const total = Math.round(seconds);
	return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
};

export const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
