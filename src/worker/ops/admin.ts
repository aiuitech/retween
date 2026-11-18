import { and, count, desc, eq, gte, like, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import { superuserEmails } from "../auth/index.ts";
import { db, schema } from "../db/client.ts";
import { badRequest, notFound, startOfMonthUtc } from "../lib/util.ts";
import { chargeFor, creditBalanceMicros, markup } from "../services/billing.ts";
import { reconcileContainers, reconcileFal } from "../services/reconcile.ts";
import { deletePrefix } from "../services/storage.ts";
import { defineOp } from "./registry.ts";

const usd = (micros: number) => Math.round(micros / 10_000) / 100;

async function userRow(user: typeof schema.user.$inferSelect, spent: Map<string, number>, projects: Map<string, number>) {
	const isAdmin = (user.role ?? "").split(",").includes("admin");
	return {
		id: user.id,
		email: user.email,
		name: user.name,
		image: user.image,
		role: isAdmin ? "admin" : "user",
		superuser: superuserEmails.includes(user.email.toLowerCase()),
		/** exempt (administrators), active (payment method on file), none (not set up yet), past_due (an invoice is unpaid). */
		billing: isAdmin ? "exempt" : (user.billingStatus ?? "none"),
		banned: user.banned === true,
		banReason: user.banReason ?? undefined,
		monthlyBudgetUsd: (user.monthlyBudgetCents ?? 0) / 100,
		/** Billed amount (markup included) so far this month. */
		spentThisMonthUsd: usd(chargeFor(spent.get(user.id) ?? 0)),
		creditUsd: usd(await creditBalanceMicros(user.id)),
		projects: projects.get(user.id) ?? 0,
		createdAt: user.createdAt,
	};
}

async function spendByUser(): Promise<Map<string, number>> {
	const rows = await db
		.select({ userId: schema.usageEvents.userId, total: sql<number>`sum(${schema.usageEvents.costMicros})` })
		.from(schema.usageEvents)
		.where(gte(schema.usageEvents.createdAt, startOfMonthUtc()))
		.groupBy(schema.usageEvents.userId);
	return new Map(rows.map((row) => [row.userId, row.total]));
}

async function projectsByUser(): Promise<Map<string, number>> {
	const rows = await db.select({ ownerId: schema.projects.ownerId, n: count() }).from(schema.projects).groupBy(schema.projects.ownerId);
	return new Map(rows.map((row) => [row.ownerId, row.n]));
}

export const adminOps = [
	defineOp({
		name: "admin.users",
		title: "List users",
		description: "Everyone who has signed in, with billing status, role, spend cap, credit and this month's charges (as billed, markup included).",
		admin: true,
		readOnly: true,
		input: z.object({
			search: z.string().max(100).optional().describe("Match name or email"),
			status: z.enum(["no_billing", "active", "past_due", "banned"]).optional().describe("no_billing: signed in but no payment method yet"),
			limit: z.number().int().min(1).max(200).default(100),
			offset: z.number().int().min(0).default(0),
		}),
		handler: async (input) => {
			const isAdmin = sql`(',' || coalesce(${schema.user.role}, '') || ',') like '%,admin,%'`;
			const where = and(
				input.search ? or(like(schema.user.email, `%${input.search}%`), like(schema.user.name, `%${input.search}%`)) : undefined,
				input.status === "banned" ? eq(schema.user.banned, true) : undefined,
				input.status === "no_billing" ? sql`coalesce(${schema.user.billingStatus}, 'none') = 'none' and not ${isAdmin}` : undefined,
				input.status === "active" ? sql`(${schema.user.billingStatus} = 'active' or ${isAdmin})` : undefined,
				input.status === "past_due" ? sql`${schema.user.billingStatus} = 'past_due' and not ${isAdmin}` : undefined,
			);
			const [rows, [total], [noBilling], [pastDue], spent, projects] = await Promise.all([
				db.query.user.findMany({ where, orderBy: desc(schema.user.createdAt), limit: input.limit, offset: input.offset }),
				db.select({ n: count() }).from(schema.user).where(where),
				db.select({ n: count() }).from(schema.user).where(sql`coalesce(${schema.user.billingStatus}, 'none') = 'none' and not ${isAdmin}`),
				db.select({ n: count() }).from(schema.user).where(sql`${schema.user.billingStatus} = 'past_due' and not ${isAdmin}`),
				spendByUser(),
				projectsByUser(),
			]);
			return {
				users: await Promise.all(rows.map((row) => userRow(row, spent, projects))),
				total: total?.n ?? 0,
				noBilling: noBilling?.n ?? 0,
				pastDue: pastDue?.n ?? 0,
			};
		},
	}),

	defineOp({
		name: "admin.user_update",
		title: "Update user",
		description: "Change a user's role, set their monthly spend cap (in billed dollars, markup included), or suspend them. Access itself comes from adding a payment method.",
		admin: true,
		input: z.object({
			userId: z.string(),
			role: z.enum(["admin", "user"]).optional(),
			monthlyBudgetUsd: z.number().min(0).max(100000).optional().describe("Monthly spend cap in billed US dollars"),
			banned: z.boolean().optional(),
			banReason: z.string().max(300).optional(),
		}),
		handler: async (input, { actor }) => {
			const user = await db.query.user.findFirst({ where: eq(schema.user.id, input.userId) });
			if (!user) throw notFound("User");
			const restricting = input.banned === true || input.role === "user";
			if (restricting && user.id === actor.id) throw badRequest("You cannot remove your own access");
			if (restricting && superuserEmails.includes(user.email.toLowerCase())) {
				throw badRequest("This account is a configured superuser and cannot be restricted here");
			}
			const [updated] = await db
				.update(schema.user)
				.set({
					...(input.role ? { role: input.role } : {}),
					...(input.monthlyBudgetUsd !== undefined ? { monthlyBudgetCents: Math.round(input.monthlyBudgetUsd * 100) } : {}),
					...(input.banned !== undefined
						? { banned: input.banned, banReason: input.banned ? (input.banReason ?? "Suspended by an administrator") : null, banExpires: null }
						: {}),
				})
				.where(eq(schema.user.id, user.id))
				.returning();
			// Losing access takes effect at once: existing sign-ins are ended.
			if (input.banned === true) {
				await db.delete(schema.session).where(eq(schema.session.userId, user.id));
			}
			return { user: await userRow(updated!, await spendByUser(), await projectsByUser()) };
		},
	}),

	defineOp({
		name: "admin.user_delete",
		title: "Delete user",
		description: "Permanently delete a user with all of their projects, assets, videos and renders.",
		admin: true,
		destructive: true,
		input: z.object({ userId: z.string(), confirm: z.literal(true) }),
		handler: async (input, { actor }) => {
			const user = await db.query.user.findFirst({ where: eq(schema.user.id, input.userId) });
			if (!user) throw notFound("User");
			if (user.id === actor.id) throw badRequest("You cannot delete your own account here");
			if (superuserEmails.includes(user.email.toLowerCase())) throw badRequest("This account is a configured superuser");
			const projects = await db.query.projects.findMany({ where: eq(schema.projects.ownerId, user.id) });
			for (const project of projects) await deletePrefix(`projects/${project.id}/`);
			// API keys are not tied to the user row by a foreign key, so remove them explicitly.
			await db.delete(schema.apikey).where(eq(schema.apikey.referenceId, user.id));
			await db.delete(schema.user).where(eq(schema.user.id, user.id));
			return { deleted: user.id, projects: projects.length };
		},
	}),

	defineOp({
		name: "admin.stats",
		title: "Service stats",
		description: "Totals across the service: users, projects, videos, renders, and this month's vendor cost and billed charges by kind.",
		admin: true,
		readOnly: true,
		input: z.object({}),
		handler: async () => {
			const [[users], [projects], [videos], [renders], [assets], spend] = await Promise.all([
				db.select({ n: count() }).from(schema.user),
				db.select({ n: count() }).from(schema.projects),
				db.select({ n: count() }).from(schema.videos),
				db.select({ n: count() }).from(schema.renders).where(eq(schema.renders.status, "done")),
				db.select({ n: count(), bytes: sql<number>`coalesce(sum(${schema.assets.bytes}), 0)` }).from(schema.assets),
				db
					.select({ kind: schema.usageEvents.kind, total: sql<number>`sum(${schema.usageEvents.costMicros})`, events: count() })
					.from(schema.usageEvents)
					.where(gte(schema.usageEvents.createdAt, startOfMonthUtc()))
					.groupBy(schema.usageEvents.kind),
			]);
			return {
				users: users?.n ?? 0,
				projects: projects?.n ?? 0,
				videos: videos?.n ?? 0,
				finishedRenders: renders?.n ?? 0,
				assets: assets?.n ?? 0,
				storedBytes: assets?.bytes ?? 0,
				spendThisMonthUsd: usd(spend.reduce((total, row) => total + row.total, 0)),
				chargesThisMonthUsd: usd(chargeFor(spend.reduce((total, row) => total + row.total, 0))),
				markup: markup(),
				spendByKind: spend.map((row) => ({ kind: row.kind, usd: usd(row.total), events: row.events })),
			};
		},
	}),

	defineOp({
		name: "admin.costs",
		title: "Cost statement",
		description:
			"What each account cost to serve over a period, from the usage ledger: every vendor charge (OpenRouter, ElevenLabs, fal, " +
			"Cloudflare containers and storage) attributed to the person who caused it, broken down by provider, kind and model. " +
			"chargeUsd is what is billed (cost × markup; the configured BILLING_MARKUP unless one is passed). `basis` says how exact each cost is: vendor (reported by the vendor), " +
			"metered (vendor-reported or measured units × our rate), list (published list price).",
		admin: true,
		readOnly: true,
		input: z.object({
			userId: z.string().optional().describe("One account; omit for every account with charges in the period"),
			from: z.iso.date().optional().describe("First day, inclusive (UTC). Default: the first of this month"),
			to: z.iso.date().optional().describe("Last day, inclusive (UTC). Default: today"),
			markup: z.number().min(0).max(100).optional().describe("Multiplier applied to cost, e.g. 1.4 for 40% on top. Default: the configured BILLING_MARKUP"),
		}),
		handler: async ({ markup: givenMarkup, ...input }) => {
			const factor = givenMarkup ?? markup();
			const from = input.from ? new Date(`${input.from}T00:00:00Z`) : startOfMonthUtc();
			const to = input.to ? new Date(Date.parse(`${input.to}T00:00:00Z`) + 86_400_000) : new Date();
			if (!(to > from)) throw badRequest("`to` must be on or after `from`");
			const usage = schema.usageEvents;
			const rows = await db
				.select({
					userId: usage.userId,
					email: schema.user.email,
					name: schema.user.name,
					provider: usage.provider,
					kind: usage.kind,
					model: usage.model,
					unit: usage.unit,
					basis: usage.basis,
					quantity: sql<number>`sum(${usage.quantity})`,
					micros: sql<number>`sum(${usage.costMicros})`,
					events: count(),
				})
				.from(usage)
				.innerJoin(schema.user, eq(schema.user.id, usage.userId))
				.where(and(gte(usage.createdAt, from), lt(usage.createdAt, to), input.userId ? eq(usage.userId, input.userId) : undefined))
				.groupBy(usage.userId, usage.provider, usage.kind, usage.model, usage.unit, usage.basis);

			const precise = (micros: number) => Math.round(micros) / 1_000_000;
			const cents = (micros: number) => Math.round(micros / 10_000) / 100;
			const accounts = new Map<
				string,
				{ userId: string; email: string; name: string; micros: number; byBasis: Record<string, number>; lines: unknown[] }
			>();
			for (const row of rows) {
				const account = accounts.get(row.userId) ?? { userId: row.userId, email: row.email, name: row.name, micros: 0, byBasis: {}, lines: [] };
				accounts.set(row.userId, account);
				account.micros += row.micros;
				account.byBasis[row.basis] = (account.byBasis[row.basis] ?? 0) + row.micros;
				account.lines.push({
					provider: row.provider,
					kind: row.kind,
					model: row.model ?? undefined,
					basis: row.basis,
					quantity: row.quantity,
					unit: row.unit,
					events: row.events,
					costUsd: precise(row.micros),
				});
			}
			const statements = [...accounts.values()]
				.sort((a, b) => b.micros - a.micros)
				.map(({ micros, byBasis, ...account }) => ({
					...account,
					costUsd: precise(micros),
					chargeUsd: cents(micros * factor),
					costByBasisUsd: Object.fromEntries(Object.entries(byBasis).map(([basis, value]) => [basis, precise(value)])),
				}));
			const totalMicros = [...accounts.values()].reduce((sum, account) => sum + account.micros, 0);
			return {
				period: { from: from.toISOString(), to: to.toISOString() },
				markup: factor,
				totalCostUsd: precise(totalMicros),
				totalChargeUsd: statements.reduce((sum, statement) => Math.round((sum + statement.chargeUsd) * 100) / 100, 0),
				statements,
			};
		},
	}),

	defineOp({
		name: "admin.reconcile",
		title: "Reconcile costs",
		description:
			"Replace metered costs from the past week with what the vendors actually billed: fal requests (with FAL_KEY, which needs billing read access) and " +
			"container runs (needs CLOUDFLARE_ANALYTICS_TOKEN). Runs nightly on its own; run it by hand before producing statements for a period that just closed.",
		admin: true,
		input: z.object({}),
		handler: async () => {
			const settle = (job: () => Promise<unknown>) => job().catch((error: Error) => ({ error: error.message }));
			const [fal, containers] = await Promise.all([settle(reconcileFal), settle(reconcileContainers)]);
			return { fal, containers };
		},
	}),

	defineOp({
		name: "admin.usage",
		title: "Usage log",
		description: "Recent generation and render activity, optionally for one user.",
		admin: true,
		readOnly: true,
		input: z.object({ userId: z.string().optional(), limit: z.number().int().min(1).max(500).default(100) }),
		handler: async (input) => {
			const rows = await db
				.select({
					id: schema.usageEvents.id,
					at: schema.usageEvents.createdAt,
					email: schema.user.email,
					kind: schema.usageEvents.kind,
					provider: schema.usageEvents.provider,
					model: schema.usageEvents.model,
					quantity: schema.usageEvents.quantity,
					unit: schema.usageEvents.unit,
					costMicros: schema.usageEvents.costMicros,
					estimated: schema.usageEvents.estimated,
					basis: schema.usageEvents.basis,
					ref: schema.usageEvents.ref,
					vendorRef: schema.usageEvents.vendorRef,
				})
				.from(schema.usageEvents)
				.innerJoin(schema.user, eq(schema.user.id, schema.usageEvents.userId))
				.where(input.userId ? eq(schema.usageEvents.userId, input.userId) : undefined)
				.orderBy(desc(schema.usageEvents.createdAt))
				.limit(input.limit);
			return { events: rows.map(({ costMicros, ...row }) => ({ ...row, usd: Math.round(costMicros / 100) / 10_000 })) };
		},
	}),
];
