import { and, eq, gte, sql } from "drizzle-orm";
import type { Actor } from "../auth/index.ts";
import { db, schema } from "../db/client.ts";
import type { UsageKind } from "../db/schema.ts";
import { AppError, newId, startOfMonthUtc } from "../lib/util.ts";

export async function recordUsage(event: {
	userId: string;
	projectId?: string | null;
	kind: UsageKind;
	provider: string;
	model?: string;
	quantity: number;
	unit: string;
	costUsd: number;
	estimated?: boolean;
	ref?: string;
}): Promise<void> {
	await db.insert(schema.usageEvents).values({
		id: newId("use"),
		userId: event.userId,
		projectId: event.projectId ?? null,
		kind: event.kind,
		provider: event.provider,
		model: event.model,
		quantity: Math.round(event.quantity),
		unit: event.unit,
		costMicros: Math.round(event.costUsd * 1_000_000),
		estimated: event.estimated ?? false,
		ref: event.ref,
	});
}

/** Spend so far this calendar month (UTC), in millionths of a dollar. */
export async function monthSpendMicros(userId: string): Promise<number> {
	const [row] = await db
		.select({ total: sql<number>`coalesce(sum(${schema.usageEvents.costMicros}), 0)` })
		.from(schema.usageEvents)
		.where(and(eq(schema.usageEvents.userId, userId), gte(schema.usageEvents.createdAt, startOfMonthUtc())));
	return row?.total ?? 0;
}

export async function budgetStatus(user: { id: string; monthlyBudgetCents: number }) {
	const spentMicros = await monthSpendMicros(user.id);
	return {
		monthlyBudgetUsd: user.monthlyBudgetCents / 100,
		spentThisMonthUsd: Math.round(spentMicros / 10_000) / 100,
		remainingUsd: Math.max(0, Math.round(user.monthlyBudgetCents * 100 - spentMicros / 100) / 10_000),
	};
}

/** Refuses paid work once the month's budget is used up. */
export async function assertBudget(actor: Actor): Promise<void> {
	const spentMicros = await monthSpendMicros(actor.id);
	if (spentMicros >= actor.monthlyBudgetCents * 10_000) {
		throw new AppError(
			402,
			`This month's generation budget ($${(actor.monthlyBudgetCents / 100).toFixed(2)}) is used up. Ask an administrator to raise it.`,
			"budget_exceeded",
		);
	}
}
