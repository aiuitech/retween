import { env } from "cloudflare:workers";
import { and, desc, eq, like, sql } from "drizzle-orm";
import { z } from "zod";
import { ASPECT_RATIOS } from "../../../shared/timeline.ts";
import { db, schema } from "../db/client.ts";
import { ASSET_KINDS, type GenerationSpec } from "../db/schema.ts";
import { badRequest } from "../lib/util.ts";
import { listVoices } from "../providers/elevenlabs.ts";
import { IMAGE_ASPECTS, VIDEO_RESOLUTIONS } from "../providers/openrouter.ts";
import { STOCK_PROVIDERS, availableProviders, getStockItem, searchStock } from "../providers/stock.ts";
import { type Asset, assetView, createAsset, deleteAsset, getAsset, startGeneration, waitForAssets } from "../services/assets.ts";
import { getProject } from "../services/projects.ts";
import { assertBudget } from "../services/usage.ts";
import { imageReferenceIds, narrationSpec, styledImagePrompt } from "../services/videos.ts";
import { defineOp, waitSeconds } from "./registry.ts";

const projectId = z.string().describe("Project id (prj_…)");
const tags = z
	.array(z.string().max(40))
	.max(12)
	.optional()
	.describe('Labels that say what the asset is for, e.g. ["logo"], ["reference"], ["music"], ["b-roll"]');
const name = z.string().max(200).optional().describe("Display name");

/** Starts generation and waits briefly, returning the asset in whatever state it has reached. */
async function generateAndWait(asset: Asset, seconds: number) {
	await startGeneration(asset);
	const [current] = await waitForAssets([asset.id], seconds);
	const view = await assetView(current ?? asset);
	return {
		asset: view,
		...(view.status === "pending" ? { note: `Still generating. Check it with asset.get (assetId ${asset.id}).` } : {}),
	};
}

export const assetOps = [
	defineOp({
		name: "asset.list",
		title: "List assets",
		description:
			"Assets in a project: uploaded and imported files, generated images, clips, narration, music and sound effects. " +
			"Media generated automatically for a video's scenes is hidden unless includeAuto is true.",
		input: z.object({
			projectId,
			kind: z.enum(ASSET_KINDS).optional(),
			tag: z.string().optional().describe("Only assets with this tag"),
			search: z.string().optional().describe("Match against the name"),
			includeAuto: z.boolean().default(false),
			withUrls: z.boolean().default(false).describe("Include a temporary link to each file"),
			limit: z.number().int().min(1).max(200).default(50),
		}),
		readOnly: true,
		handler: async (input, { actor }) => {
			const project = await getProject(actor, input.projectId);
			const rows = await db.query.assets.findMany({
				where: and(
					eq(schema.assets.projectId, project.id),
					input.kind ? eq(schema.assets.kind, input.kind) : undefined,
					input.search ? like(schema.assets.name, `%${input.search}%`) : undefined,
					input.tag ? sql`exists (select 1 from json_each(${schema.assets.tags}) where value = ${input.tag})` : undefined,
					input.includeAuto || input.tag ? undefined : sql`not exists (select 1 from json_each(${schema.assets.tags}) where value = 'auto')`,
				),
				orderBy: desc(schema.assets.createdAt),
				limit: input.limit,
			});
			return { assets: await Promise.all(rows.map((row) => assetView(row, { url: input.withUrls }))) };
		},
	}),

	defineOp({
		name: "asset.get",
		title: "Get asset",
		description: "One asset, with its status and a temporary link to the file. Use it to check on something that is still generating.",
		input: z.object({ assetId: z.string(), waitSeconds: waitSeconds.default(0) }),
		readOnly: true,
		handler: async (input, { actor }) => {
			const { asset } = await getAsset(actor, input.assetId);
			const [current] = asset.status === "pending" && input.waitSeconds ? await waitForAssets([asset.id], input.waitSeconds) : [asset];
			return { asset: await assetView(current ?? asset) };
		},
	}),

	defineOp({
		name: "asset.update",
		title: "Update asset",
		description: "Rename an asset, describe it, or change its tags. A good description helps choose the right asset later.",
		input: z.object({ assetId: z.string(), name, description: z.string().max(2000).optional(), tags }),
		handler: async (input, { actor }) => {
			const { asset } = await getAsset(actor, input.assetId);
			const [updated] = await db
				.update(schema.assets)
				.set({ name: input.name ?? asset.name, description: input.description ?? asset.description, tags: input.tags ?? asset.tags })
				.where(eq(schema.assets.id, asset.id))
				.returning();
			return { asset: await assetView(updated!, { url: false }) };
		},
	}),

	defineOp({
		name: "asset.delete",
		title: "Delete asset",
		description: "Permanently delete an asset and its file. Scenes or brand settings that point at it fall back to defaults.",
		input: z.object({ assetId: z.string() }),
		destructive: true,
		handler: async (input, { actor }) => {
			const { asset } = await getAsset(actor, input.assetId);
			await deleteAsset(asset);
			return { deleted: asset.id };
		},
	}),

	defineOp({
		name: "asset.upload_link",
		title: "Upload link",
		description:
			"A link to give the person you are working with so they can upload their own files (logo, photos, footage, voiceover, music, fonts) into a project from their browser. " +
			"You cannot receive their files directly: send them this link, ask them to say when they are done, then find the new assets with asset.list. " +
			"From a shell the CLI also uploads: `retween asset upload <file…> --project <id>`.",
		input: z.object({ projectId }),
		readOnly: true,
		handler: async (input, { actor }) => {
			const project = await getProject(actor, input.projectId);
			return {
				url: `${env.APP_URL}/projects/${encodeURIComponent(project.id)}`,
				accepts: "Images, video, audio and fonts, several at once. The person must be signed in to Retween with the account that owns the project.",
				afterwards: `asset.list with projectId ${project.id} shows what they uploaded (source "upload").`,
			};
		},
	}),

	defineOp({
		name: "asset.import_url",
		title: "Import from URL",
		description:
			"Download an image, video, audio or font file from a public URL into the project. " +
			"For files the person has on their own device, use asset.upload_link instead.",
		input: z.object({
			projectId,
			url: z.url(),
			name,
			description: z.string().max(2000).optional(),
			tags,
			license: z
				.object({
					license: z.string().max(120).describe('e.g. "CC BY 4.0", "Owned", "Licensed from Acme"'),
					author: z.string().max(200).optional(),
					sourceUrl: z.string().max(500).optional(),
					attributionRequired: z.boolean().default(false),
					attribution: z.string().max(500).optional(),
				})
				.optional()
				.describe("Where this came from and whether it must be credited"),
			waitSeconds,
		}),
		handler: async (input, { actor }) => {
			const project = await getProject(actor, input.projectId);
			const fileName = decodeURIComponent(new URL(input.url).pathname.split("/").pop() || "import");
			const asset = await createAsset({
				projectId: project.id,
				createdBy: actor.id,
				kind: "other",
				name: input.name ?? fileName,
				description: input.description,
				source: "url",
				tags: input.tags,
				license: input.license ? { provider: new URL(input.url).hostname, ...input.license } : undefined,
				generation: { type: "url", url: input.url },
			});
			return generateAndWait(asset, input.waitSeconds);
		},
	}),

	defineOp({
		name: "asset.generate_image",
		title: "Generate image",
		description:
			"Generate a still image. The project's image style lock, cast descriptions and reference images are applied automatically so results stay on-brand. " +
			"For a scene's visual you usually do not need this: give the scene a visual with source \"image\" and video.prepare generates it. " +
			"Use this for standalone assets such as logos, reference images or backgrounds.",
		input: z.object({
			projectId,
			prompt: z.string().min(3).max(4000).describe("Subject, composition and framing"),
			aspectRatio: z.enum(IMAGE_ASPECTS).default("16:9"),
			quality: z.enum(["low", "medium", "high", "xhigh", "max"]).optional().describe("Defaults to the brand kit's setting, or max"),
			cast: z.array(z.string()).max(6).optional().describe("Ids of brand cast members in the image"),
			referenceAssetIds: z.array(z.string()).max(8).optional().describe("Image assets to match"),
			useBrandStyle: z.boolean().default(true).describe("Apply the brand's style lock and reference images"),
			transparent: z.boolean().default(false).describe("Transparent background (for logos and cut-outs)"),
			name,
			tags,
			waitSeconds,
		}),
		paid: true,
		handler: async (input, { actor }) => {
			const project = await getProject(actor, input.projectId);
			await assertBudget(actor);
			const brand = input.useBrandStyle ? project.brand : {};
			const spec: GenerationSpec = {
				type: "image",
				prompt: styledImagePrompt(brand, input.prompt, input.cast),
				aspectRatio: input.aspectRatio,
				quality: input.quality ?? project.brand.visual?.imageStyle?.quality ?? "max",
				referenceAssetIds: imageReferenceIds(brand, input.cast, input.referenceAssetIds),
				transparent: input.transparent,
			};
			const asset = await createAsset({
				projectId: project.id,
				createdBy: actor.id,
				kind: "image",
				name: input.name ?? input.prompt.slice(0, 80),
				source: "generated",
				tags: input.tags,
				meta: { prompt: input.prompt },
				generation: spec,
			});
			return generateAndWait(asset, input.waitSeconds);
		},
	}),

	defineOp({
		name: "asset.generate_video",
		title: "Generate video clip",
		description:
			"Generate a short video clip (3–15 s, landscape or portrait). This is by far the most expensive kind of generation: use it sparingly, " +
			"for moments that need real motion, and prefer stills or stock footage otherwise. Clips take a minute or two.",
		input: z.object({
			projectId,
			prompt: z.string().min(3).max(4000).describe("What happens in the shot: subject, action, camera movement"),
			seconds: z.number().int().min(3).max(15).default(5),
			aspectRatio: z.enum(["16:9", "9:16"]).default("16:9"),
			resolution: z.enum(VIDEO_RESOLUTIONS).default("720p"),
			firstFrameAssetId: z.string().optional().describe("An image asset to animate from"),
			withAudio: z.boolean().default(false).describe("Generate sound with the clip"),
			useBrandStyle: z.boolean().default(true),
			name,
			tags,
			waitSeconds,
		}),
		paid: true,
		handler: async (input, { actor }) => {
			const project = await getProject(actor, input.projectId);
			await assertBudget(actor);
			const style = input.useBrandStyle ? project.brand.visual?.videoStyle?.prompt : undefined;
			const asset = await createAsset({
				projectId: project.id,
				createdBy: actor.id,
				kind: "video",
				name: input.name ?? input.prompt.slice(0, 80),
				source: "generated",
				tags: input.tags,
				meta: { prompt: input.prompt },
				generation: {
					type: "video",
					prompt: style ? `${input.prompt}\n\nStyle: ${style}` : input.prompt,
					seconds: input.seconds,
					aspectRatio: input.aspectRatio,
					resolution: input.resolution,
					firstFrameAssetId: input.firstFrameAssetId,
					withAudio: input.withAudio,
				},
			});
			return generateAndWait(asset, input.waitSeconds);
		},
	}),

	defineOp({
		name: "asset.generate_speech",
		title: "Generate speech",
		description:
			"Voice a piece of text with the project's narration voice. Scene narration is generated by video.prepare; " +
			"use this to audition a voice or settings before committing to them in the brand kit.",
		input: z.object({
			projectId,
			text: z.string().min(1).max(3000),
			voiceId: z.string().optional().describe("Defaults to the brand kit's voice"),
			speed: z.number().min(0.7).max(1.2).optional(),
			name,
			tags,
			waitSeconds,
		}),
		paid: true,
		handler: async (input, { actor }) => {
			const project = await getProject(actor, input.projectId);
			await assertBudget(actor);
			const asset = await createAsset({
				projectId: project.id,
				createdBy: actor.id,
				kind: "audio",
				name: input.name ?? `Speech: ${input.text.slice(0, 60)}`,
				source: "generated",
				tags: input.tags ?? ["speech"],
				meta: { prompt: input.text },
				generation: narrationSpec(project.brand, input.text, { voiceId: input.voiceId, speed: input.speed }),
			});
			return generateAndWait(asset, input.waitSeconds);
		},
	}),

	defineOp({
		name: "asset.generate_music",
		title: "Generate music",
		description:
			"Compose an instrumental music bed (10 s to 5 min). To make it the project default, set audio.musicAssetId in the brand kit; " +
			"a bed shorter than a video loops.",
		input: z.object({
			projectId,
			prompt: z.string().max(2000).optional().describe("Genre, tempo, instruments, mood. Defaults to the brand kit's music prompt"),
			seconds: z.number().min(10).max(300).default(60),
			instrumental: z.boolean().default(true),
			name,
			tags,
			waitSeconds,
		}),
		paid: true,
		handler: async (input, { actor }) => {
			const project = await getProject(actor, input.projectId);
			await assertBudget(actor);
			const prompt = input.prompt ?? project.brand.audio?.musicPrompt;
			if (!prompt) throw badRequest("Describe the music with `prompt`, or set audio.musicPrompt in the brand kit");
			const asset = await createAsset({
				projectId: project.id,
				createdBy: actor.id,
				kind: "audio",
				name: input.name ?? `Music: ${prompt.slice(0, 60)}`,
				source: "generated",
				tags: input.tags ?? ["music"],
				meta: { prompt },
				generation: { type: "music", prompt, seconds: input.seconds, instrumental: input.instrumental },
			});
			return generateAndWait(asset, input.waitSeconds);
		},
	}),

	defineOp({
		name: "asset.generate_sfx",
		title: "Generate sound effect",
		description: "Generate a sound effect (0.5–30 s) from a description, e.g. a whoosh, a notification chime, rain on a window.",
		input: z.object({
			projectId,
			prompt: z.string().min(2).max(500),
			seconds: z.number().min(0.5).max(30).optional().describe("Leave out to let the model choose"),
			name,
			tags,
			waitSeconds,
		}),
		paid: true,
		handler: async (input, { actor }) => {
			const project = await getProject(actor, input.projectId);
			await assertBudget(actor);
			const asset = await createAsset({
				projectId: project.id,
				createdBy: actor.id,
				kind: "audio",
				name: input.name ?? `SFX: ${input.prompt.slice(0, 60)}`,
				source: "generated",
				tags: input.tags ?? ["sfx"],
				meta: { prompt: input.prompt },
				generation: { type: "sfx", prompt: input.prompt, seconds: input.seconds },
			});
			return generateAndWait(asset, input.waitSeconds);
		},
	}),

	defineOp({
		name: "stock.search",
		title: "Search free stock",
		description:
			"Search free stock photos, footage and audio that may be used commercially and modified (public domain, attribution-only and stock-site licences; " +
			"share-alike and non-commercial material is left out). Each result states its licence and whether it must be credited. " +
			"Import a result with stock.import. Free stock is the cheapest way to fill a scene: reach for it before generating video.",
		input: z.object({
			query: z.string().min(2).max(200),
			media: z.enum(["image", "video", "audio"]).default("image"),
			orientation: z.enum(["landscape", "portrait", "square"]).optional(),
			provider: z.enum(STOCK_PROVIDERS).optional().describe("Search one source only"),
			limit: z.number().int().min(1).max(30).default(12),
		}),
		readOnly: true,
		handler: async (input) => {
			const result = await searchStock(input);
			return {
				results: result.items.map((item) => ({
					provider: item.provider,
					id: item.id,
					media: item.media,
					title: item.title,
					previewUrl: item.previewUrl,
					pageUrl: item.pageUrl,
					width: item.width,
					height: item.height,
					durationSec: item.durationSec,
					license: item.license.license,
					attributionRequired: item.license.attributionRequired,
					author: item.license.author,
				})),
				searched: result.searched,
				...(result.failed.length ? { failed: result.failed } : {}),
				sources: { available: availableProviders(input.media) },
			};
		},
	}),

	defineOp({
		name: "stock.import",
		title: "Import stock",
		description: "Copy a stock.search result into the project, keeping its licence and credit line with the asset.",
		input: z.object({
			projectId,
			provider: z.enum(STOCK_PROVIDERS),
			id: z.string().describe("The result's id"),
			media: z.enum(["image", "video", "audio"]).default("image"),
			name,
			tags,
			waitSeconds,
		}),
		handler: async (input, { actor }) => {
			const project = await getProject(actor, input.projectId);
			const item = await getStockItem(input.provider, input.id, input.media);
			const asset = await createAsset({
				projectId: project.id,
				createdBy: actor.id,
				kind: item.media,
				name: input.name ?? item.title,
				source: "stock",
				tags: input.tags ?? ["stock"],
				meta: { provider: item.provider, stockId: `${item.provider}:${item.id}` },
				license: item.license,
				generation: { type: "url", url: item.downloadUrl },
			});
			return generateAndWait(asset, input.waitSeconds);
		},
	}),

	defineOp({
		name: "voice.list",
		title: "List voices",
		description: "Narration voices that can be set as narration.voiceId in the brand kit or on a single scene.",
		input: z.object({ search: z.string().max(100).optional().describe("Name, accent, gender or style") }),
		readOnly: true,
		handler: async (input) => listVoices(input.search),
	}),
];

