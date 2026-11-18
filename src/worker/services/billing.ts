/**
 * Billing through Stripe.
 *
 * New accounts add a payment method before they can use the service (a Stripe
 * Checkout session in setup mode: nothing is charged then). From then on every
 * vendor charge lands in the usage ledger (services/usage.ts) as it happens, and
 * at the end of each calendar month the ledger becomes one Stripe invoice per
 * account: cost × markup, less any credit a superuser gave the account. Stripe
 * collects it from the saved payment method, and retries and dunning are its own.
 *
 * Webhooks (`handleStripeEvent`) keep the account's billing status and our
 * invoice rows in step with Stripe. Accounts are found from Stripe objects by
 * their customer id, never by metadata.
 */
import { env } from "cloudflare:workers";
import { and, desc, eq, gte, inArray, lt, ne, sql } from "drizzle-orm";
import Stripe from "stripe";
import type { Actor } from "../auth/index.ts";
import { db, schema } from "../db/client.ts";
import type { BillingStatus, InvoiceStatus, UsageKind } from "../db/schema.ts";
import { AppError, badRequest, newId } from "../lib/util.ts";

let client: Stripe | undefined;

export function stripe(): Stripe {
	if (!env.STRIPE_SECRET_KEY) throw new AppError(503, "Billing is not configured yet (STRIPE_SECRET_KEY is missing)", "billing_unavailable");
	client ??= new Stripe(env.STRIPE_SECRET_KEY, { httpClient: Stripe.createFetchHttpClient(), maxNetworkRetries: 2 });
	return client;
}

/** What people pay per dollar of vendor cost, e.g. 1.3. Set by BILLING_MARKUP. */
export function markup(): number {
	const value = Number(env.BILLING_MARKUP);
	return Number.isFinite(value) && value > 0 ? value : 1;
}

/** The amount billed for a vendor cost, both in millionths of a dollar. */
export const chargeFor = (costMicros: number) => costMicros * markup();

/** Tags Checkout sessions from this flow in the Stripe Dashboard. */
const INTEGRATION_ID = "retween_card_setup_qhvmzrkt";

export const KIND_LABELS: Record<UsageKind, string> = {
	image: "Generated images",
	video: "Generated video clips",
	speech: "Narration",
	music: "Generated music",
	sfx: "Sound effects",
	transcription: "Transcription",
	render: "Rendering",
	preview: "Previews and checks",
	footage: "Footage processing",
	storage: "Storage",
};

// ------------------------------------------------------------------ periods

/** "2026-11" for a moment in November 2026 (UTC). */
export const periodOf = (date: Date) => date.toISOString().slice(0, 7);

export function periodRange(period: string): { from: Date; to: Date } {
	if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw badRequest("A month is written YYYY-MM, e.g. 2026-11");
	const [year, month] = period.split("-").map(Number) as [number, number];
	return { from: new Date(Date.UTC(year, month - 1, 1)), to: new Date(Date.UTC(year, month, 1)) };
}

export function previousPeriod(now = new Date()): string {
	return periodOf(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)));
}

/**
 * A month is invoiced on the 2nd: by then the nightly reconciliation has replaced
 * the last day's metered costs with what the vendors billed.
 */
export function invoiceDateFor(period: string): string {
	const { to } = periodRange(period);
	return new Date(to.getTime() + 86_400_000).toISOString().slice(0, 10);
}

// ------------------------------------------------------------------ credit

/**
 * Credit the account has not spent yet, in millionths of a dollar: everything
 * granted, less what invoices have used (a voided invoice gives its credit back).
 */
export async function creditBalanceMicros(userId: string, excludeInvoiceId?: string): Promise<number> {
	const [[granted], [spent]] = await Promise.all([
		db
			.select({ total: sql<number>`coalesce(sum(${schema.billingCredits.amountMicros}), 0)` })
			.from(schema.billingCredits)
			.where(eq(schema.billingCredits.userId, userId)),
		db
			.select({ total: sql<number>`coalesce(sum(${schema.invoices.creditCents}), 0)` })
			.from(schema.invoices)
			.where(
				and(
					eq(schema.invoices.userId, userId),
					ne(schema.invoices.status, "void"),
					excludeInvoiceId ? ne(schema.invoices.id, excludeInvoiceId) : undefined,
				),
			),
	]);
	return Math.max(0, (granted?.total ?? 0) - (spent?.total ?? 0) * 10_000);
}

export async function grantCredit(input: { userId: string; amountUsd: number; note?: string; grantedBy: string }) {
	const amountMicros = Math.round(input.amountUsd * 1_000_000);
	if (amountMicros === 0) throw badRequest("The amount cannot be zero");
	if (amountMicros < 0 && -amountMicros > (await creditBalanceMicros(input.userId))) {
		throw badRequest("That takes back more credit than the account has left");
	}
	await db.insert(schema.billingCredits).values({
		id: newId("crd"),
		userId: input.userId,
		amountMicros,
		note: input.note,
		grantedBy: input.grantedBy,
	});
	return { creditBalanceUsd: cents(await creditBalanceMicros(input.userId)) };
}

const cents = (micros: number) => Math.round(micros / 10_000) / 100;

// --------------------------------------------------------- payment methods

type UserRow = typeof schema.user.$inferSelect;

const userById = (userId: string) => db.query.user.findFirst({ where: eq(schema.user.id, userId) });
const userByCustomer = (customer: string | { id: string } | null | undefined) => {
	const id = typeof customer === "string" ? customer : customer?.id;
	return id ? db.query.user.findFirst({ where: eq(schema.user.stripeCustomerId, id) }) : Promise.resolve(undefined);
};

async function ensureCustomer(user: UserRow): Promise<string> {
	if (user.stripeCustomerId) return user.stripeCustomerId;
	const customer = await stripe().customers.create(
		{ email: user.email, name: user.name || undefined, metadata: { userId: user.id } },
		{ idempotencyKey: `retween-customer-${user.id}` },
	);
	await db.update(schema.user).set({ stripeCustomerId: customer.id }).where(eq(schema.user.id, user.id));
	return customer.id;
}

/** A Stripe Checkout page where the person saves a payment method for monthly billing. */
export async function setupCheckoutUrl(actor: Actor): Promise<string> {
	const user = await userById(actor.id);
	if (!user) throw new AppError(404, "Account not found", "not_found");
	const session = await stripe().checkout.sessions.create({
		mode: "setup",
		currency: "usd",
		customer: await ensureCustomer(user),
		client_reference_id: user.id,
		integration_identifier: INTEGRATION_ID,
		success_url: `${env.APP_URL}/api/billing/return?session_id={CHECKOUT_SESSION_ID}`,
		cancel_url: `${env.APP_URL}/billing`,
	});
	if (!session.url) throw new AppError(502, "Stripe did not return a checkout page", "upstream_error");
	return session.url;
}

/** Stripe's customer portal: change the payment method, see and pay invoices. */
export async function portalUrl(actor: Actor): Promise<string> {
	const user = await userById(actor.id);
	if (!user?.stripeCustomerId) throw new AppError(409, "This account has no billing set up yet", "billing_required");
	const session = await stripe().billingPortal.sessions.create({ customer: user.stripeCustomerId, return_url: `${env.APP_URL}/account/spending` });
	return session.url;
}

/**
 * A payment method was saved: make it the one invoices are charged to, try
 * again any invoice that failed, and let the account in.
 */
async function useSetupIntent(intent: Stripe.SetupIntent): Promise<UserRow | undefined> {
	if (intent.status !== "succeeded" || !intent.payment_method) return undefined;
	const user = await userByCustomer(intent.customer);
	if (!user?.stripeCustomerId) return undefined;
	const paymentMethod = typeof intent.payment_method === "string" ? intent.payment_method : intent.payment_method.id;
	await stripe().customers.update(user.stripeCustomerId, { invoice_settings: { default_payment_method: paymentMethod } });
	const unpaid = await db.query.invoices.findMany({
		where: and(eq(schema.invoices.userId, user.id), inArray(schema.invoices.status, ["failed", "open"])),
	});
	for (const invoice of unpaid) {
		if (!invoice.stripeInvoiceId) continue;
		await stripe()
			.invoices.pay(invoice.stripeInvoiceId, { payment_method: paymentMethod })
			.then((paid) => syncInvoice(paid))
			.catch((error: Error) => console.warn("retrying invoice failed", invoice.stripeInvoiceId, error.message));
	}
	await settleStatus(user.id, { hasPaymentMethod: true });
	return user;
}

/** After the person returns from Checkout: activate at once rather than wait for the webhook. */
export async function completeCheckout(sessionId: string, actor: Actor): Promise<boolean> {
	const session = await stripe().checkout.sessions.retrieve(sessionId, { expand: ["setup_intent"] });
	const user = await userByCustomer(session.customer as string | null);
	if (!user || user.id !== actor.id || session.mode !== "setup" || session.status !== "complete") return false;
	const intent = session.setup_intent;
	if (!intent || typeof intent === "string") return false;
	return Boolean(await useSetupIntent(intent));
}

/**
 * The account's billing status from its invoices: past due while any invoice
 * failed or was written off, otherwise active once a payment method is on file.
 */
async function settleStatus(userId: string, { hasPaymentMethod }: { hasPaymentMethod?: boolean } = {}) {
	const user = await userById(userId);
	if (!user) return;
	const [unpaid] = await db
		.select({ n: sql<number>`count(*)` })
		.from(schema.invoices)
		.where(and(eq(schema.invoices.userId, userId), inArray(schema.invoices.status, ["failed", "uncollectible"])));
	const ready = hasPaymentMethod || user.billingStatus === "active" || user.billingStatus === "past_due";
	const status: BillingStatus = !ready ? "none" : (unpaid?.n ?? 0) > 0 ? "past_due" : "active";
	if (status !== user.billingStatus) await db.update(schema.user).set({ billingStatus: status }).where(eq(schema.user.id, userId));
}

// ---------------------------------------------------------------- invoices

const STRIPE_STATUS: Record<string, InvoiceStatus> = { draft: "draft", open: "open", paid: "paid", void: "void", uncollectible: "uncollectible" };

/** Later states win; webhooks can arrive out of order. */
const RANK: Partial<Record<InvoiceStatus, number>> = { draft: 0, open: 1, failed: 2, paid: 3, void: 3, uncollectible: 3 };

/** Copies a Stripe invoice's state onto our row. */
async function syncInvoice(invoice: Stripe.Invoice, failed = false) {
	const row = await db.query.invoices.findFirst({ where: eq(schema.invoices.stripeInvoiceId, invoice.id) });
	if (!row) return;
	const incoming: InvoiceStatus = failed && invoice.status === "open" ? "failed" : (STRIPE_STATUS[invoice.status ?? ""] ?? row.status);
	const status = (RANK[incoming] ?? 0) >= (RANK[row.status] ?? 0) ? incoming : row.status;
	await db
		.update(schema.invoices)
		.set({
			status,
			hostedUrl: invoice.hosted_invoice_url ?? row.hostedUrl,
			error: status === "failed" ? "The payment was declined. Stripe retries it; a new payment method is charged at once." : null,
		})
		.where(eq(schema.invoices.id, row.id));
	await settleStatus(row.userId);
}

interface Line {
	kind: UsageKind;
	quantity: number;
	unit: string;
	costMicros: number;
	cents: number;
}

/** One account's usage for a period, as invoice lines with markup applied. */
export async function usageLines(userId: string | undefined, from: Date, to: Date) {
	const usage = schema.usageEvents;
	const rows = await db
		.select({
			userId: usage.userId,
			kind: usage.kind,
			unit: sql<string>`min(${usage.unit})`,
			units: sql<number>`count(distinct ${usage.unit})`,
			quantity: sql<number>`sum(${usage.quantity})`,
			costMicros: sql<number>`sum(${usage.costMicros})`,
		})
		.from(usage)
		.where(and(gte(usage.createdAt, from), lt(usage.createdAt, to), userId ? eq(usage.userId, userId) : undefined))
		.groupBy(usage.userId, usage.kind);
	const byUser = new Map<string, Line[]>();
	for (const row of rows) {
		const lines = byUser.get(row.userId) ?? [];
		byUser.set(row.userId, lines);
		lines.push({
			kind: row.kind,
			quantity: row.units === 1 ? row.quantity : 0,
			unit: row.units === 1 ? row.unit : "",
			costMicros: row.costMicros,
			cents: Math.round(chargeFor(row.costMicros) / 10_000),
		});
	}
	return byUser;
}

const lineDescription = (line: Line) =>
	line.unit && line.quantity ? `${KIND_LABELS[line.kind]} (${line.quantity.toLocaleString("en-US")} ${line.unit})` : KIND_LABELS[line.kind];

export interface InvoiceResult {
	userId: string;
	email: string;
	period: string;
	status: InvoiceStatus | "error";
	chargeUsd: number;
	creditUsd: number;
	amountDueUsd: number;
	stripeInvoiceId?: string;
	url?: string;
	error?: string;
	/** Already invoiced by an earlier run: left as it was. */
	unchanged?: boolean;
}

/**
 * Bills one closed month: an invoice per account with charges, except
 * administrators. Safe to run again: accounts already invoiced are left alone,
 * and one that stopped part way through is finished.
 */
export async function invoicePeriod(period: string, options: { dryRun?: boolean; userId?: string } = {}): Promise<InvoiceResult[]> {
	const { from, to } = periodRange(period);
	if (to > new Date()) throw badRequest(`${period} has not ended yet. Use billing.spend to see the month so far.`);
	const byUser = await usageLines(options.userId, from, to);
	const results: InvoiceResult[] = [];
	for (const [userId, lines] of byUser) {
		const user = await userById(userId);
		if (!user || (user.role ?? "").split(",").includes("admin")) continue;
		try {
			results.push(await invoiceAccount(user, period, lines, options.dryRun ?? false));
		} catch (error) {
			console.error("invoicing failed", userId, period, error);
			results.push({
				userId,
				email: user.email,
				period,
				status: "error",
				chargeUsd: 0,
				creditUsd: 0,
				amountDueUsd: 0,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return results;
}

async function invoiceAccount(user: UserRow, period: string, lines: Line[], dryRun: boolean): Promise<InvoiceResult> {
	const existing = await db.query.invoices.findFirst({ where: and(eq(schema.invoices.userId, user.id), eq(schema.invoices.period, period)) });
	const view = (row: typeof schema.invoices.$inferSelect, unchanged = false): InvoiceResult => ({
		userId: user.id,
		email: user.email,
		period,
		status: row.status,
		chargeUsd: row.chargeCents / 100,
		creditUsd: row.creditCents / 100,
		amountDueUsd: row.amountDueCents / 100,
		stripeInvoiceId: row.stripeInvoiceId ?? undefined,
		url: row.hostedUrl ?? undefined,
		error: row.error ?? undefined,
		...(unchanged ? { unchanged } : {}),
	});
	if (existing && existing.status !== "draft") return view(existing, true);

	const billable = lines.filter((line) => line.cents > 0);
	const chargeCents = billable.reduce((sum, line) => sum + line.cents, 0);
	const costMicros = lines.reduce((sum, line) => sum + line.costMicros, 0);
	const canCharge = Boolean(user.stripeCustomerId);
	const creditCents = canCharge ? Math.min(chargeCents, Math.floor((await creditBalanceMicros(user.id, existing?.id)) / 10_000)) : 0;
	const amountDueCents = chargeCents - creditCents;
	const status: InvoiceStatus = chargeCents === 0 ? "no_charge" : !canCharge ? "skipped" : amountDueCents === 0 ? "credited" : "draft";
	const values = { costMicros, markup: markup(), chargeCents, creditCents, amountDueCents, status, error: status === "skipped" ? "No payment method on file" : null };
	if (dryRun) return view({ ...(existing ?? ({} as typeof schema.invoices.$inferSelect)), ...values, stripeInvoiceId: null, hostedUrl: null });

	let row = existing;
	if (row) {
		[row] = await db.update(schema.invoices).set(values).where(eq(schema.invoices.id, row.id)).returning();
	} else {
		// The unique (user, period) index makes a concurrent run back off.
		[row] = await db.insert(schema.invoices).values({ id: newId("inv"), userId: user.id, period, ...values }).onConflictDoNothing().returning();
		if (!row) {
			const taken = await db.query.invoices.findFirst({ where: and(eq(schema.invoices.userId, user.id), eq(schema.invoices.period, period)) });
			return view(taken!, true);
		}
	}
	if (row!.status !== "draft") return view(row!);

	const { from, to } = periodRange(period);
	const month = from.toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
	const api = stripe();
	const key = `retween-${user.id}-${period}`;
	try {
		const create = async (attempt: string) => {
			const created = await api.invoices.create(
				{
					customer: user.stripeCustomerId!,
					currency: "usd",
					collection_method: "charge_automatically",
					auto_advance: true,
					pending_invoice_items_behavior: "exclude",
					description: `Retween usage for ${month}`,
					metadata: { period },
				},
				{ idempotencyKey: `${key}-invoice-${attempt}` },
			);
			await db.update(schema.invoices).set({ stripeInvoiceId: created.id }).where(eq(schema.invoices.id, row!.id));
			return created;
		};
		let invoice = row!.stripeInvoiceId ? await api.invoices.retrieve(row!.stripeInvoiceId) : await create("first");
		if (invoice.status === "draft" && (invoice.lines?.data.length ?? 0) > 0) {
			// A run stopped after adding some lines: start a clean draft rather than risk adding them twice.
			await api.invoices.del(invoice.id);
			invoice = await create(String(Date.now()));
		}
		if (invoice.status === "draft") {
			const period_ = { start: Math.floor(from.getTime() / 1000), end: Math.floor(to.getTime() / 1000) - 1 };
			for (const line of billable) {
				await api.invoiceItems.create(
					{ customer: user.stripeCustomerId!, invoice: invoice.id, currency: "usd", amount: line.cents, description: lineDescription(line), period: period_ },
					{ idempotencyKey: `${key}-${invoice.id}-${line.kind}-${line.cents}` },
				);
			}
			if (creditCents > 0) {
				await api.invoiceItems.create(
					{ customer: user.stripeCustomerId!, invoice: invoice.id, currency: "usd", amount: -creditCents, description: "Credit applied", period: period_ },
					{ idempotencyKey: `${key}-${invoice.id}-credit-${creditCents}` },
				);
			}
			invoice = await api.invoices.finalizeInvoice(invoice.id, { auto_advance: true });
		}
		const [done] = await db
			.update(schema.invoices)
			.set({ status: STRIPE_STATUS[invoice.status ?? ""] ?? "open", hostedUrl: invoice.hosted_invoice_url ?? null, error: null })
			.where(eq(schema.invoices.id, row!.id))
			.returning();
		return view(done!);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const [failed] = await db.update(schema.invoices).set({ error: message }).where(eq(schema.invoices.id, row!.id)).returning();
		return { ...view(failed!), status: "error" };
	}
}

/** The nightly job: on and after the 2nd, bill the month that just closed. */
export async function invoiceClosedMonth(now = new Date()) {
	if (now.getUTCDate() < 2) return { skipped: "Months are invoiced from the 2nd" };
	const period = previousPeriod(now);
	const results = await invoicePeriod(period);
	return {
		period,
		invoiced: results.filter((result) => !result.unchanged && result.status !== "error").length,
		errors: results.filter((result) => result.status === "error").map((result) => `${result.email}: ${result.error}`),
	};
}

export async function recentInvoices(userId: string, limit = 12) {
	const rows = await db.query.invoices.findMany({ where: eq(schema.invoices.userId, userId), orderBy: desc(schema.invoices.period), limit });
	return rows.map((row) => ({
		period: row.period,
		status: row.status,
		chargeUsd: row.chargeCents / 100,
		creditUsd: row.creditCents / 100,
		amountDueUsd: row.amountDueCents / 100,
		url: row.hostedUrl ?? undefined,
	}));
}

// ---------------------------------------------------------------- webhooks

/** Verifies a webhook delivery's signature and returns the event, or null if it is not from Stripe. */
export async function verifyWebhook(body: string, signature: string | null): Promise<Stripe.Event | null> {
	if (!signature || !env.STRIPE_WEBHOOK_SECRET) return null;
	try {
		return await stripe().webhooks.constructEventAsync(body, signature, env.STRIPE_WEBHOOK_SECRET, undefined, Stripe.createSubtleCryptoProvider());
	} catch {
		return null;
	}
}

/** Handles one webhook event. Every branch is safe to run twice: Stripe redelivers. */
export async function handleStripeEvent(event: Stripe.Event): Promise<void> {
	switch (event.type) {
		case "checkout.session.completed": {
			const session = event.data.object;
			if (session.mode !== "setup" || !session.setup_intent) return;
			const intentId = typeof session.setup_intent === "string" ? session.setup_intent : session.setup_intent.id;
			await useSetupIntent(await stripe().setupIntents.retrieve(intentId));
			return;
		}
		// Payment methods that are confirmed later than the Checkout page closes.
		case "setup_intent.succeeded":
			await useSetupIntent(event.data.object);
			return;
		case "invoice.finalized":
		case "invoice.paid":
		case "invoice.voided":
		case "invoice.marked_uncollectible":
			await syncInvoice(event.data.object);
			return;
		case "invoice.payment_failed":
			await syncInvoice(event.data.object, true);
			return;
		case "charge.dispute.created": {
			// A disputed charge stops paid work until someone has looked at it.
			const dispute = event.data.object;
			const charge = typeof dispute.charge === "string" ? await stripe().charges.retrieve(dispute.charge) : dispute.charge;
			const user = await userByCustomer(charge.customer as string | null);
			console.error("stripe dispute opened", dispute.id, user?.email ?? charge.customer);
			if (user) await db.update(schema.user).set({ billingStatus: "past_due" }).where(eq(schema.user.id, user.id));
			return;
		}
		case "customer.deleted": {
			const user = await userByCustomer(event.data.object.id);
			if (user) await db.update(schema.user).set({ stripeCustomerId: null, billingStatus: "none" }).where(eq(schema.user.id, user.id));
			return;
		}
	}
}

/** The events the webhook endpoint should be subscribed to in Stripe. */
export const WEBHOOK_EVENTS = [
	"checkout.session.completed",
	"setup_intent.succeeded",
	"invoice.finalized",
	"invoice.paid",
	"invoice.payment_failed",
	"invoice.voided",
	"invoice.marked_uncollectible",
	"charge.dispute.created",
	"customer.deleted",
] as const;
