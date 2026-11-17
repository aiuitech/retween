import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import { env, waitUntil } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import { AppError, forbidden } from "../lib/util.ts";
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
	}),
);

/** The authenticated caller of an operation. */
export interface Actor {
	id: string;
	email: string;
	name: string;
	image: string | null;
	isAdmin: boolean;
	approved: boolean;
	banned: boolean;
	monthlyBudgetCents: number;
	/** How the caller authenticated. */
	via: "session" | "api-key" | "oauth" | "upload-link";
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
		approved: isAdmin || user.approved === true,
		banned: user.banned === true && (!user.banExpires || user.banExpires > new Date()),
		monthlyBudgetCents: user.monthlyBudgetCents ?? 0,
		via,
	};
}

export async function actorById(userId: string, via: Actor["via"]): Promise<Actor | null> {
	const user = await db.query.user.findFirst({ where: eq(schema.user.id, userId) });
	return user ? toActor(user, via) : null;
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
	if (!actor.approved) {
		throw forbidden("Your account is waiting for approval by an administrator", "pending_approval");
	}
}
