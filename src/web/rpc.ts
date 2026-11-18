/**
 * The web app's two server functions. Pages are rendered on the server, so
 * they cannot fetch the REST API with the browser's cookies; these run the
 * same operations in-process during rendering and over RPC afterwards.
 */
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { actorFromRequest, assertActive } from "../worker/auth/index.ts";
import { AppError } from "../worker/lib/util.ts";
import { runOp } from "../worker/ops/index.ts";
import { INLINE_IMAGE } from "../worker/ops/registry.ts";
import { budgetStatus } from "../worker/services/usage.ts";

export interface Me {
	id: string;
	email: string;
	name: string;
	image: string | null;
	isAdmin: boolean;
	approved: boolean;
	banned: boolean;
	budget: { monthlyBudgetUsd: number; ownLimitUsd?: number; spentThisMonthUsd: number; remainingUsd: number };
}

/** The signed-in account, including accounts still waiting for approval. */
export const getMe = createServerFn({ method: "GET" }).handler(async (): Promise<Me | null> => {
	const actor = await actorFromRequest(getRequest());
	if (!actor) return null;
	return {
		id: actor.id,
		email: actor.email,
		name: actor.name,
		image: actor.image,
		isAdmin: actor.isAdmin,
		approved: actor.approved,
		banned: actor.banned,
		budget: await budgetStatus(actor),
	};
});

/** The address this site is being served from, for the commands the Connect page shows. */
export const getOrigin = createServerFn({ method: "GET" }).handler(async () => new URL(getRequest().url).origin);

export type OpReply = { ok: true; json: string } | { ok: false; message: string; code: string; status: number };

/**
 * Runs a service operation (the ones the CLI and MCP tools use) as the signed-in
 * person. The result travels as JSON text so it arrives exactly as the REST API would send it.
 */
export const callOp = createServerFn({ method: "POST" })
	.validator((data: { name: string; input: string }) => data)
	.handler(async ({ data }): Promise<OpReply> => {
		try {
			const actor = await actorFromRequest(getRequest());
			assertActive(actor);
			const result = (await runOp(data.name, JSON.parse(data.input), actor)) as Record<string, unknown> | undefined;
			// Inline images are for agents; pages use the URL the result carries instead.
			if (result && INLINE_IMAGE in result) delete result[INLINE_IMAGE];
			return { ok: true, json: JSON.stringify(result ?? null) };
		} catch (error) {
			if (error instanceof AppError) return { ok: false, message: error.message, code: error.code, status: error.status };
			console.error("unhandled error in", data.name, error);
			return { ok: false, message: "Something went wrong", code: "internal", status: 500 };
		}
	});
