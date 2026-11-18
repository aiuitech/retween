/**
 * Loaded only by the `auth` CLI to generate `src/worker/db/auth-schema.ts`:
 *   pnpm exec auth generate --config auth.gen.ts --output src/worker/db/auth-schema.ts
 * The database is a stub; generation only reads the option set.
 */
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import { authOptions } from "./src/worker/auth/options.ts";

export const auth = betterAuth(
	authOptions({
		appUrl: "https://retween.app",
		secret: "schema-generation-only-not-a-real-secret-0000",
		googleClientId: "x",
		googleClientSecret: "x",
		superuserEmails: [],
		defaultMonthlyBudgetCents: 0,
		database: drizzleAdapter({} as never, { provider: "sqlite" }),
	}),
);
