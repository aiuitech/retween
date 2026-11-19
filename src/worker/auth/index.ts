import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { env, waitUntil } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import { AppError, forbidden } from "../lib/util.ts";
import { acceptInvitesFor } from "../services/sharing.ts";
import { deletePrefix } from "../services/storage.ts";
import { API_KEY_PREFIX, authOptions } from "./options.ts";

export const superuserEmails = env.SUPERUSER_EMAILS.split(",")
	.map((email) => email.trim().toLowerCase())
	.filter(Boolean);

export const auth = betterAuth(
	authOptions({
		appUrl: env.APP_URL,
		secret: env.BETTER_AUTH_SECRET,
		googleClientId: env.GOOGLE_CLIENT_ID,
		googleClientSecret: env.GOOGLE_CLIENT_SECRET,
		superuserEmails,
		defaultMonthlyBudgetCents: Number(env.DEFAULT_MONTHLY_BUDGET_CENTS) || 0,
		database: drizzleAdapter(db, { provider: "sqlite", schema }),
		waitUntil,
		beforeDeleteUser: async (user) => {
			if (superuserEmails.includes(user.email.toLowerCase())) {
				throw new APIError("BAD_REQUEST", { message: "This account is a configured superuser and cannot be deleted." });
			}
			// The same clean-up as admin.user_delete: stored files and API keys are not reached by the database's cascades.
			const projects = await db.query.projects.findMany({ where: eq(schema.projects.ownerId, user.id) });
			for (const project of projects) await deletePrefix(`projects/${project.id}/`);
			await db.delete(schema.apikey).where(eq(schema.apikey.referenceId, user.id));
		},
		afterCreateUser: async (user) => {
			try {
				await acceptInvitesFor(user);
			} catch (error) {
				console.error("could not accept invitations for a new account", error);
			}
		},
	}),
);

/** The authenticated caller of an operation. */
export interface Actor {
	id: string;
	email: string;
	name: string;
	image: string | null;
	isAdmin: boolean;
	/** Listed in SUPERUSER_EMAILS: can grant credit and run invoicing. */
	isSuperuser: boolean;
	/**
	 * exempt: an administrator, never billed. active: a payment method is on file.
	 * required: no payment method yet, so the account cannot be used.
	 * guest: no payment method yet, but projects are shared with the account: it can
	 * work in them, but cannot create projects or start paid work until it adds one.
	 * past_due: an invoice went unpaid; paid work is refused until it is settled.
	 */
	billing: "exempt" | "active" | "required" | "guest" | "past_due";
	banned: boolean;
	monthlyBudgetCents: number;
	/** How the caller authenticated. */
	via: "session" | "api-key" | "oauth" | "upload-link";
	/**
	 * Set while an operation runs: "view" for operations that only read, so a
	 * project's viewers may run them (see getProject). Absent means "edit".
	 */
	access?: "view" | "edit";
}

type UserRow = typeof schema.user.$inferSelect;

function toActor(user: UserRow, via: Actor["via"]): Actor {
	const isAdmin = (user.role ?? "").split(",").includes("admin");
	return {
		id: user.id,
		email: user.email,
		name: user.name,
		image: user.image ?? null,
		isAdmin,
		isSuperuser: superuserEmails.includes(user.email.toLowerCase()),
		billing: isAdmin ? "exempt" : user.billingStatus === "active" ? "active" : user.billingStatus === "past_due" ? "past_due" : "required",
		banned: user.banned === true && (!user.banExpires || user.banExpires > new Date()),
		monthlyBudgetCents: user.monthlyBudgetCents ?? 0,
		via,
	};
}

export async function actorById(userId: string, via: Actor["via"]): Promise<Actor | null> {
	const user = await db.query.user.findFirst({ where: eq(schema.user.id, userId) });
	if (!user) return null;
	const actor = toActor(user, via);
	if (actor.billing === "required") {
		// An account without a payment method can still work in projects shared with it.
		const shared = await db.query.projectMembers.findFirst({ where: eq(schema.projectMembers.userId, user.id), columns: { projectId: true } });
		if (shared) actor.billing = "guest";
	}
	return actor;
}

/** Refuses what an account without a payment method cannot do, even in projects shared with it. */
export function assertNotGuest(actor: Actor, what = "do that"): void {
	if (actor.billing !== "guest") return;
	throw new AppError(
		402,
		`Add a payment method at ${env.APP_URL}/billing to ${what}. Working in projects shared with you is free; paid work is billed to whoever starts it.`,
		"billing_required",
	);
}

/** Resolves a browser session cookie, a CLI session token, or an API key. */
export async function actorFromRequest(request: Request): Promise<Actor | null> {
	const bearer = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
	const apiKeyValue = bearer?.startsWith(API_KEY_PREFIX) ? bearer : request.headers.get("x-api-key");
	if (apiKeyValue) {
		const result = await auth.api.verifyApiKey({ body: { key: apiKeyValue } });
		if (/rate/i.test(String(result.error?.code ?? ""))) {
			throw new AppError(429, "This API key is being used too quickly. Wait a moment and try again.", "rate_limited");
		}
		if (!result.valid || !result.key) return null;
		return actorById(result.key.referenceId, "api-key");
	}
	const session = await auth.api.getSession({ headers: request.headers });
	if (!session) return null;
	return actorById(session.user.id, "session");
}

/** Throws unless the actor may use the service. */
export function assertActive(actor: Actor | null): asserts actor is Actor {
	if (!actor) throw new AppError(401, "Sign in to continue", "unauthenticated");
	if (actor.banned) throw forbidden("This account has been suspended", "suspended");
	if (actor.billing === "required") {
		throw new AppError(
			402,
			`Add a payment method at ${env.APP_URL}/billing to start using Retween. Nothing is charged up front: usage is billed at the end of each month.`,
			"billing_required",
		);
	}
}
