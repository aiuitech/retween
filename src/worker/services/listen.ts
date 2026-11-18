/**
 * Listening to narration: each take is transcribed once (Whisper through
 * OpenRouter, a fraction of a cent a minute) and what was heard is kept on the
 * asset, so video.check can compare it with the script on every run for free.
 * Takes from OpenRouter voices are transcribed when they are made, for their
 * word timings, and keep what was heard then.
 */
import { eq } from "drizzle-orm";
import { type ReadDifference, compareRead, tokens } from "../../../shared/listen.ts";
import { type Issue, clock, round2 } from "../../../shared/inspect.ts";
import type { SpokenWord } from "../../../shared/narration.ts";
import type { Timeline } from "../../../shared/timeline.ts";
import { db, schema } from "../db/client.ts";
import { TIMING_MODEL, transcribeWords } from "../providers/openrouter.ts";
import { type Asset, assetsById } from "./assets.ts";
import type { Project } from "./projects.ts";
import { readObject } from "./storage.ts";
import { recordUsage } from "./usage.ts";
import type { Video } from "./videos.ts";

/** What a take was heard to say, kept in `meta.heard`. */
export const heardOf = (asset: Asset): SpokenWord[] | undefined => (Array.isArray(asset.meta.heard) ? (asset.meta.heard as SpokenWord[]) : undefined);

/** Transcribes a narration take, once. Returns what was heard, or undefined when the take cannot be read. */
async function hear(asset: Asset, language: string | undefined, userId: string): Promise<SpokenWord[] | undefined> {
	const cached = heardOf(asset);
	if (cached) return cached;
	if (asset.status !== "ready" || !asset.r2Key) return undefined;
	const file = await readObject(asset.r2Key);
	const result = await transcribeWords({ audio: file.bytes, contentType: file.contentType, language });
	await recordUsage({
		userId,
		projectId: asset.projectId,
		videoId: asset.meta.videoId,
		kind: "transcription",
		provider: "openrouter",
		model: TIMING_MODEL,
		quantity: Math.ceil(result.seconds ?? 0),
		unit: "seconds",
		costUsd: result.costUsd ?? ((result.seconds ?? 0) / 3600) * 0.012,
		basis: result.costUsd === undefined ? "list" : "vendor",
		ref: asset.id,
		vendorRef: result.generationId,
		dedupeKey: result.generationId && `openrouter:${result.generationId}`,
	});
	const heard: SpokenWord[] = result.words.map((word) => [word.word, Math.round(word.start * 1000) / 1000, Math.round(word.end * 1000) / 1000]);
	await db
		.update(schema.assets)
		.set({ meta: { ...asset.meta, heard } })
		.where(eq(schema.assets.id, asset.id));
	return heard;
}

async function inBatches<T, R>(items: T[], size: number, work: (item: T) => Promise<R>): Promise<R[]> {
	const out: R[] = [];
	for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(work))));
	return out;
}

export interface SceneRead {
	sceneId: string;
	matched: number;
	/** `respelled`: the script word is a pronunciation respelling, which a transcriber almost never spells back the same way. */
	differences: (ReadDifference & { atVideoSec: number; respelled?: true })[];
}

/**
 * Compares every voiced scene's take with its script. Scenes voiced by the
 * person's own footage are left alone: what they said is the script.
 */
export async function checkReads(
	video: Video,
	project: Project,
	timeline: Timeline,
	userId: string,
	sceneIds?: string[],
): Promise<{ issues: Issue[]; reads: SceneRead[]; unheard: string[] }> {
	const scenes = video.storyboard.scenes.filter((scene) => scene.narration?.trim() && !scene.footage && (!sceneIds || sceneIds.includes(scene.id)));
	const takes = await assetsById(
		project.id,
		scenes.map((scene) => video.resolved.narration[scene.id]?.assetId).filter((id): id is string => Boolean(id)),
	);
	const language = project.brand.narration?.language;
	const respellings = new Set((project.brand.narration?.pronunciations ?? []).flatMap((rule) => tokens(rule.say).map((token) => token.key)));
	const isRespelling = (text: string) => {
		const keys = tokens(text).map((token) => token.key);
		return keys.length > 0 && keys.every((key) => respellings.has(key));
	};
	const unheard: string[] = [];
	const reads = await inBatches(scenes, 4, async (scene): Promise<SceneRead | null> => {
		const take = takes.get(video.resolved.narration[scene.id]?.assetId ?? "");
		if (!take) return null;
		const heard = await hear(take, language, userId).catch((error) => {
			console.warn("could not transcribe narration", take.id, error instanceof Error ? error.message : error);
			return undefined;
		});
		if (!heard) {
			unheard.push(scene.id);
			return null;
		}
		const spoken = typeof take.meta.spokenText === "string" ? take.meta.spokenText : scene.narration!;
		const result = compareRead(spoken, heard);
		const clip = timeline.audio.find((candidate) => candidate.id === `narration-${scene.id}`);
		const offset = clip ? clip.startFrame / timeline.fps - clip.trimStartSec : (timeline.scenes.find((s) => s.id === scene.id)?.startFrame ?? 0) / timeline.fps;
		return {
			sceneId: scene.id,
			matched: round2(result.matched),
			differences: result.differences.map((difference) => ({
				...difference,
				atVideoSec: round2(offset + difference.atSec),
				...(difference.kind === "different" && isRespelling(difference.expected) ? { respelled: true as const } : {}),
			})),
		};
	});

	const issues: Issue[] = [];
	const found = reads.filter((read): read is SceneRead => Boolean(read));
	for (const read of found) {
		if (!read.differences.length) continue;
		const real = read.differences.filter((difference) => !difference.respelled);
		const serious = real.some((difference) => difference.weight >= 2) || real.length >= 2 || (real.length > 0 && read.matched < 0.85);
		const shown = read.differences.slice(0, 4).map((difference) =>
			difference.kind === "missing"
				? `"${difference.expected}" was not heard (${clock(difference.atVideoSec)})`
				: difference.kind === "extra"
					? `"${difference.heard}" was heard but is not in the script (${clock(difference.atVideoSec)})`
					: `"${difference.expected}" sounded like "${difference.heard}" (${clock(difference.atVideoSec)})${difference.respelled ? " — a pronunciation respelling, which transcribers rarely spell back the same way, so probably fine" : ""}`,
		);
		issues.push({
			severity: serious ? "warning" : "info",
			kind: "misread",
			sceneId: read.sceneId,
			atSec: read.differences[0]!.atVideoSec,
			message: `Scene "${read.sceneId}": the narration may not say what the script says: ${shown.join("; ")}${read.differences.length > 4 ? `; and ${read.differences.length - 4} more` : ""}. (${Math.round(read.matched * 100)}% of words heard as written; the transcriber can be wrong too, especially with names.)`,
			fix: `Listen with video.draft { sceneIds: ["${read.sceneId}"] }. If a word is misread, add a respelling (brand.update narration.pronunciations, e.g. { term: "Retween", say: "Re-tween" }) and re-voice: video.prepare { regenerate: { narration: true, sceneIds: ["${read.sceneId}"] } }. If a number or price was said wrong, write it out in words in the narration ("seven thousand two hundred dollars"). Numbers, currency and sound-alike spellings are already compared by value and sound, so what is reported here is worth a listen.`,
		});
	}
	return { issues, reads: found, unheard };
}
