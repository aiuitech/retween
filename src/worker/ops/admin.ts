import { and, count, desc, eq, gte, like, or, sql } from "drizzle-orm";
import { z } from "zod";
import { superuserEmails } from "../auth/index.ts";
import { db, schema } from "../db/client.ts";
import { badRequest, notFound, startOfMonthUtc } from "../lib/util.ts";
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
		approved: isAdmin || user.approved === true,
		banned: user.banned === true,
		banReason: user.banReason ?? undefined,
		monthlyBudgetUsd: (user.monthlyBudgetCents ?? 0) / 100,
		spentThisMonthUsd: usd(spent.get(user.id) ?? 0),
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
		description: "Everyone who has signed in, with approval state, role, budget and this month's spend.",
		admin: true,
		readOnly: true,
		input: z.object({
			search: z.string().max(100).optional().describe("Match name or email"),
			status: z.enum(["pending", "approved", "banned"]).optional(),
			limit: z.number().int().min(1).max(200).default(100),
			offset: z.number().int().min(0).default(0),
		}),
		handler: async (input) => {
			const isAdmin = sql`(',' || coalesce(${schema.user.role}, '') || ',') like '%,admin,%'`;
			const where = and(
				input.search ? or(like(schema.user.email, `%${input.search}%`), like(schema.user.name, `%${input.search}%`)) : undefined,
				input.status === "banned" ? eq(schema.user.banned, true) : undefined,
				input.status === "pending" ? sql`coalesce(${schema.user.approved}, 0) = 0 and not ${isAdmin}` : undefined,
				input.status === "approved" ? sql`(${schema.user.approved} = 1 or ${isAdmin})` : undefined,
			);
			const [rows, [total], [pending], spent, projects] = await Promise.all([
				db.query.user.findMany({ where, orderBy: desc(schema.user.createdAt), limit: input.limit, offset: input.offset }),
				db.select({ n: count() }).from(schema.user).where(where),
				db.select({ n: count() }).from(schema.user).where(sql`coalesce(${schema.user.approved}, 0) = 0 and not ${isAdmin}`),
				spendByUser(),
				projectsByUser(),
			]);
			return {
				users: await Promise.all(rows.map((row) => userRow(row, spent, projects))),
				total: total?.n ?? 0,
				pendingApproval: pending?.n ?? 0,
			};
		},
	}),

	defineOp({
		name: "admin.user_update",
		title: "Update user",
		description: "Approve or un-approve a user, change their role, set their monthly generation budget, or suspend them.",
		admin: true,
		input: z.object({
			userId: z.string(),
			approved: z.boolean().optional(),
			role: z.enum(["admin", "user"]).optional(),
			monthlyBudgetUsd: z.number().min(0).max(100000).optional(),
			banned: z.boolean().optional(),
			banReason: z.string().max(300).optional(),
		}),
		handler: async (input, { actor }) => {
			const user = await db.query.user.findFirst({ where: eq(schema.user.id, input.userId) });
			if (!user) throw notFound("User");
			const restricting = input.approved === false || input.banned === true || input.role === "user";
			if (restricting && user.id === actor.id) throw badRequest("You cannot remove your own access");
			if (restricting && superuserEmails.includes(user.email.toLowerCase())) {
				throw badRequest("This account is a configured superuser and cannot be restricted here");
			}
			const [updated] = await db
				.update(schema.user)
				.set({
					...(input.approved !== undefined ? { approved: input.approved } : {}),
					...(input.role ? { role: input.role } : {}),
					...(input.monthlyBudgetUsd !== undefined ? { monthlyBudgetCents: Math.round(input.monthlyBudgetUsd * 100) } : {}),
					...(input.banned !== undefined
						? { banned: input.banned, banReason: input.banned ? (input.banReason ?? "Suspended by an administrator") : null, banExpires: null }
						: {}),
				})
				.where(eq(schema.user.id, user.id))
				.returning();
			// Losing access takes effect at once: existing sign-ins are ended.
			if (input.banned === true || input.approved === false) {
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
		description: "Totals across the service: users, projects, videos, renders, and this month's spend by kind.",
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
				spendByKind: spend.map((row) => ({ kind: row.kind, usd: usd(row.total), events: row.events })),
			};
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
