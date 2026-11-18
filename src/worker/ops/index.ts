import { z } from "zod";
import type { Actor } from "../auth/index.ts";
import { AppError, badRequest, forbidden } from "../lib/util.ts";
import { accountOps } from "./account.ts";
import { adminOps } from "./admin.ts";
import { assetOps } from "./assets.ts";
import { billingOps } from "./billing.ts";
import { footageOps } from "./footage.ts";
import { inspectOps } from "./inspect.ts";
import { projectOps } from "./projects.ts";
import { type Op, invokeOp } from "./registry.ts";
import { thumbnailOps } from "./thumbnails.ts";
import { videoOps } from "./videos.ts";
import { youtubeOps } from "./youtube.ts";

export const ops: Op[] = [...projectOps, ...accountOps, ...billingOps, ...assetOps, ...footageOps, ...videoOps, ...inspectOps, ...thumbnailOps, ...youtubeOps, ...adminOps];
const byName = new Map(ops.map((op) => [op.name, op]));

/** Operations the actor is allowed to see. */
const allowed = (op: Op, actor: Actor) => (!op.admin || actor.isAdmin) && (!op.superuser || actor.isSuperuser);
export const opsFor = (actor: Actor) => ops.filter((op) => allowed(op, actor));

/** Validates input and runs an operation on behalf of an actor. */
export async function runOp(name: string, rawInput: unknown, actor: Actor): Promise<unknown> {
	const op = byName.get(name);
	if (!op || !allowed(op, actor)) {
		if (op) throw forbidden(op.superuser ? "Superusers only" : "Administrators only");
		throw new AppError(404, `Unknown operation "${name}"`, "not_found");
	}
	const parsed = op.input.safeParse(rawInput ?? {});
	if (!parsed.success) {
		const issues = parsed.error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`);
		throw badRequest(`Invalid input for ${name}: ${issues.slice(0, 8).join("; ")}`, { issues: z.treeifyError(parsed.error) });
	}
	return invokeOp(op, parsed.data, { actor });
}
