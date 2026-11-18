/**
 * better-auth configuration, kept free of Cloudflare imports so the `auth`
 * CLI can load it in Node to generate the database schema.
 */
import { apiKey } from "@better-auth/api-key";
import { cimd } from "@better-auth/cimd";
import { mcp } from "@better-auth/mcp";
import type { BetterAuthOptions } from "better-auth";
import { admin, bearer, deviceAuthorization, jwt } from "better-auth/plugins";

export interface AuthSettings {
	/** Public origin, e.g. https://retween.app */
	appUrl: string;
	secret: string;
	googleClientId: string;
	googleClientSecret: string;
	/** Lower-cased emails that are made admins on first sign-in. */
	superuserEmails: string[];
	/** Spending cap given to newly created users, in cents per calendar month. */
	defaultMonthlyBudgetCents: number;
	database: BetterAuthOptions["database"];
	/** Runs before a person deletes their own account: refuse by throwing, and remove what the database does not cascade to. */
	beforeDeleteUser: (user: { id: string; email: string }) => Promise<void>;
	waitUntil?: (promise: Promise<unknown>) => void;
}

export const API_KEY_PREFIX = "rtw_";
export const CLI_CLIENT_ID = "retween-cli";

/**
 * Fetches a client-metadata document for an MCP client that identifies itself
 * by URL. Workers cannot reach private networks and cannot pin DNS answers, so
 * the protections available here are: HTTPS only, no credentials in the URL,
 * no IP-literal hosts, no redirects, and a short timeout.
 */
const fetchClientMetadataResource = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
	const url = new URL(input instanceof Request ? input.url : input.toString());
	const host = url.hostname;
	const isIpLiteral = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":") || host.startsWith("[");
	if (url.protocol !== "https:" || url.username || url.password || isIpLiteral || host === "localhost") {
		throw new Error("Client metadata must be served from a public HTTPS hostname");
	}
	return fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(5000) });
};

export function authOptions(settings: AuthSettings) {
	const superusers = new Set(settings.superuserEmails.map((email) => email.toLowerCase()));
	return {
		appName: "Retween",
		baseURL: settings.appUrl,
		secret: settings.secret,
		database: settings.database,
		trustedOrigins: [settings.appUrl],
		// The JWT plugin's own /token route is replaced by the OAuth token endpoint.
		disabledPaths: ["/token"],
		socialProviders: {
			google: {
				clientId: settings.googleClientId,
				clientSecret: settings.googleClientSecret,
				prompt: "select_account",
			},
		},
		user: {
			// People can close their own account from the web app. Sign-in is by Google only, so there is no password to re-enter:
			// the session has to be recent instead (better-auth's default "fresh" window).
			deleteUser: { enabled: true, beforeDelete: (user) => settings.beforeDeleteUser(user) },
			additionalFields: {
				monthlyBudgetCents: {
					type: "number",
					required: false,
					defaultValue: settings.defaultMonthlyBudgetCents,
					input: false,
				},
				/** The account's Stripe customer, created when it first sets up billing. */
				stripeCustomerId: { type: "string", required: false, input: false },
				/** See `BillingStatus`. Only accounts with a payment method on file (or administrators) can use the service. */
				billingStatus: { type: "string", required: false, defaultValue: "none", input: false },
			},
		},
		databaseHooks: {
			user: {
				create: {
					before: async (user) => {
						const isSuperuser = user.emailVerified === true && superusers.has(user.email.toLowerCase());
						return {
							data: {
								...user,
								role: isSuperuser ? "admin" : "user",
								billingStatus: "none",
								monthlyBudgetCents: settings.defaultMonthlyBudgetCents,
							},
						};
					},
				},
			},
		},
		advanced: {
			ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
			...(settings.waitUntil ? { backgroundTasks: { handler: settings.waitUntil } } : {}),
		},
		plugins: [
			admin(),
			bearer(),
			apiKey({
				defaultPrefix: API_KEY_PREFIX,
				enableMetadata: true,
				// The plugin's default is 10 requests a day; an agent session makes hundreds.
				rateLimit: { enabled: true, timeWindow: 60_000, maxRequests: 600 },
			}),
			deviceAuthorization({
				verificationUri: "/device",
				expiresIn: "15m",
				validateClient: (clientId) => clientId === CLI_CLIENT_ID,
			}),
			jwt({ disableSettingJwtHeader: true }),
			mcp({
				loginPage: "/sign-in",
				consentPage: "/consent",
				resource: `${settings.appUrl}/mcp`,
				// MCP clients that do not publish a client-metadata document register themselves.
				allowDynamicClientRegistration: true,
				allowUnauthenticatedClientRegistration: true,
				// Desktop and CLI clients register loopback redirect URIs; treat those as native apps.
				clientRegistrationDefaultApplicationType: "infer",
			}),
			cimd({ fetchClientMetadataResource, metadataProfile: "mcp-2026-07-28" }),
		],
	} satisfies BetterAuthOptions;
}
