/**
 * Videos: storyboards, the media they need, and composing them into timelines.
 */
import { env } from "cloudflare:workers";
import { desc, eq, inArray } from "drizzle-orm";
import { type BrandKit, DEFAULTS } from "../../../shared/brand.ts";
import { type ComposeAsset, type ComposeResult, composeTimeline } from "../../../shared/compose.ts";
import type { Scene, Storyboard } from "../../../shared/storyboard.ts";
import type { AspectRatio } from "../../../shared/timeline.ts";
import type { Actor } from "../auth/index.ts";
import { db, schema } from "../db/client.ts";
import type { GenerationSpec, ResolvedMedia } from "../db/schema.ts";
import { clamp, hashOf, notFound } from "../lib/util.ts";
import { type Orientation, searchStock } from "../providers/stock.ts";
import { type Asset, assetsById, createAsset, deleteAsset } from "./assets.ts";
import { type Project, getProject } from "./projects.ts";

export type Video = typeof schema.videos.$inferSelect;

export const emptyResolved = (): ResolvedMedia => ({ narration: {}, visual: {}, sfx: {} });

export async function getVideo(actor: Actor, videoId: string): Promise<{ video: Video; project: Project }> {
	const video = await db.query.videos.findFirst({ where: eq(schema.videos.id, videoId) });
	if (!video) throw notFound("Video");
	const project = await getProject(actor, video.projectId).catch(() => {
		throw notFound("Video");
	});
	return { video, project };
}

export async function loadVideo(videoId: string): Promise<{ video: Video; project: Project }> {
	const video = await db.query.videos.findFirst({ where: eq(schema.videos.id, videoId) });
	if (!video) throw notFound("Video");
	const project = await db.query.projects.findFirst({ where: eq(schema.projects.id, video.projectId) });
	if (!project) throw notFound("Project");
	return { video, project };
}

/** Every asset a video can touch: storyboard references, generated media and brand assets. */
function referencedAssetIds(storyboard: Storyboard, resolved: ResolvedMedia, brand: BrandKit): string[] {
	const ids = new Set<string | undefined>();
	for (const scene of storyboard.scenes) {
		ids.add(scene.visual?.assetId);
		for (const effect of scene.sfx ?? []) ids.add(effect.assetId);
	}
	for (const group of [resolved.narration, resolved.visual, resolved.sfx]) {
		for (const entry of Object.values(group)) ids.add(entry.assetId);
	}
	ids.add(resolved.music?.assetId);
	ids.add(storyboard.music?.assetId);
	ids.add(brand.audio?.musicAssetId);
	ids.add(brand.audio?.introStingAssetId);
	ids.add(brand.audio?.outroStingAssetId);
	ids.add(brand.visual?.logo?.assetId);
	ids.add(brand.visual?.logo?.darkAssetId);
	ids.add(brand.format?.watermark?.assetId);
	return [...ids].filter((id): id is string => Boolean(id));
}

const toComposeAsset = (asset: Asset): ComposeAsset => ({
	id: asset.id,
	kind: asset.kind,
	ready: asset.status === "ready",
	durationSec: asset.durationMs != null ? asset.durationMs / 1000 : undefined,
	words: asset.meta.words,
});

/** What the current timeline (if any) was built from; changes whenever a recompose is due. */
export function compositionHash(video: Pick<Video, "storyboard" | "resolved">, brand: BrandKit): Promise<string> {
	return hashOf({ storyboard: video.storyboard, resolved: video.resolved, brand });
}

/** Runs compose against the media that currently exists. Does not save anything. */
export async function runCompose(video: Video, project: Project): Promise<ComposeResult & { assets: Map<string, Asset> }> {
	const assets = await assetsById(project.id, referencedAssetIds(video.storyboard, video.resolved, project.brand));
	const result = composeTimeline({
		storyboard: video.storyboard,
		brand: project.brand,
		resolved: video.resolved,
		assets: new Map([...assets].map(([id, asset]) => [id, toComposeAsset(asset)])),
	});
	return { ...result, assets };
}

/** Composes and stores the timeline. The video becomes `ready` when it succeeds. */
export async function composeAndSave(video: Video, project: Project): Promise<ComposeResult> {
	const result = await runCompose(video, project);
	if (result.timeline) {
		await db
			.update(schema.videos)
			.set({
				timeline: result.timeline,
				composedFrom: await compositionHash(video, project.brand),
				status: "ready",
				pipeline: { ...video.pipeline, stage: "done", warnings: result.warnings, error: undefined, finishedAt: Date.now() },
			})
			.where(eq(schema.videos.id, video.id));
	}
	return result;
}

// ------------------------------------------------------------------ planning

export interface RegenerateOptions {
	narration?: boolean;
	visuals?: boolean;
	music?: boolean;
	/** Limit regeneration to these scenes. */
	sceneIds?: string[];
}

export interface PlannedItem {
	kind: "narration" | "image" | "clip" | "stock" | "sfx" | "music";
	sceneId?: string;
	/** Characters for narration, seconds for clips and music. */
	units?: number;
}

export interface MediaPlan {
	/** What this pass generates (or, in a dry run, would generate). */
	todo: PlannedItem[];
	/** Assets created by this pass that now need generating. */
	created: string[];
	/** Assets this video is waiting on, including ones already in flight. */
	pending: string[];
	problems: string[];
}

/** Brand style lock + cast descriptions wrapped around a scene's own image prompt. */
export function styledImagePrompt(brand: BrandKit, prompt: string, castIds: string[] = []): string {
	const parts = [prompt.trim()];
	const cast = (brand.cast ?? []).filter((member) => castIds.includes(member.id));
	for (const member of cast) parts.push(`${member.name}: ${member.description}`);
	const style = brand.visual?.imageStyle;
	if (style?.prompt) parts.push(`Style: ${style.prompt}`);
	if (style?.avoid) parts.push(`Avoid: ${style.avoid}`);
	return parts.join("\n\n");
}

export function imageReferenceIds(brand: BrandKit, castIds: string[] = [], extra: string[] = []): string[] {
	const cast = (brand.cast ?? []).filter((member) => castIds.includes(member.id)).flatMap((member) => member.referenceAssetIds ?? []);
	return [...new Set([...extra, ...cast, ...(brand.visual?.imageStyle?.referenceAssetIds ?? [])])].slice(0, 12);
}

export function narrationSpec(brand: BrandKit, text: string, override: Scene["voice"] = {}): Extract<GenerationSpec, { type: "speech" }> {
	const voice = brand.narration ?? {};
	return {
		type: "speech",
		text,
		pronunciations: voice.pronunciations ?? [],
		voiceId: override?.voiceId ?? voice.voiceId ?? DEFAULTS.voiceId,
		modelId: voice.modelId ?? DEFAULTS.voiceModel,
		language: voice.language,
		settings: {
			stability: voice.stability,
			similarity: voice.similarity,
			style: voice.style,
			speed: override?.speed ?? voice.speed,
			speakerBoost: voice.speakerBoost,
		},
	};
}

/** Clips come in 16:9 or 9:16 only; taller-than-wide videos get the portrait one. */
export const clipAspect = (aspect: AspectRatio) => (aspect === "9:16" || aspect === "4:5" ? "9:16" : "16:9");
const orientationOf = (aspect: AspectRatio): Orientation => (aspect === "16:9" ? "landscape" : aspect === "1:1" ? "square" : "portrait");

/**
 * Works out which media a storyboard still needs and creates pending assets
 * for it. Unchanged scenes keep their media: each entry is keyed by a hash of
 * the inputs that produced it.
 *
 * Phase 1 covers everything that does not depend on timing (narration, stills,
 * stock, sound effects). Phase 2 runs once narration has landed and covers
 * what does: generated clips sized to their scene, and a music bed sized to
 * the whole video.
 */
export async function planMedia(
	videoId: string,
	userId: string,
	phase: 1 | 2,
	regenerate: RegenerateOptions = {},
	options: { dryRun?: boolean } = {},
): Promise<MediaPlan> {
	const dryRun = options.dryRun ?? false;
	const { video, project } = await loadVideo(videoId);
	const brand = project.brand;
	const resolved: ResolvedMedia = structuredClone(video.resolved);
	const existing = await assetsById(project.id, referencedAssetIds(video.storyboard, resolved, brand));
	const plan: MediaPlan = { todo: [], created: [], pending: [], problems: [] };
	const superseded: string[] = [];
	const inScope = (sceneId: string) => !regenerate.sceneIds?.length || regenerate.sceneIds.includes(sceneId);

	/** Reuses the current entry when its inputs are unchanged, otherwise creates a pending asset. */
	const ensure = async (
		current: { assetId: string; hash: string } | undefined,
		hash: string,
		force: boolean,
		item: PlannedItem,
		create: () => Promise<Asset | null>,
	): Promise<{ assetId: string; hash: string } | undefined> => {
		const asset = current ? existing.get(current.assetId) : undefined;
		if (!force && current?.hash === hash && asset && asset.status !== "failed") {
			if (asset.status === "pending") plan.pending.push(asset.id);
			return current;
		}
		plan.todo.push(item);
		if (dryRun) return current;
		const created = await create();
		if (!created) return current && asset?.status === "ready" ? current : undefined;
		if (current && asset && asset.tags.includes("auto")) superseded.push(asset.id);
		plan.created.push(created.id);
		plan.pending.push(created.id);
		existing.set(created.id, created);
		return { assetId: created.id, hash };
	};
	const base = { projectId: project.id, createdBy: userId, source: "generated" as const };
	const sceneName = (scene: Scene) => scene.label ?? scene.id;

	for (const scene of video.storyboard.scenes) {
		if (phase === 1) {
			// Narration
			if (scene.narration?.trim()) {
				const spec = narrationSpec(brand, scene.narration.trim(), scene.voice);
				const entry = await ensure(resolved.narration[scene.id], await hashOf(spec), Boolean(regenerate.narration && inScope(scene.id)), { kind: "narration", sceneId: scene.id, units: scene.narration.trim().length }, () =>
					createAsset({
						...base,
						kind: "audio",
						name: `Narration · ${video.title} · ${sceneName(scene)}`,
						tags: ["auto", "narration"],
						meta: { prompt: scene.narration },
						generation: spec,
					}),
				);
				if (entry) resolved.narration[scene.id] = entry;
			} else {
				delete resolved.narration[scene.id];
			}

			// Sound effects described by a prompt
			for (const [index, effect] of (scene.sfx ?? []).entries()) {
				if (effect.assetId || !effect.prompt) continue;
				const key = `${scene.id}:${index}`;
				const spec: GenerationSpec = { type: "sfx", prompt: effect.prompt };
				const entry = await ensure(resolved.sfx[key], await hashOf(spec), false, { kind: "sfx", sceneId: scene.id }, () =>
					createAsset({ ...base, kind: "audio", name: `SFX · ${effect.prompt}`, tags: ["auto", "sfx"], meta: { prompt: effect.prompt }, generation: spec }),
				);
				if (entry) resolved.sfx[key] = entry;
			}
		}

		const visual = scene.visual;
		const forceVisual = Boolean(regenerate.visuals && inScope(scene.id));
		if (!visual || !["image", "video", "stock"].includes(visual.source)) {
			if (phase === 1) delete resolved.visual[scene.id];
			continue;
		}

		if (visual.source === "image" && phase === 1) {
			const spec: GenerationSpec = {
				type: "image",
				prompt: styledImagePrompt(brand, visual.prompt!, visual.cast),
				aspectRatio: video.aspect,
				quality: brand.visual?.imageStyle?.quality ?? "max",
				referenceAssetIds: imageReferenceIds(brand, visual.cast, visual.referenceAssetIds),
			};
			const entry = await ensure(resolved.visual[scene.id], await hashOf(spec), forceVisual, { kind: "image", sceneId: scene.id }, () =>
				createAsset({
					...base,
					kind: "image",
					name: `Image · ${video.title} · ${sceneName(scene)}`,
					tags: ["auto", "scene"],
					meta: { prompt: visual.prompt },
					generation: spec,
				}),
			);
			if (entry) resolved.visual[scene.id] = entry;
		}

		if (visual.source === "stock" && phase === 1) {
			const media = visual.media ?? "image";
			const hash = await hashOf({ stock: visual.query, media, aspect: video.aspect });
			const entry = await ensure(resolved.visual[scene.id], hash, forceVisual, { kind: "stock", sceneId: scene.id }, async () => {
				const { items } = await searchStock({ query: visual.query!, media, orientation: orientationOf(video.aspect), limit: 6 });
				// When re-rolling, skip the result that is already in use.
				const currentId = existing.get(resolved.visual[scene.id]?.assetId ?? "")?.meta.stockId;
				// Prefer media sharp enough to fill the frame, in the order the sources ranked it.
				const fresh = items.filter((candidate) => `${candidate.provider}:${candidate.id}` !== currentId);
				const sharp = (candidate: (typeof items)[number]) => Math.min(candidate.width ?? 0, candidate.height ?? 0) >= 1000;
				const item = fresh.find(sharp) ?? fresh[0] ?? items[0];
				if (!item) {
					plan.problems.push(`Scene "${scene.id}": no free stock ${media} found for "${visual.query}". Try other words, or generate an image instead.`);
					return null;
				}
				return createAsset({
					...base,
					source: "stock",
					kind: media,
					name: item.title,
					tags: ["auto", "scene", "stock"],
					meta: { prompt: visual.query, provider: item.provider, stockId: `${item.provider}:${item.id}` },
					license: item.license,
					generation: { type: "url", url: item.downloadUrl },
				});
			});
			if (entry) resolved.visual[scene.id] = entry;
		}

		if (visual.source === "video" && phase === 2) {
			const narration = existing.get(resolved.narration[scene.id]?.assetId ?? "");
			const spokenSec = narration?.durationMs ? narration.durationMs / 1000 : 0;
			const seconds = visual.seconds ?? clamp(Math.ceil(scene.timing?.seconds ?? (spokenSec ? spokenSec + 0.7 : 5)), 3, 15);
			const style = brand.visual?.videoStyle?.prompt;
			const spec: GenerationSpec = {
				type: "video",
				prompt: style ? `${visual.prompt!.trim()}\n\nStyle: ${style}` : visual.prompt!.trim(),
				seconds,
				aspectRatio: clipAspect(video.aspect),
				resolution: "720p",
				firstFrameAssetId: visual.firstFrameAssetId,
				withAudio: (visual.volume ?? 0) > 0,
			};
			// Length follows the narration, so it is left out of the key: a reworded line does not buy a new clip.
			const { seconds: _derived, ...keyed } = spec;
			const hash = await hashOf(visual.seconds ? spec : keyed);
			const entry = await ensure(resolved.visual[scene.id], hash, forceVisual, { kind: "clip", sceneId: scene.id, units: seconds }, () =>
				createAsset({
					...base,
					kind: "video",
					name: `Clip · ${video.title} · ${sceneName(scene)}`,
					tags: ["auto", "scene"],
					meta: { prompt: visual.prompt },
					generation: spec,
				}),
			);
			if (entry) resolved.visual[scene.id] = entry;
		} else if (visual.source === "video" && phase === 1) {
			const current = existing.get(resolved.visual[scene.id]?.assetId ?? "");
			if (current?.status === "pending") plan.pending.push(current.id);
		}
	}

	// Drop entries for scenes that no longer exist.
	if (phase === 1) {
		const sceneIds = new Set(video.storyboard.scenes.map((scene) => scene.id));
		for (const group of [resolved.narration, resolved.visual]) {
			for (const key of Object.keys(group)) if (!sceneIds.has(key)) delete group[key];
		}
		for (const key of Object.keys(resolved.sfx)) if (!sceneIds.has(key.split(":")[0]!)) delete resolved.sfx[key];
	}

	// Music bed, sized to the finished video.
	if (phase === 2) {
		const music = video.storyboard.music;
		const prompt = music?.prompt ?? (music?.assetId || brand.audio?.musicAssetId ? undefined : brand.audio?.musicPrompt);
		if (music?.enabled === false || music?.assetId || !prompt) {
			delete resolved.music;
		} else {
			const draft = composeTimeline({
				storyboard: { ...video.storyboard, music: { enabled: false } },
				brand,
				resolved,
				assets: new Map([...existing].map(([id, asset]) => [id, toComposeAsset(asset)])),
				draft: true,
			});
			const seconds = clamp(Math.ceil(draft.durationSec + 2), 10, 300);
			const spec: GenerationSpec = { type: "music", prompt, seconds, instrumental: true };
			// Re-score only when the length changes by a meaningful amount.
			const hash = await hashOf({ prompt, bucket: Math.ceil(seconds / 20) });
			const entry = await ensure(resolved.music, hash, Boolean(regenerate.music), { kind: "music", units: seconds }, () =>
				createAsset({ ...base, kind: "audio", name: `Music · ${video.title}`, tags: ["auto", "music"], meta: { prompt }, generation: spec }),
			);
			if (entry) resolved.music = entry;
		}
	}

	if (dryRun) return plan;
	await db.update(schema.videos).set({ resolved }).where(eq(schema.videos.id, video.id));

	// Media that was replaced is removed, unless a render might still be reading it.
	if (superseded.length) {
		const active = await db.query.renders.findFirst({
			where: (render, { and, eq: equals, inArray: within }) =>
				and(equals(render.videoId, video.id), within(render.status, ["queued", "starting", "rendering"])),
		});
		if (!active) {
			const rows = await db.query.assets.findMany({ where: inArray(schema.assets.id, superseded) });
			await Promise.all(rows.map((row) => deleteAsset(row).catch(() => undefined)));
		}
	}
	return plan;
}

// --------------------------------------------------------------------- views

export async function videoSummary(video: Video) {
	return {
		id: video.id,
		projectId: video.projectId,
		title: video.title,
		brief: video.brief ?? undefined,
		aspect: video.aspect,
		status: video.status,
		scenes: video.storyboard.scenes.length,
		durationSec: video.timeline ? video.timeline.durationInFrames / video.timeline.fps : undefined,
		updatedAt: video.updatedAt,
	};
}

/** Where each scene's media stands, in a form an agent can act on. */
export async function mediaStatus(video: Video, project: Project) {
	const assets = await assetsById(project.id, referencedAssetIds(video.storyboard, video.resolved, project.brand));
	const describe = (assetId: string | undefined) => {
		const asset = assetId ? assets.get(assetId) : undefined;
		if (!asset) return undefined;
		return {
			assetId: asset.id,
			status: asset.status,
			kind: asset.kind,
			durationSec: asset.durationMs != null ? asset.durationMs / 1000 : undefined,
			error: asset.error ?? undefined,
		};
	};
	return {
		scenes: video.storyboard.scenes.map((scene) => ({
			id: scene.id,
			narration: scene.narration ? (describe(video.resolved.narration[scene.id]?.assetId) ?? { status: "missing" }) : undefined,
			visual:
				scene.visual && ["image", "video", "stock"].includes(scene.visual.source)
					? (describe(video.resolved.visual[scene.id]?.assetId) ?? { status: "missing" })
					: scene.visual?.source === "asset"
						? (describe(scene.visual.assetId) ?? { status: "missing" })
						: undefined,
		})),
		music: describe(video.resolved.music?.assetId ?? video.storyboard.music?.assetId ?? project.brand.audio?.musicAssetId),
	};
}

export async function videoDetail(video: Video, project: Project) {
	const [media, renders, currentHash] = await Promise.all([
		mediaStatus(video, project),
		db.query.renders.findMany({ where: eq(schema.renders.videoId, video.id), orderBy: desc(schema.renders.createdAt), limit: 20 }),
		compositionHash(video, project.brand),
	]);
	const timeline = video.timeline;
	return {
		...(await videoSummary(video)),
		pipeline: video.pipeline,
		storyboard: video.storyboard,
		media,
		timeline: timeline
			? {
					/** True when the storyboard, brand or media changed after this timeline was composed. */
					stale: video.composedFrom !== currentHash,
					fps: timeline.fps,
					durationSec: timeline.durationInFrames / timeline.fps,
					scenes: timeline.scenes.map((scene) => ({
						id: scene.id,
						startSec: Math.round((scene.startFrame / timeline.fps) * 100) / 100,
						durationSec: Math.round((scene.durationInFrames / timeline.fps) * 100) / 100,
					})),
				}
			: undefined,
		renders: renders.map((render) => ({
			id: render.id,
			aspect: render.aspect,
			resolution: render.resolution,
			status: render.status,
			progress: render.progress,
			createdAt: render.createdAt,
		})),
	};
}

/** Credits owed for the third-party media a video uses. */
export async function videoCredits(video: Video, project: Project) {
	const assets = await assetsById(project.id, referencedAssetIds(video.storyboard, video.resolved, project.brand));
	const credits = [...assets.values()]
		.filter((asset) => asset.license)
		.map((asset) => ({
			assetId: asset.id,
			name: asset.name,
			provider: asset.license!.provider,
			license: asset.license!.license,
			licenseUrl: asset.license!.licenseUrl,
			author: asset.license!.author,
			sourceUrl: asset.license!.sourceUrl,
			attributionRequired: asset.license!.attributionRequired,
			attribution: asset.license!.attribution,
		}));
	const required = credits.filter((credit) => credit.attributionRequired);
	return {
		credits,
		/** Paste this into the video description when anything requires attribution. */
		creditsText: required.length ? required.map((credit) => credit.attribution ?? `${credit.name} (${credit.license})`).join("\n") : "",
		note: required.length
			? `${required.length} asset(s) require attribution. Include creditsText wherever the video is published.`
			: "Nothing in this video requires attribution.",
	};
}

/** Starts the pipeline workflow for a video. */
export async function startPipeline(
	video: Video,
	userId: string,
	options: { regenerate?: RegenerateOptions; renders?: { aspect: AspectRatio; resolution: string }[] },
): Promise<void> {
	await db
		.update(schema.videos)
		.set({ status: "preparing", pipeline: { stage: "assets", message: "Planning media", startedAt: Date.now() } })
		.where(eq(schema.videos.id, video.id));
	await env.PIPELINE_WORKFLOW.create({
		id: `${video.id}-${Date.now().toString(36)}`,
		params: { videoId: video.id, userId, regenerate: options.regenerate ?? {}, renders: options.renders ?? [] },
	});
}
