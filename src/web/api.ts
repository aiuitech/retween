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
