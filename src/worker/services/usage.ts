import { and, eq, gte, sql } from "drizzle-orm";
import type { Actor } from "../auth/index.ts";
import { db, schema } from "../db/client.ts";
import type { CostBasis, UsageKind } from "../db/schema.ts";
import { AppError, newId, sha256Hex, startOfMonthUtc } from "../lib/util.ts";
import { getControls } from "./controls.ts";

export interface UsageEvent {
	userId: string;
	projectId?: string | null;
	kind: UsageKind;
	provider: string;
	model?: string;
	quantity: number;
	unit: string;
	costUsd: number;
	/** How the cost was arrived at. See `CostBasis`. */
	basis: CostBasis;
	ref?: string;
	vendorRef?: string;
	/**
	 * Makes recording idempotent: a retried workflow step that records the same
	 * charge again (same key) is ignored. Use the vendor's request id where there is one.
	 */
	dedupeKey?: string;
}

/**
 * Writes one charge to the usage ledger. This ledger is what people are billed
 * from, so record every paid vendor call as soon as the vendor has answered,
 * before anything that could fail and cause a retry (which would pay again).
 */
export async function recordUsage(event: UsageEvent): Promise<void> {
	const id = event.dedupeKey ? `use_${(await sha256Hex(event.dedupeKey)).slice(0, 24)}` : newId("use");
	await db
		.insert(schema.usageEvents)
		.values({
			id,
			userId: event.userId,
			projectId: event.projectId ?? null,
			kind: event.kind,
			provider: event.provider,
			model: event.model,
			quantity: Math.round(event.quantity),
			unit: event.unit,
			costMicros: Math.round(Math.max(0, event.costUsd) * 1_000_000),
			estimated: event.basis === "list",
			basis: event.basis,
			ref: event.ref,
			vendorRef: event.vendorRef,
		})
		.onConflictDoNothing();
}

/** Spend so far this calendar month (UTC), in millionths of a dollar. */
export async function monthSpendMicros(userId: string): Promise<number> {
	const [row] = await db
		.select({ total: sql<number>`coalesce(sum(${schema.usageEvents.costMicros}), 0)` })
		.from(schema.usageEvents)
		.where(and(eq(schema.usageEvents.userId, userId), gte(schema.usageEvents.createdAt, startOfMonthUtc())));
	return row?.total ?? 0;
}

/**
 * The month's spending limit: the allowance an administrator set, or the
 * account's own lower limit from its cost controls.
 */
async function monthlyLimit(user: { id: string; monthlyBudgetCents: number }): Promise<{ cents: number; own: boolean }> {
	const { monthlyLimitUsd } = await getControls(user.id);
	const own = monthlyLimitUsd === null ? Infinity : Math.round(monthlyLimitUsd * 100);
	return own < user.monthlyBudgetCents ? { cents: own, own: true } : { cents: user.monthlyBudgetCents, own: false };
}

export async function budgetStatus(user: { id: string; monthlyBudgetCents: number }) {
	const [spentMicros, limit] = await Promise.all([monthSpendMicros(user.id), monthlyLimit(user)]);
	return {
		monthlyBudgetUsd: user.monthlyBudgetCents / 100,
		/** The account's own lower limit, when it has set one. */
		ownLimitUsd: limit.own ? limit.cents / 100 : undefined,
		spentThisMonthUsd: Math.round(spentMicros / 10_000) / 100,
		remainingUsd: Math.max(0, Math.round(limit.cents * 100 - spentMicros / 100) / 10_000),
	};
}

/** Refuses paid work once the month's budget (or the account's own lower limit) is used up. */
export async function assertBudget(actor: Actor): Promise<void> {
	const [spentMicros, limit] = await Promise.all([monthSpendMicros(actor.id), monthlyLimit(actor)]);
	if (spentMicros >= limit.cents * 10_000) {
		throw new AppError(
			402,
			limit.own
				? `This month's spending limit ($${(limit.cents / 100).toFixed(2)}, set in this account's cost controls) is used up. Raise it with account.controls_update.`
				: `This month's generation budget ($${(limit.cents / 100).toFixed(2)}) is used up. Ask an administrator to raise it.`,
			"budget_exceeded",
		);
	}
}
