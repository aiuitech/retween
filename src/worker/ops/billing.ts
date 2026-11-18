import { env } from "cloudflare:workers";
import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { type Actor, actorById } from "../auth/index.ts";
import { db, schema } from "../db/client.ts";
import { badRequest, forbidden, notFound } from "../lib/util.ts";
import {
	KIND_LABELS,
	chargeFor,
	creditBalanceMicros,
	grantCredit,
	invoiceDateFor,
	invoicePeriod,
	markup,
	periodOf,
	periodRange,
	previousPeriod,
	recentInvoices,
	usageLines,
} from "../services/billing.ts";
import { budgetStatus } from "../services/usage.ts";
import { defineOp } from "./registry.ts";

const month = z
	.string()
	.regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Write the month as YYYY-MM")
	.describe("Calendar month (UTC) as YYYY-MM. Default: this month");

const dollars = (micros: number) => Math.round(micros / 10_000) / 100;

/** Your own account, or (administrators only) someone else's. */
async function whose(actor: Actor, userId?: string): Promise<Actor> {
	if (!userId || userId === actor.id) return actor;
	if (!actor.isAdmin) throw forbidden("Only administrators can see another account's spend");
	const target = await actorById(userId, "session");
	if (!target) throw notFound("User");
	return target;
}

export const billingOps = [
	defineOp({
		name: "billing.spend",
		title: "Spend so far",
		description:
			"What the account has spent at this moment, as it will be billed: charges so far this month (or any past month) by kind of media and by project, " +
			"unspent credit, the estimated invoice, the monthly spend cap and what is left of it, billing status and recent invoices. " +
			"Charges appear here as soon as each vendor answers, so this is exact up to the last request. Invoices are issued on the 2nd for the month before.",
		readOnly: true,
		input: z.object({
			month: month.optional(),
			userId: z.string().optional().describe("Administrators only: another account"),
		}),
		handler: async (input, { actor }) => {
			const target = await whose(actor, input.userId);
			const now = new Date();
			const period = input.month ?? periodOf(now);
			const { from, to } = periodRange(period);
			if (from > now) throw badRequest(`${period} has not started yet`);
			const current = period === periodOf(now);

			const usage = schema.usageEvents;
			const [lines, projects, [invoice], creditMicros, budget, invoices] = await Promise.all([
				usageLines(target.id, from, to).then((byUser) => byUser.get(target.id) ?? []),
				db
					.select({ projectId: usage.projectId, name: schema.projects.name, costMicros: sql<number>`sum(${usage.costMicros})` })
					.from(usage)
					.leftJoin(schema.projects, eq(schema.projects.id, usage.projectId))
					.where(and(eq(usage.userId, target.id), gte(usage.createdAt, from), lt(usage.createdAt, to)))
					.groupBy(usage.projectId)
					.orderBy(desc(sql`sum(${usage.costMicros})`))
					.limit(20),
				db.query.invoices.findMany({ where: and(eq(schema.invoices.userId, target.id), eq(schema.invoices.period, period)), limit: 1 }),
				creditBalanceMicros(target.id),
				budgetStatus(target),
				recentInvoices(target.id, 6),
			]);
			const chargeCents = lines.reduce((sum, line) => sum + line.cents, 0);
			const creditCents = Math.floor(creditMicros / 10_000);
			const exempt = target.billing === "exempt";
			return {
				account: { id: target.id, email: target.email },
				month: period,
				asOf: now.toISOString(),
				closed: !current,
				chargesUsd: chargeCents / 100,
				byKind: lines
					.filter((line) => line.cents > 0)
					.sort((a, b) => b.cents - a.cents)
					.map((line) => ({
						kind: line.kind,
						label: KIND_LABELS[line.kind],
						...(line.unit ? { quantity: line.quantity, unit: line.unit } : {}),
						chargeUsd: line.cents / 100,
					})),
				byProject: projects.map((row) => ({
					projectId: row.projectId ?? undefined,
					name: row.projectId ? (row.name ?? "Deleted project") : "Account-wide (storage and other)",
					chargeUsd: dollars(chargeFor(row.costMicros)),
				})),
				creditUsd: creditCents / 100,
				estimatedBillUsd: exempt ? 0 : invoice ? invoice.amountDueCents / 100 : Math.max(0, chargeCents - creditCents) / 100,
				invoice: invoice
					? { status: invoice.status, chargeUsd: invoice.chargeCents / 100, creditUsd: invoice.creditCents / 100, amountDueUsd: invoice.amountDueCents / 100, url: invoice.hostedUrl ?? undefined }
					: exempt
						? undefined
						: { status: "upcoming", issuedOn: invoiceDateFor(period) },
				...(current
					? { cap: { monthlyCapUsd: budget.monthlyBudgetUsd, ownLimitUsd: budget.ownLimitUsd, remainingUsd: budget.remainingUsd } }
					: {}),
				billing: {
					status: target.billing,
					...(exempt ? {} : { manageUrl: `${env.APP_URL}/api/billing/portal`, setupUrl: `${env.APP_URL}/billing` }),
				},
				recentInvoices: invoices,
				// What it cost to serve, for administrators only.
				...(actor.isAdmin ? { costUsd: dollars(lines.reduce((sum, line) => sum + line.costMicros, 0)), markup: markup() } : {}),
			};
		},
	}),

	defineOp({
		name: "admin.credit_grant",
		title: "Give credit",
		description:
			"Superusers only. Give an account credit in US dollars (a negative amount takes unspent credit back). " +
			"Credit is spent before anything is charged to the account's payment method, and lets it spend past its monthly cap by that much.",
		admin: true,
		superuser: true,
		input: z.object({
			userId: z.string(),
			amountUsd: z.number().min(-100_000).max(100_000).describe("Dollars of credit, e.g. 20. Negative to take credit back"),
			note: z.string().max(300).optional().describe("Why, e.g. 'Refund for failed render'"),
		}),
		handler: async (input, { actor }) => {
			const user = await db.query.user.findFirst({ where: eq(schema.user.id, input.userId) });
			if (!user) throw notFound("User");
			return { userId: user.id, email: user.email, ...(await grantCredit({ ...input, grantedBy: actor.id })) };
		},
	}),

	defineOp({
		name: "admin.credits",
		title: "Credit history",
		description: "Credit given to an account (and taken back), with who gave it and why, and the unspent balance.",
		admin: true,
		readOnly: true,
		input: z.object({ userId: z.string() }),
		handler: async (input) => {
			const rows = await db
				.select({
					id: schema.billingCredits.id,
					amountMicros: schema.billingCredits.amountMicros,
					note: schema.billingCredits.note,
					grantedBy: schema.user.email,
					at: schema.billingCredits.createdAt,
				})
				.from(schema.billingCredits)
				.leftJoin(schema.user, eq(schema.user.id, schema.billingCredits.grantedBy))
				.where(eq(schema.billingCredits.userId, input.userId))
				.orderBy(desc(schema.billingCredits.createdAt));
			return {
				creditBalanceUsd: dollars(await creditBalanceMicros(input.userId)),
				grants: rows.map(({ amountMicros, ...row }) => ({ ...row, amountUsd: dollars(amountMicros) })),
			};
		},
	}),

	defineOp({
		name: "admin.invoices",
		title: "Invoices",
		description: "Monthly invoices across accounts, newest first, optionally for one month or one account.",
		admin: true,
		readOnly: true,
		input: z.object({ month: month.optional(), userId: z.string().optional(), limit: z.number().int().min(1).max(500).default(100) }),
		handler: async (input) => {
			const rows = await db
				.select({ invoice: schema.invoices, email: schema.user.email })
				.from(schema.invoices)
				.innerJoin(schema.user, eq(schema.user.id, schema.invoices.userId))
				.where(and(input.month ? eq(schema.invoices.period, input.month) : undefined, input.userId ? eq(schema.invoices.userId, input.userId) : undefined))
				.orderBy(desc(schema.invoices.period), desc(schema.invoices.amountDueCents))
				.limit(input.limit);
			return {
				invoices: rows.map(({ invoice, email }) => ({
					id: invoice.id,
					userId: invoice.userId,
					email,
					month: invoice.period,
					status: invoice.status,
					costUsd: dollars(invoice.costMicros),
					markup: invoice.markup,
					chargeUsd: invoice.chargeCents / 100,
					creditUsd: invoice.creditCents / 100,
					amountDueUsd: invoice.amountDueCents / 100,
					stripeInvoiceId: invoice.stripeInvoiceId ?? undefined,
					url: invoice.hostedUrl ?? undefined,
					error: invoice.error ?? undefined,
				})),
			};
		},
	}),

	defineOp({
		name: "admin.invoice_run",
		title: "Run invoicing",
		description:
			"Superusers only. Bill a closed month: one Stripe invoice per account with charges (administrators are not billed), cost × markup less unspent credit, " +
			"charged to the saved payment method. Runs by itself nightly from the 2nd; accounts already invoiced are left alone. Dry run (the default) shows what would be billed.",
		admin: true,
		superuser: true,
		input: z.object({
			month: month.optional().describe("Closed month as YYYY-MM. Default: last month"),
			userId: z.string().optional().describe("Only this account"),
			dryRun: z.boolean().default(true),
		}),
		handler: async (input) => {
			const period = input.month ?? previousPeriod();
			const results = await invoicePeriod(period, { dryRun: input.dryRun, userId: input.userId });
			return {
				month: period,
				dryRun: input.dryRun,
				markup: markup(),
				totalDueUsd: Math.round(results.reduce((sum, result) => sum + result.amountDueUsd, 0) * 100) / 100,
				invoices: results,
			};
		},
	}),
];
