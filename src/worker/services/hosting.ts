/**
 * Hosting: a finished render copied to Cloudflare Stream and played from
 * Retween's own watch page and embed.
 *
 * Money. Stream charges us for minutes stored and minutes delivered, and both
 * are passed on through the usage ledger, so they are invoiced at cost × markup
 * like everything else:
 * - storage: each night, one day of every hosted copy's length, per account (`hosting`);
 * - plays: each night, the minutes Stream delivered per copy on the two days before,
 *   read from Cloudflare's analytics and recorded against the day they happened (`streaming`).
 *   The second day is measured again because analytics trail by a few minutes; the
 *   ledger row is replaced, never added to. Copies carry their owner as Stream's
 *   `creator`, so plays are billed to the owner even after a copy is deleted.
 *
 * Copies require signed URLs, so nothing plays without a token from our pages,
 * and those stop handing them out when the owner's account cannot be billed
 * (usage.ts `playbackBlocked`).
 */
import { env } from "cloudflare:workers";
import { and, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { embedSnippet } from "../../../shared/hosting.ts";
import type { Actor } from "../auth/index.ts";
import { db, schema } from "../db/client.ts";
import { AppError, notFound } from "../lib/util.ts";
import { STREAM } from "./pricing.ts";
import { playbackBlocked, recordUsage } from "./usage.ts";

export type Hosted = typeof schema.hostedVideos.$inferSelect;

export const hostedPageUrl = (id: string) => `${env.APP_URL}/v/${id}`;
export const hostedEmbedUrl = (id: string) => `${env.APP_URL}/embed/${id}`;

const secret = (name: string) => (env as unknown as Record<string, string | undefined>)[name] || undefined;

/** Plays can only be billed when Cloudflare's analytics can be read. Without them, nothing is hosted. */
export function assertMeterable(): void {
	if (!secret("CLOUDFLARE_ANALYTICS_TOKEN") || !secret("CLOUDFLARE_ACCOUNT_ID")) {
		throw new AppError(
			503,
			"Hosting is not available on this server: plays could not be billed because CLOUDFLARE_ANALYTICS_TOKEN (Account Analytics: Read) is not set.",
			"hosting_unavailable",
		);
	}
}

export async function getHosted(actor: Actor, hostedId: string): Promise<Hosted> {
	const row = await db.query.hostedVideos.findFirst({ where: eq(schema.hostedVideos.id, hostedId) });
	if (!row || (row.userId !== actor.id && !actor.isAdmin)) throw notFound("Hosted video");
	return row;
}

export const hostedForVideo = (actor: Actor, videoId: string) =>
	db.query.hostedVideos.findMany({
		where: and(eq(schema.hostedVideos.videoId, videoId), actor.isAdmin ? undefined : eq(schema.hostedVideos.userId, actor.id)),
		orderBy: desc(schema.hostedVideos.createdAt),
		limit: 50,
	});

export function hostedView(row: Hosted) {
	const ready = row.status === "ready";
	return {
		id: row.id,
		videoId: row.videoId,
		renderId: row.renderId,
		status: row.status,
		/** False while the owner has paused it: the pages say it is unavailable. */
		enabled: row.enabled,
		title: row.title,
		description: row.description || undefined,
		/** The watch page: share this link. Anyone with it can watch. */
		pageUrl: hostedPageUrl(row.id),
		/** For an iframe; embedCode wraps it so it keeps its shape at any width. */
		embedUrl: hostedEmbedUrl(row.id),
		embedCode: ready ? embedSnippet(hostedEmbedUrl(row.id), row.title, row.width, row.height) : undefined,
		width: row.width,
		height: row.height,
		durationSec: row.durationSec ?? undefined,
		captions: row.captionsLanguage ?? undefined,
		chapters: row.chapters.length ? row.chapters : undefined,
		/** Sites allowed to embed it; empty means any site. */
		allowedOrigins: row.allowedOrigins,
		error: row.error ?? undefined,
		warnings: row.warnings.length ? row.warnings : undefined,
		createdAt: row.createdAt,
		readyAt: row.readyAt ?? undefined,
	};
}

// ------------------------------------------------------------- removing

const isNotFound = (error: unknown) => error instanceof Error && (error.name === "NotFoundError" || (error as { statusCode?: number }).statusCode === 404);

/** Deletes a Stream copy. One that is already gone counts as deleted. */
export async function deleteStreamCopy(streamUid: string): Promise<void> {
	try {
		await env.STREAM.video(streamUid).delete();
	} catch (error) {
		if (!isNotFound(error)) throw error;
	}
}

/** Deletes the Stream copy, then the row. If Stream cannot be reached, the row stays so the copy is not lost track of. */
export async function removeHosted(row: Hosted): Promise<void> {
	if (row.streamUid) await deleteStreamCopy(row.streamUid);
	await db.delete(schema.hostedVideos).where(eq(schema.hostedVideos.id, row.id));
}

/**
 * Removes every hosted copy of a video or of a whole project, before it is
 * deleted. Copies that cannot be removed now are left to the nightly sweep.
 */
export async function removeHostedFor(where: { videoId: string } | { projectId: string }): Promise<number> {
	const rows = await db.query.hostedVideos.findMany({
		where: "videoId" in where ? eq(schema.hostedVideos.videoId, where.videoId) : eq(schema.hostedVideos.projectId, where.projectId),
	});
	let removed = 0;
	for (const row of rows) {
		try {
			await removeHosted(row);
			removed++;
		} catch (error) {
			console.error("could not remove hosted copy; the nightly sweep will", row.id, error instanceof Error ? error.message : error);
		}
	}
	return removed;
}

/** Deletes copies whose video no longer exists (deleted with its project or account). */
async function sweepOrphans(): Promise<number> {
	const orphans = await db
		.select({ row: schema.hostedVideos })
		.from(schema.hostedVideos)
		.leftJoin(schema.videos, eq(schema.videos.id, schema.hostedVideos.videoId))
		.where(isNull(schema.videos.id));
	let removed = 0;
	for (const { row } of orphans) {
		try {
			await removeHosted(row);
			removed++;
		} catch (error) {
			console.error("hosting sweep could not remove", row.id, error instanceof Error ? error.message : error);
		}
	}
	return removed;
}

// ------------------------------------------------------------- playback

export type Unavailable = "processing" | "failed" | "paused" | "account";

/** What the watch page and embed need: the row, and either a playback token or why there is none. */
export async function playback(hostedId: string): Promise<{ row: Hosted; token?: string; unavailable?: Unavailable } | null> {
	const row = await db.query.hostedVideos.findFirst({ where: eq(schema.hostedVideos.id, hostedId) });
	if (!row) return null;
	if (row.status === "failed") return { row, unavailable: "failed" };
	if (row.status !== "ready" || !row.streamUid) return { row, unavailable: "processing" };
	if (!row.enabled) return { row, unavailable: "paused" };
	if (await playbackBlocked(row.userId)) return { row, unavailable: "account" };
	// Signed tokens last an hour: long enough to start and finish the short videos made here.
	return { row, token: await env.STREAM.video(row.streamUid).generateToken() };
}

// ------------------------------------------------------------- metering

const dayOf = (date: Date) => date.toISOString().slice(0, 10);
/** Midday of a UTC date, so a backdated ledger row sits squarely inside that day (and month). */
const middayOf = (date: string) => new Date(`${date}T12:00:00.000Z`);

/** One day of storage for every hosted copy, per account. */
async function accrueStreamStorage(day: Date) {
	const date = dayOf(day);
	const daysInMonth = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth() + 1, 0)).getUTCDate();
	const rows = await db
		.select({ userId: schema.hostedVideos.userId, seconds: sql<number>`coalesce(sum(${schema.hostedVideos.durationSec}), 0)` })
		.from(schema.hostedVideos)
		// A copy takes storage from the moment Stream has it until it is deleted; failed copies take none.
		.where(and(isNotNull(schema.hostedVideos.streamUid), inArray(schema.hostedVideos.status, ["processing", "ready"])))
		.groupBy(schema.hostedVideos.userId);
	let costUsd = 0;
	for (const row of rows) {
		// Stream rounds each copy up to the second; per account the difference is noise.
		const minutes = Math.ceil(row.seconds) / 60;
		if (minutes <= 0) continue;
		const cost = (minutes * STREAM.usdPerMinuteStoredMonth) / daysInMonth;
		costUsd += cost;
		await recordUsage({
			userId: row.userId,
			kind: "hosting",
			provider: "cloudflare",
			model: "stream/storage",
			quantity: minutes,
			unit: "minute-days",
			costUsd: cost,
			basis: "metered",
			ref: date,
			at: middayOf(date),
			dedupeKey: `stream-storage:${row.userId}:${date}`,
		});
	}
	return { accounts: rows.length, costUsd };
}

interface DeliveryGroup {
	sum: { minutesViewed: number };
	dimensions: { uid: string; creator: string | null };
}

/** Minutes Stream delivered on one UTC date, per copy and owner, from Cloudflare's analytics. */
async function deliveredOn(date: string): Promise<DeliveryGroup[]> {
	const token = secret("CLOUDFLARE_ANALYTICS_TOKEN")!;
	const accountTag = secret("CLOUDFLARE_ACCOUNT_ID")!;
	const query = `query($accountTag: String, $date: Date, $after: String) { viewer { accounts(filter: { accountTag: $accountTag }) {
		streamMinutesViewedAdaptiveGroups(limit: 1000, filter: { date: $date, uid_gt: $after }, orderBy: [uid_ASC]) { sum { minutesViewed } dimensions { uid creator } }
	} } }`;
	const groups: DeliveryGroup[] = [];
	let after = "";
	for (let page = 0; page < 100; page++) {
		const response = await fetch("https://api.cloudflare.com/client/v4/graphql", {
			method: "POST",
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
			body: JSON.stringify({ query, variables: { accountTag, date, after } }),
		});
		if (!response.ok) throw new Error(`Cloudflare analytics ${response.status}: ${(await response.text()).slice(0, 300)}`);
		const json = (await response.json()) as { data?: { viewer: { accounts: { streamMinutesViewedAdaptiveGroups: DeliveryGroup[] }[] } }; errors?: { message: string }[] | null };
		if (json.errors?.length) throw new Error(`Cloudflare analytics: ${json.errors.map((error) => error.message).join("; ").slice(0, 300)}`);
		const batch = json.data?.viewer.accounts[0]?.streamMinutesViewedAdaptiveGroups ?? [];
		groups.push(...batch);
		if (batch.length < 1000) break;
		after = batch.at(-1)!.dimensions.uid;
	}
	return groups;
}

/** Charges the minutes delivered on one date to each copy's owner, replacing what was recorded for it before. */
async function chargeDelivery(date: string) {
	const groups = (await deliveredOn(date)).filter((group) => group.sum.minutesViewed > 0);
	// Several groups can share a copy (one per creator value); add them up.
	const byUid = new Map<string, { minutes: number; creator: string | null }>();
	for (const group of groups) {
		const entry = byUid.get(group.dimensions.uid) ?? { minutes: 0, creator: group.dimensions.creator };
		entry.minutes += group.sum.minutesViewed;
		entry.creator ??= group.dimensions.creator;
		byUid.set(group.dimensions.uid, entry);
	}
	if (!byUid.size) return { copies: 0, minutes: 0, costUsd: 0, unattributed: 0 };
	const uids = [...byUid.keys()];
	const rows = new Map<string, Hosted>();
	for (let i = 0; i < uids.length; i += 90) {
		for (const row of await db.query.hostedVideos.findMany({ where: inArray(schema.hostedVideos.streamUid, uids.slice(i, i + 90)) })) rows.set(row.streamUid!, row);
	}
	const creators = [...new Set([...byUid.values()].map((entry) => entry.creator).filter((creator): creator is string => Boolean(creator)))];
	const known = new Set<string>();
	for (let i = 0; i < creators.length; i += 90) {
		for (const user of await db.query.user.findMany({ where: inArray(schema.user.id, creators.slice(i, i + 90)), columns: { id: true } })) known.add(user.id);
	}

	let minutes = 0;
	let costUsd = 0;
	let unattributed = 0;
	for (const [uid, entry] of byUid) {
		const row = rows.get(uid);
		const userId = row?.userId ?? (entry.creator && known.has(entry.creator) ? entry.creator : undefined);
		if (!userId) {
			// Not one of ours (another app on the same Cloudflare account), or an owner who no longer exists.
			unattributed += entry.minutes;
			continue;
		}
		const cost = entry.minutes * STREAM.usdPerMinuteDelivered;
		minutes += entry.minutes;
		costUsd += cost;
		await recordUsage({
			userId,
			projectId: row?.projectId,
			videoId: row?.videoId,
			kind: "streaming",
			provider: "cloudflare",
			model: "stream/delivery",
			quantity: entry.minutes,
			unit: "minutes watched",
			costUsd: cost,
			basis: "metered",
			ref: row?.id ?? uid,
			vendorRef: uid,
			at: middayOf(date),
			dedupeKey: `stream-delivery:${uid}:${date}`,
			replace: true,
		});
	}
	return { copies: byUid.size, minutes, costUsd, unattributed };
}

/**
 * The nightly hosting job: remove orphaned copies, charge yesterday's storage,
 * and charge the plays of the last two days. Runs before invoicing, so a month's
 * last day is billed in that month.
 */
export async function meterHosting(now: Date) {
	const yesterday = new Date(now.getTime() - 86_400_000);
	const swept = await sweepOrphans();
	const storage = await accrueStreamStorage(yesterday);
	if (!secret("CLOUDFLARE_ANALYTICS_TOKEN") || !secret("CLOUDFLARE_ACCOUNT_ID")) {
		const hosted = await db.$count(schema.hostedVideos);
		if (hosted) console.error(`hosting: ${hosted} hosted videos but CLOUDFLARE_ANALYTICS_TOKEN is not set, so their plays are not being billed`);
		return { swept, storage, delivery: { skipped: "CLOUDFLARE_ANALYTICS_TOKEN or CLOUDFLARE_ACCOUNT_ID is not set" } };
	}
	const twoDaysAgo = new Date(now.getTime() - 2 * 86_400_000);
	const delivery = { [dayOf(twoDaysAgo)]: await chargeDelivery(dayOf(twoDaysAgo)), [dayOf(yesterday)]: await chargeDelivery(dayOf(yesterday)) };
	return { swept, storage, delivery };
}
