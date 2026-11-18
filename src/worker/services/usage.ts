import { env } from "cloudflare:workers";
import { and, eq, gte, sql } from "drizzle-orm";
import type { Actor } from "../auth/index.ts";
import { db, schema } from "../db/client.ts";
import type { CostBasis, UsageKind } from "../db/schema.ts";
import { AppError, newId, sha256Hex, startOfMonthUtc } from "../lib/util.ts";
import { KIND_LABELS, chargeFor, creditBalanceMicros } from "./billing.ts";
import { getControls } from "./controls.ts";

export interface UsageEvent {
	userId: string;
	projectId?: string | null;
	/** The video the charge was made for, when there is one. */
	videoId?: string | null;
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
			videoId: event.videoId ?? null,
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

/** Vendor cost so far this calendar month (UTC), before markup, in millionths of a dollar. */
export async function monthSpendMicros(userId: string): Promise<number> {
	const [row] = await db
		.select({ total: sql<number>`coalesce(sum(${schema.usageEvents.costMicros}), 0)` })
		.from(schema.usageEvents)
		.where(and(eq(schema.usageEvents.userId, userId), gte(schema.usageEvents.createdAt, startOfMonthUtc())));
	return row?.total ?? 0;
}

/**
 * The month's spending cap, in what the account is billed (cost × markup): the
 * cap an administrator set (every account starts with DEFAULT_MONTHLY_BUDGET_CENTS),
 * or the account's own lower limit from its cost controls.
 */
async function monthlyLimit(user: { id: string; monthlyBudgetCents: number }): Promise<{ cents: number; own: boolean }> {
	const { monthlyLimitUsd } = await getControls(user.id);
	const own = monthlyLimitUsd === null ? Infinity : Math.round(monthlyLimitUsd * 100);
	return own < user.monthlyBudgetCents ? { cents: own, own: true } : { cents: user.monthlyBudgetCents, own: false };
}

/**
 * Where the account stands this month, in billed dollars. Credit is spent
 * first, so the cap applies to what would be charged to the payment method.
 */
async function standing(user: { id: string; monthlyBudgetCents: number }) {
	const [costMicros, limit, creditMicros] = await Promise.all([monthSpendMicros(user.id), monthlyLimit(user), creditBalanceMicros(user.id)]);
	const chargeMicros = chargeFor(costMicros);
	const payableMicros = Math.max(0, chargeMicros - creditMicros);
	return { chargeMicros, creditMicros, payableMicros, limit };
}

const dollars = (micros: number) => Math.round(micros / 10_000) / 100;

/**
 * What one video has cost so far, as billed (cost × markup), over its whole life: the media
 * generated for it, including versions it later replaced, and its renders. Previews, drafts,
 * footage processing and storage are account-wide and not counted.
 */
export async function videoSpend(videoId: string) {
	const usage = schema.usageEvents;
	const rows = await db
		.select({ kind: usage.kind, costMicros: sql<number>`sum(${usage.costMicros})` })
		.from(usage)
		.where(eq(usage.videoId, videoId))
		.groupBy(usage.kind);
	const total = rows.reduce((sum, row) => sum + row.costMicros, 0);
	return {
		chargeUsd: dollars(chargeFor(total)),
		byKind: rows
			.filter((row) => row.costMicros > 0)
			.sort((a, b) => b.costMicros - a.costMicros)
			.map((row) => ({ kind: row.kind, label: KIND_LABELS[row.kind], chargeUsd: dollars(chargeFor(row.costMicros)) })),
	};
}

/** What each video in a project has cost so far, as billed, keyed by video id. Videos with no charges are absent. */
export async function projectVideoSpend(projectId: string): Promise<Map<string, number>> {
	const usage = schema.usageEvents;
	const rows = await db
		.select({ videoId: usage.videoId, costMicros: sql<number>`sum(${usage.costMicros})` })
		.from(schema.videos)
		// From the project's videos to their charges, so both lookups use an index.
		.innerJoin(usage, eq(usage.videoId, schema.videos.id))
		.where(eq(schema.videos.projectId, projectId))
		.groupBy(usage.videoId);
	return new Map(rows.map((row) => [row.videoId!, dollars(chargeFor(row.costMicros))]));
}

export async function budgetStatus(user: { id: string; monthlyBudgetCents: number }) {
	const { chargeMicros, creditMicros, payableMicros, limit } = await standing(user);
	return {
		/** The monthly spend cap. */
		monthlyBudgetUsd: user.monthlyBudgetCents / 100,
		/** The account's own lower limit, when it has set one. */
		ownLimitUsd: limit.own ? limit.cents / 100 : undefined,
		/** Charges so far this month, as they will be billed. */
		spentThisMonthUsd: dollars(chargeMicros),
		/** Unspent credit, used before the payment method is charged. */
		creditUsd: dollars(creditMicros),
		/** What this month's invoice would be if the month ended now. */
		estimatedBillUsd: dollars(payableMicros),
		remainingUsd: Math.max(0, dollars(limit.cents * 10_000 - payableMicros)),
	};
}

/** Refuses paid work once the month's cap (or the account's own lower limit) is reached, or while an invoice is unpaid. */
export async function assertBudget(actor: Actor): Promise<void> {
	if (actor.billing === "past_due") {
		throw new AppError(
			402,
			`An invoice for this account is unpaid, so paid work is paused. Update the payment method at ${env.APP_URL}/api/billing/portal and it is retried at once.`,
			"payment_past_due",
		);
	}
	const { payableMicros, limit } = await standing(actor);
	if (payableMicros >= limit.cents * 10_000) {
		throw new AppError(
			402,
			limit.own
				? `This month's spending limit ($${(limit.cents / 100).toFixed(2)}, set in this account's cost controls) is reached. Raise it with account.controls_update.`
				: `This month's spend cap ($${(limit.cents / 100).toFixed(2)}) is reached. Ask an administrator to raise it.`,
			"budget_exceeded",
		);
	}
}
