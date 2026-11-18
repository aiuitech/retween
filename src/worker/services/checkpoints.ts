/**
 * Checkpoints: saved states of a video's storyboard (and the media it was
 * using), so an agent can try something bold and go back. See the table in
 * db/schema.ts.
 */
import { and, desc, eq, inArray, lt, ne } from "drizzle-orm";
import type { Storyboard } from "../../../shared/storyboard.ts";
import { db, schema } from "../db/client.ts";
import type { ResolvedMedia } from "../db/schema.ts";
import { newId, notFound } from "../lib/util.ts";
import { assetsById } from "./assets.ts";
import type { Video } from "./videos.ts";

export type Checkpoint = typeof schema.videoCheckpoints.$inferSelect;

/** How many automatic checkpoints a video keeps. */
export const AUTO_KEEP = 20;

/** Every asset id a resolved-media record points at. */
export function resolvedIds(resolved: ResolvedMedia): string[] {
	return [
		...Object.values(resolved.narration),
		...Object.values(resolved.visual),
		...Object.values(resolved.sfx),
		...Object.values(resolved.cutout ?? {}),
		...Object.values(resolved.firstFrame ?? {}),
		...Object.values(resolved.icons ?? {}),
		...(resolved.music ? [resolved.music] : []),
	].map((entry) => entry.assetId);
}

/** Saves the video as it is. Automatic checkpoints are skipped when nothing changed since the last one, and pruned. */
export async function saveCheckpoint(video: Pick<Video, "id" | "storyboard" | "resolved">, options: { name?: string; auto?: boolean; reason?: string }): Promise<Checkpoint | null> {
	if (options.auto) {
		if (!video.storyboard.scenes.length) return null;
		const last = await db.query.videoCheckpoints.findFirst({ where: eq(schema.videoCheckpoints.videoId, video.id), orderBy: desc(schema.videoCheckpoints.createdAt) });
		if (last && JSON.stringify(last.storyboard) === JSON.stringify(video.storyboard)) return null;
	}
	const [checkpoint] = await db
		.insert(schema.videoCheckpoints)
		.values({ id: newId("chk"), videoId: video.id, name: options.name, auto: options.auto ?? false, reason: options.reason, storyboard: video.storyboard, resolved: video.resolved })
		.returning();
	if (options.auto) {
		const autos = await db.query.videoCheckpoints.findMany({
			where: and(eq(schema.videoCheckpoints.videoId, video.id), eq(schema.videoCheckpoints.auto, true)),
			orderBy: desc(schema.videoCheckpoints.createdAt),
			columns: { id: true, createdAt: true },
		});
		const cutoff = autos[AUTO_KEEP - 1]?.createdAt;
		if (autos.length > AUTO_KEEP && cutoff) {
			await db.delete(schema.videoCheckpoints).where(and(eq(schema.videoCheckpoints.videoId, video.id), eq(schema.videoCheckpoints.auto, true), lt(schema.videoCheckpoints.createdAt, cutoff)));
		}
	}
	return checkpoint!;
}

/**
 * Media that must outlive a change to one video: what its named checkpoints
 * use, and what other videos in the project use (a cutdown shares its
 * source's media). Kept when preparation replaces it or the video is deleted.
 */
export async function protectedAssetIds(videoId: string): Promise<Set<string>> {
	const video = await db.query.videos.findFirst({ where: eq(schema.videos.id, videoId), columns: { projectId: true } });
	const [named, others] = await Promise.all([
		db.query.videoCheckpoints.findMany({
			where: and(eq(schema.videoCheckpoints.videoId, videoId), eq(schema.videoCheckpoints.auto, false)),
			columns: { resolved: true },
		}),
		video ? db.query.videos.findMany({ where: and(eq(schema.videos.projectId, video.projectId), ne(schema.videos.id, videoId)), columns: { resolved: true } }) : Promise.resolve([]),
	]);
	return new Set([...named.flatMap((checkpoint) => resolvedIds(checkpoint.resolved)), ...others.flatMap((other) => resolvedIds(other.resolved))]);
}

export async function getCheckpoint(videoId: string, checkpointId: string): Promise<Checkpoint> {
	const checkpoint = await db.query.videoCheckpoints.findFirst({ where: and(eq(schema.videoCheckpoints.id, checkpointId), eq(schema.videoCheckpoints.videoId, videoId)) });
	if (!checkpoint) throw notFound(`Checkpoint ${checkpointId} of this video`);
	return checkpoint;
}

/** In a line, how a saved storyboard differs from the current one. */
export function difference(saved: Storyboard, current: Storyboard): string {
	const before = new Map(saved.scenes.map((scene) => [scene.id, JSON.stringify(scene)]));
	const after = new Map(current.scenes.map((scene) => [scene.id, JSON.stringify(scene)]));
	const added = [...after.keys()].filter((id) => !before.has(id));
	const removed = [...before.keys()].filter((id) => !after.has(id));
	const changed = [...after.keys()].filter((id) => before.has(id) && before.get(id) !== after.get(id));
	const moved = saved.scenes.map((scene) => scene.id).filter((id) => after.has(id)).join() !== current.scenes.map((scene) => scene.id).filter((id) => before.has(id)).join();
	const parts = [
		changed.length ? `since then changed: ${changed.join(", ")}` : "",
		added.length ? `added: ${added.join(", ")}` : "",
		removed.length ? `removed: ${removed.join(", ")}` : "",
		moved ? "scenes reordered" : "",
		JSON.stringify({ ...saved, scenes: undefined }) !== JSON.stringify({ ...current, scenes: undefined }) ? "music or captions changed" : "",
	].filter(Boolean);
	return parts.length ? parts.join("; ") : "same as now";
}

/**
 * The resolved media to restore: the checkpoint's, minus anything that has
 * since been deleted (video.prepare makes that again).
 */
export async function restorableMedia(projectId: string, checkpoint: Checkpoint): Promise<{ resolved: ResolvedMedia; missing: number }> {
	const ids = resolvedIds(checkpoint.resolved);
	const found = await assetsById(projectId, ids);
	const keep = <T extends Record<string, { assetId: string; hash: string }>>(group: T | undefined) =>
		Object.fromEntries(Object.entries(group ?? {}).filter(([, entry]) => found.has(entry.assetId))) as T;
	const resolved: ResolvedMedia = {
		...checkpoint.resolved,
		narration: keep(checkpoint.resolved.narration),
		visual: keep(checkpoint.resolved.visual),
		sfx: keep(checkpoint.resolved.sfx),
		cutout: keep(checkpoint.resolved.cutout),
		firstFrame: keep(checkpoint.resolved.firstFrame),
		icons: keep(checkpoint.resolved.icons),
		music: checkpoint.resolved.music && found.has(checkpoint.resolved.music.assetId) ? checkpoint.resolved.music : undefined,
	};
	return { resolved, missing: new Set(ids).size - [...new Set(ids)].filter((id) => found.has(id)).length };
}

export const checkpointsFor = (videoId: string) =>
	db.query.videoCheckpoints.findMany({ where: eq(schema.videoCheckpoints.videoId, videoId), orderBy: desc(schema.videoCheckpoints.createdAt), limit: 60 });

export const deleteCheckpoints = (videoId: string, ids: string[]) =>
	db.delete(schema.videoCheckpoints).where(and(eq(schema.videoCheckpoints.videoId, videoId), inArray(schema.videoCheckpoints.id, ids)));
