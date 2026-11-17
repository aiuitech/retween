import { apiKeyClient } from "@better-auth/api-key/client";
import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import { deviceAuthorizationClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({
	plugins: [oauthProviderClient(), deviceAuthorizationClient(), apiKeyClient()],
});

export interface Me {
	id: string;
	email: string;
	name: string;
	image: string | null;
	isAdmin: boolean;
	approved: boolean;
	banned: boolean;
	budget: { monthlyBudgetUsd: number; spentThisMonthUsd: number; remainingUsd: number };
}

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

export async function fetchMe(): Promise<Me | null> {
	return (await read<{ user: Me | null }>(await fetch("/api/v1/me"))).user;
}

/** Runs a service operation: the same operations the CLI and MCP tools use. */
export async function op<T = Record<string, unknown>>(name: string, input: object = {}): Promise<T> {
	const response = await fetch(`/api/v1/ops/${name}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(input),
	});
	return (await read<{ result: T }>(response)).result;
}

/**
 * Uploads one file into a project as an asset (the same endpoint the CLI uses).
 * XHR rather than fetch so the caller can show upload progress.
 */
export function uploadAsset(
	projectId: string,
	file: File,
	options: { tags?: string; onProgress?: (fraction: number) => void } = {},
): Promise<{ id: string; name: string }> {
	const query = new URLSearchParams({ name: file.name });
	if (options.tags?.trim()) query.set("tags", options.tags);
	return new Promise((resolve, reject) => {
		const xhr = new XMLHttpRequest();
		xhr.open("PUT", `/api/v1/projects/${encodeURIComponent(projectId)}/assets?${query}`);
		// An empty type (common for fonts) lets the server go by the file extension.
		xhr.setRequestHeader("content-type", file.type || "application/octet-stream");
		xhr.upload.onprogress = (event) => event.lengthComputable && options.onProgress?.(event.loaded / event.total);
		xhr.onload = () => {
			let body: { ok?: boolean; result?: { asset: { id: string; name: string } }; error?: { message: string; code: string } } | null = null;
			try {
				body = JSON.parse(xhr.responseText);
			} catch {
				// not JSON, e.g. the platform's own "request too large" page
			}
			if (xhr.status >= 200 && xhr.status < 300 && body?.result) return resolve(body.result.asset);
			const message =
				body?.error?.message ?? (xhr.status === 413 ? "This file is too large to upload. Try a smaller or more compressed export." : `Upload failed (${xhr.status})`);
			reject(new ApiError(message, body?.error?.code ?? "error", xhr.status));
		};
		xhr.onerror = () => reject(new ApiError("Network error while uploading", "network", 0));
		xhr.send(file);
	});
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
export const when = (value: string | number | Date | null | undefined) =>
	value ? new Date(value).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "";
