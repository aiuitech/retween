/**
 * Costs that are not a single vendor request: container run time and storage.
 * Both are measured here and charged to the person they belong to.
 */
import { eq, sql } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import { CONTAINER_INSTANCE_TYPE, R2_USD_PER_GB_MONTH, containerUsdPerSecond } from "./pricing.ts";
import { recordUsage } from "./usage.ts";

const PREVIEW_PREFIX = "preview-";

/** The renderer instance that serves one person's preview frames. */
export const previewInstance = (userId: string) => `${PREVIEW_PREFIX}${userId}`;

/**
 * Charges one container run, from start to stop, to its owner: the person for
 * a preview instance, or whoever started the render for a render instance.
 */
export async function recordContainerRun(instance: string, startedAt: number, stoppedAt: number): Promise<void> {
	const seconds = Math.max(0, (stoppedAt - startedAt) / 1000);
	let owner: { userId: string; projectId: string | null; kind: "preview" | "render" } | undefined;
	if (instance.startsWith(PREVIEW_PREFIX)) {
		owner = { userId: instance.slice(PREVIEW_PREFIX.length), projectId: null, kind: "preview" };
	} else {
		const render = await db.query.renders.findFirst({ where: eq(schema.renders.id, instance) });
		if (render) owner = { userId: render.createdBy, projectId: render.projectId, kind: "render" };
	}
	if (!owner) {
		console.warn("container run has no owner, not charged", instance, seconds);
		return;
	}
	await recordUsage({
		...owner,
		ref: instance,
		provider: "cloudflare",
		model: `containers/${CONTAINER_INSTANCE_TYPE}`,
		quantity: seconds,
		unit: "seconds",
		costUsd: seconds * containerUsdPerSecond(),
		basis: "metered",
		dedupeKey: `container:${instance}:${startedAt}`,
	});
}

/**
 * Charges each person one day of R2 storage for everything their projects
 * hold (assets and finished renders). Run once a day; a second run for the
 * same day changes nothing.
 */
export async function accrueStorage(day: Date = new Date()): Promise<{ users: number; bytes: number; costUsd: number }> {
	const date = day.toISOString().slice(0, 10);
	const daysInMonth = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth() + 1, 0)).getUTCDate();
	const [assetRows, renderRows] = await Promise.all([
		db
			.select({ userId: schema.projects.ownerId, bytes: sql<number>`coalesce(sum(${schema.assets.bytes}), 0)` })
			.from(schema.assets)
			.innerJoin(schema.projects, eq(schema.projects.id, schema.assets.projectId))
			.groupBy(schema.projects.ownerId),
		db
			.select({ userId: schema.projects.ownerId, bytes: sql<number>`coalesce(sum(${schema.renders.bytes}), 0)` })
			.from(schema.renders)
			.innerJoin(schema.projects, eq(schema.projects.id, schema.renders.projectId))
			.groupBy(schema.projects.ownerId),
	]);
	const byUser = new Map<string, number>();
	for (const row of [...assetRows, ...renderRows]) byUser.set(row.userId, (byUser.get(row.userId) ?? 0) + row.bytes);

	let totalBytes = 0;
	let totalUsd = 0;
	for (const [userId, bytes] of byUser) {
		if (bytes <= 0) continue;
		const costUsd = (bytes / 1e9) * (R2_USD_PER_GB_MONTH / daysInMonth);
		totalBytes += bytes;
		totalUsd += costUsd;
		await recordUsage({
			userId,
			kind: "storage",
			provider: "cloudflare",
			model: "r2/standard",
			// Megabytes, so a day's figure stays a readable whole number.
			quantity: bytes / 1e6,
			unit: "MB-days",
			costUsd,
			basis: "metered",
			ref: date,
			dedupeKey: `storage:${userId}:${date}`,
		});
	}
	return { users: byUser.size, bytes: totalBytes, costUsd: totalUsd };
}
