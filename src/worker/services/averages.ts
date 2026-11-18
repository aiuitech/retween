/**
 * What things have actually cost here lately, for the public page: figures a
 * list price cannot give, read from the usage ledger people are billed from.
 * Every figure is vendor cost, before markup, across all accounts; nothing in
 * it identifies an account, a project or a video.
 */
import { env } from "cloudflare:workers";
import { sql } from "drizzle-orm";
import { db, schema } from "../db/client.ts";

/** Long enough to smooth out one unusual video, short enough to follow vendors' price changes. */
export const AVERAGE_WINDOW_DAYS = 90;
const CACHE_SECONDS = 3600;

export interface Averages {
	/**
	 * Vendor cost of one finished minute of video, everything included: the media made
	 * for it (retakes and replaced versions too) and every render. Null until a video has been rendered.
	 */
	usdPerVideoMinute: number | null;
	/** Vendor cost of one generated still. Null until one has been generated. */
	usdPerStill: number | null;
	/** Seconds a render container ran per second of video it produced, start-up included. Null until a render has been metered. */
	renderSecondsPerVideoSecond: number | null;
	windowDays: number;
	asOf: string;
}

async function measure(): Promise<Averages> {
	const { renders, usageEvents: usage } = schema;
	const since = Date.now() - AVERAGE_WINDOW_DAYS * 86_400_000;
	const [[finished], [stills], [rendering]] = await Promise.all([
		// Each video counts once, at its longest finished render, against everything ever spent on it.
		db.all<{ costMicros: number; ms: number }>(sql`
			select coalesce(sum(video.cost), 0) as costMicros, coalesce(sum(video.ms), 0) as ms
			from (
				select max(${renders.durationMs}) as ms,
					(select coalesce(sum(${usage.costMicros}), 0) from ${usage} where ${usage.videoId} = ${renders.videoId}) as cost
				from ${renders}
				where ${renders.status} = 'done' and ${renders.durationMs} > 0 and ${renders.finishedAt} >= ${since}
				group by ${renders.videoId}
			) as video`),
		// Stills come from OpenRouter, which reports each request's charge. Unpriced rows would only drag the average down.
		db.all<{ costMicros: number; count: number }>(sql`
			select coalesce(sum(${usage.costMicros}), 0) as costMicros, coalesce(sum(${usage.quantity}), 0) as count
			from ${usage}
			where ${usage.kind} = 'image' and ${usage.provider} = 'openrouter' and ${usage.costMicros} > 0 and ${usage.createdAt} >= ${since}`),
		// Only renders whose container run was metered, so one that ran outside a container cannot shorten the figure.
		db.all<{ machineSeconds: number; videoMs: number }>(sql`
			select coalesce(sum(run.seconds), 0) as machineSeconds, coalesce(sum(run.ms), 0) as videoMs
			from (
				select ${renders.durationMs} as ms,
					(select sum(${usage.quantity}) from ${usage}
						where ${usage.videoId} = ${renders.videoId} and ${usage.ref} = ${renders.id} and ${usage.kind} = 'render') as seconds
				from ${renders}
				where ${renders.status} = 'done' and ${renders.durationMs} > 0 and ${renders.finishedAt} >= ${since}
			) as run
			where run.seconds > 0`),
	]);
	return {
		usdPerVideoMinute: finished && finished.ms > 0 ? finished.costMicros / 1_000_000 / (finished.ms / 60_000) : null,
		usdPerStill: stills && stills.count > 0 ? stills.costMicros / 1_000_000 / stills.count : null,
		renderSecondsPerVideoSecond: rendering && rendering.videoMs > 0 && rendering.machineSeconds > 0 ? rendering.machineSeconds / (rendering.videoMs / 1000) : null,
		windowDays: AVERAGE_WINDOW_DAYS,
		asOf: new Date().toISOString(),
	};
}

/**
 * The averages, measured at most once an hour. They are kept in Cloudflare's
 * cache, which every instance of the Worker in a data centre shares, so the
 * public page costs a cache read and the ledger is only summed when that expires.
 */
export async function averages(): Promise<Averages> {
	const key = new Request(new URL("/__cache/averages-v2", env.APP_URL));
	const cache = await caches.open("retween:averages").catch(() => undefined);
	const kept = await cache?.match(key).catch(() => undefined);
	if (kept) return (await kept.json()) as Averages;
	const fresh = await measure();
	await cache?.put(key, Response.json(fresh, { headers: { "cache-control": `public, max-age=${CACHE_SECONDS}` } })).catch(() => undefined);
	return fresh;
}
