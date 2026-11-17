/**
 * Nightly reconciliation: replaces costs we worked out ourselves with what the
 * vendor actually billed, once the vendor has the figure. Rows that are
 * reconciled get `basis: "vendor"`; rows the vendor has no figure for yet are
 * tried again the next night, for a week.
 *
 * Both jobs are optional and need their own credentials (Worker secrets):
 * - fal: FAL_BILLING_KEY, a fal key with the BILLING (or FULL) preset.
 * - Containers: CLOUDFLARE_ANALYTICS_TOKEN, an API token with Account Analytics: Read.
 */
import { env } from "cloudflare:workers";
import { and, eq, gte, inArray, isNotNull, lte, ne } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import { containerUsdFromUsage } from "./pricing.ts";

const WINDOW_DAYS = 7;
const secret = (name: string) => (env as unknown as Record<string, string | undefined>)[name] || undefined;
const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000);
const chunks = <T>(items: T[], size: number) => Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, i * size + size));

export interface ReconcileResult {
	skipped?: string;
	checked: number;
	updated: number;
	costBeforeUsd: number;
	costAfterUsd: number;
}

// ------------------------------------------------------------------- fal

interface FalBillingEvent {
	request_id: string;
	quantity: number | null;
	unit: string | null;
	cost_estimate_nano_usd: number;
}

/** fal's billed cost for each request id (summed over its billing events). */
async function falBilled(key: string, requestIds: string[], start: Date): Promise<Map<string, { nanoUsd: number; quantity: number; unit?: string }>> {
	const billed = new Map<string, { nanoUsd: number; quantity: number; unit?: string }>();
	let cursor: string | null = null;
	do {
		const params = new URLSearchParams({ request_id: requestIds.join(","), start: start.toISOString(), limit: "1000" });
		if (cursor) params.set("cursor", cursor);
		const response = await fetch(`https://api.fal.ai/v1/models/billing-events?${params}`, { headers: { authorization: `Key ${key}` } });
		if (!response.ok) throw new Error(`fal billing events ${response.status}: ${(await response.text()).slice(0, 300)}`);
		const page = (await response.json()) as { billing_events: FalBillingEvent[]; next_cursor: string | null; has_more: boolean };
		for (const event of page.billing_events) {
			const entry = billed.get(event.request_id) ?? { nanoUsd: 0, quantity: 0, unit: undefined };
			entry.nanoUsd += event.cost_estimate_nano_usd;
			entry.quantity += event.quantity ?? 0;
			entry.unit ??= event.unit ?? undefined;
			billed.set(event.request_id, entry);
		}
		cursor = page.has_more ? page.next_cursor : null;
	} while (cursor);
	return billed;
}

export async function reconcileFal(): Promise<ReconcileResult> {
	const key = secret("FAL_BILLING_KEY");
	const result: ReconcileResult = { checked: 0, updated: 0, costBeforeUsd: 0, costAfterUsd: 0 };
	if (!key) return { ...result, skipped: "FAL_BILLING_KEY is not set" };
	const usage = schema.usageEvents;
	const rows = await db
		.select({ id: usage.id, vendorRef: usage.vendorRef, costMicros: usage.costMicros, createdAt: usage.createdAt })
		.from(usage)
		.where(and(eq(usage.provider, "fal"), ne(usage.basis, "vendor"), isNotNull(usage.vendorRef), gte(usage.createdAt, daysAgo(WINDOW_DAYS))));
	for (const batch of chunks(rows, 50)) {
		const start = new Date(Math.min(...batch.map((row) => row.createdAt.getTime())) - 3_600_000);
		const billed = await falBilled(key, batch.map((row) => row.vendorRef!), start);
		result.checked += batch.length;
		for (const row of batch) {
			const charge = billed.get(row.vendorRef!);
			if (!charge) continue;
			const costMicros = Math.round(charge.nanoUsd / 1000);
			await db
				.update(usage)
				.set({ costMicros, basis: "vendor", estimated: false, quantity: Math.round(charge.quantity) || undefined, ...(charge.unit ? { unit: charge.unit } : {}) })
				.where(eq(usage.id, row.id));
			result.updated++;
			result.costBeforeUsd += row.costMicros / 1e6;
			result.costAfterUsd += costMicros / 1e6;
		}
	}
	return result;
}

// ------------------------------------------------------------ containers

interface ContainerUsage {
	sum: { cpuTimeSec: number; allocatedMemory: number; allocatedDisk: number };
}

/**
 * Container runs are labelled with their instance name (see Renderer), and a
 * run's ledger row was written when it stopped, with its length as the
 * quantity, so the run's usage is the instance's usage over that window.
 */
export async function reconcileContainers(): Promise<ReconcileResult> {
	const token = secret("CLOUDFLARE_ANALYTICS_TOKEN");
	const accountId = secret("CLOUDFLARE_ACCOUNT_ID");
	const result: ReconcileResult = { checked: 0, updated: 0, costBeforeUsd: 0, costAfterUsd: 0 };
	if (!token || !accountId) return { ...result, skipped: "CLOUDFLARE_ANALYTICS_TOKEN or CLOUDFLARE_ACCOUNT_ID is not set" };
	const usage = schema.usageEvents;
	const rows = await db
		.select({ id: usage.id, ref: usage.ref, quantity: usage.quantity, costMicros: usage.costMicros, createdAt: usage.createdAt })
		.from(usage)
		.where(
			and(
				eq(usage.provider, "cloudflare"),
				inArray(usage.kind, ["render", "preview"]),
				eq(usage.basis, "metered"),
				isNotNull(usage.ref),
				gte(usage.createdAt, daysAgo(WINDOW_DAYS)),
				// Give the analytics pipeline time to catch up.
				lte(usage.createdAt, new Date(Date.now() - 2 * 3_600_000)),
			),
		)
		// Stays well inside the GraphQL API's 300 queries per 5 minutes.
		.limit(1000);

	for (const batch of chunks(rows, 20)) {
		// One query per batch: an aliased field per run.
		const fields = batch.map((row, i) => {
			const stop = row.createdAt.getTime();
			const start = stop - row.quantity * 1000;
			return `r${i}: containersUsageAdaptiveGroups(limit: 1000, filter: { datetime_geq: "${new Date(start - 60_000).toISOString()}", datetime_leq: "${new Date(stop + 60_000).toISOString()}", labels_has: ${JSON.stringify(`instance=${row.ref}`)} }) { sum { cpuTimeSec allocatedMemory allocatedDisk } }`;
		});
		const query = `query($accountTag: String) { viewer { accounts(filter: { accountTag: $accountTag }) { ${fields.join("\n")} } } }`;
		const response = await fetch("https://api.cloudflare.com/client/v4/graphql", {
			method: "POST",
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
			body: JSON.stringify({ query, variables: { accountTag: accountId } }),
		});
		if (!response.ok) throw new Error(`Cloudflare analytics ${response.status}: ${(await response.text()).slice(0, 300)}`);
		const json = (await response.json()) as { data?: { viewer: { accounts: Record<string, ContainerUsage[]>[] } }; errors?: { message: string }[] | null };
		if (json.errors?.length) throw new Error(`Cloudflare analytics: ${json.errors.map((error) => error.message).join("; ").slice(0, 300)}`);
		const account = json.data?.viewer.accounts[0] ?? {};
		result.checked += batch.length;
		for (const [i, row] of batch.entries()) {
			const groups = account[`r${i}`] ?? [];
			if (!groups.length) continue;
			const total = groups.reduce(
				(sum, group) => ({
					cpuTimeSec: sum.cpuTimeSec + group.sum.cpuTimeSec,
					allocatedMemory: sum.allocatedMemory + group.sum.allocatedMemory,
					allocatedDisk: sum.allocatedDisk + group.sum.allocatedDisk,
				}),
				{ cpuTimeSec: 0, allocatedMemory: 0, allocatedDisk: 0 },
			);
			const costMicros = Math.round(containerUsdFromUsage(total) * 1e6);
			await db.update(usage).set({ costMicros, basis: "vendor", estimated: false }).where(eq(usage.id, row.id));
			result.updated++;
			result.costBeforeUsd += row.costMicros / 1e6;
			result.costAfterUsd += costMicros / 1e6;
		}
	}
	return result;
}
