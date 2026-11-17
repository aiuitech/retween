/** An error that is safe to show to the caller. */
export class AppError extends Error {
	constructor(
		readonly status: number,
		message: string,
		readonly code: string = "error",
		readonly details?: unknown,
	) {
		super(message);
		this.name = "AppError";
	}
}

export const notFound = (what: string) => new AppError(404, `${what} not found`, "not_found");
export const badRequest = (message: string, details?: unknown) => new AppError(400, message, "bad_request", details);
export const forbidden = (message: string, code = "forbidden") => new AppError(403, message, code);

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

/** Prefixed random id, e.g. `prj_3k9d0s8a7f6g5h4j`. */
export function newId(prefix: string): string {
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	let out = "";
	for (const byte of bytes) out += ALPHABET[byte % 32];
	return `${prefix}_${out}`;
}

export async function sha256Hex(input: string | ArrayBuffer | Uint8Array): Promise<string> {
	const data = typeof input === "string" ? new TextEncoder().encode(input) : input;
	const digest = await crypto.subtle.digest("SHA-256", data as BufferSource);
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Stable hash of a JSON value (object keys sorted). */
export function hashOf(value: unknown): Promise<string> {
	const stable = (v: unknown): unknown => {
		if (Array.isArray(v)) return v.map(stable);
		if (v && typeof v === "object") {
			return Object.fromEntries(
				Object.entries(v as Record<string, unknown>)
					.filter(([, x]) => x !== undefined)
					.sort(([a], [b]) => a.localeCompare(b))
					.map(([k, x]) => [k, stable(x)]),
			);
		}
		return v;
	};
	return sha256Hex(JSON.stringify(stable(value))).then((hex) => hex.slice(0, 32));
}

export function base64ToBytes(base64: string): Uint8Array {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

export function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	const chunk = 0x8000;
	for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
	return btoa(binary);
}

export const base64Url = {
	encode(text: string): string {
		return bytesToBase64(new TextEncoder().encode(text)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
	},
	decode(encoded: string): string {
		return new TextDecoder().decode(base64ToBytes(encoded.replace(/-/g, "+").replace(/_/g, "/")));
	},
};

export function slugify(text: string, max = 40): string {
	return (
		text
			.toLowerCase()
			.normalize("NFKD")
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, max)
			.replace(/-+$/, "") || "untitled"
	);
}

export function startOfMonthUtc(now = new Date()): Date {
	return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

/** Reads an error body from an upstream API into one readable line. */
export async function upstreamError(provider: string, response: Response): Promise<AppError> {
	const body = await response.text().catch(() => "");
	let message = body.slice(0, 600);
	try {
		const json = JSON.parse(body);
		const detail = json.error?.message ?? json.detail?.message ?? json.detail ?? json.message ?? json.error;
		if (detail) message = typeof detail === "string" ? detail : JSON.stringify(detail);
	} catch {
		// not JSON: keep the raw text
	}
	const status = response.status === 429 || response.status >= 500 ? 502 : 422;
	return new AppError(status, `${provider} error (${response.status}): ${message || response.statusText}`, "upstream_error", {
		provider,
		upstreamStatus: response.status,
	});
}

/** True for upstream failures worth retrying (rate limits, 5xx, network). */
export function isRetryable(error: unknown): boolean {
	if (error instanceof AppError) return error.status === 502;
	return true;
}
