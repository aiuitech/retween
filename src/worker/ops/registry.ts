/**
 * The operation registry.
 *
 * Every capability of the service is defined once, as an operation with a
 * name, a description, a zod input schema and a handler. The three surfaces
 * are thin shells over this list:
 *
 *   REST  POST /api/v1/ops/<name>          (what the CLI and web app call)
 *   MCP   a tool per operation             (project.create → project_create)
 *   CLI   a command per operation          (retween project create --name …)
 *
 * so adding an operation here makes it available everywhere at once.
 */
import { z } from "zod";
import { type Actor, assertNotGuest } from "../auth/index.ts";
import { isTransient, withRetry } from "../lib/util.ts";

export interface OpContext {
	actor: Actor;
}

export interface Op<Input extends z.ZodType = z.ZodType, Output = unknown> {
	/** Dotted name: `<group>.<verb>`. */
	name: string;
	title: string;
	/** Written for an agent deciding whether and how to call this. */
	description: string;
	input: Input;
	handler: (input: z.output<Input>, ctx: OpContext) => Promise<Output>;
	/** Only administrators can see or call it. */
	admin?: boolean;
	/** Only superusers (SUPERUSER_EMAILS) can see or call it: moving money. Implies `admin`. */
	superuser?: boolean;
	/** Does not change anything. */
	readOnly?: boolean;
	/** Deletes something that cannot be recovered. */
	destructive?: boolean;
	/** Spends generation budget. */
	paid?: boolean;
}

export function defineOp<Input extends z.ZodType, Output>(op: Op<Input, Output>): Op {
	return op as unknown as Op;
}

/**
 * Runs an operation's handler with already-validated input. An operation that
 * only reads is tried again when our own infrastructure hiccups (a dropped D1
 * connection, a reset socket), so one blip does not reach the caller as an error.
 */
export async function invokeOp(op: Op, input: unknown, ctx: OpContext): Promise<unknown> {
	if (op.paid) assertNotGuest(ctx.actor, "start paid work");
	// What the operation may do in a shared project: viewers can run what only reads (and spends nothing).
	const scoped: OpContext = { ...ctx, actor: { ...ctx.actor, access: op.readOnly && !op.paid ? "view" : "edit" } };
	if (!op.readOnly) return op.handler(input, scoped);
	return withRetry(() => op.handler(input, scoped), { attempts: 3, baseDelayMs: 250, retryIf: isTransient });
}

/** An image returned alongside an operation's JSON result (shown inline over MCP). */
export interface InlineImage {
	base64: string;
	mimeType: string;
}
export const INLINE_IMAGE = "_image";

export const waitSeconds = z
	.number()
	.min(0)
	.max(50)
	.default(25)
	.describe("How long to wait for the work to finish before returning. If it is still running you get its id and current status; check again with the matching get operation");

export function manifestEntry(op: Op) {
	return {
		name: op.name,
		title: op.title,
		description: op.description,
		inputSchema: z.toJSONSchema(op.input, { io: "input", unrepresentable: "any" }),
		admin: op.admin ?? false,
		superuser: op.superuser ?? false,
		readOnly: op.readOnly ?? false,
		destructive: op.destructive ?? false,
		paid: op.paid ?? false,
	};
}
