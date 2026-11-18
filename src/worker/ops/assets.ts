import { env } from "cloudflare:workers";
import { and, desc, eq, like, sql } from "drizzle-orm";
import { z } from "zod";
import { ASPECT_RATIOS } from "../../../shared/timeline.ts";
import { db, schema } from "../db/client.ts";
import { ASSET_KINDS, type GenerationSpec } from "../db/schema.ts";
import { badRequest, bytesToBase64 } from "../lib/util.ts";
import { listVoices } from "../providers/elevenlabs.ts";
import { IMAGE_ASPECTS, VIDEO_RESOLUTIONS } from "../providers/openrouter.ts";
import { searchIcons, searchPlaces } from "../providers/iconify.ts";
import { STOCK_PROVIDERS, availableProviders, getStockItem, searchStock } from "../providers/stock.ts";
import { type Asset, assetView, createAsset, deleteAsset, getAsset, startGeneration, waitForAssets } from "../services/assets.ts";
import { renderSheet } from "../services/inspect.ts";
import { getProject } from "../services/projects.ts";
import { signedUploadUrl } from "../services/storage.ts";
import { enforceControls } from "../services/controls.ts";
import { assertBudget } from "../services/usage.ts";
import { imageReferenceIds, narrationSpec, styledImagePrompt } from "../services/videos.ts";
import { INLINE_IMAGE, defineOp, waitSeconds } from "./registry.ts";

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


/** How to send a file over 90 MB through an upload link, in parts. */
function multipartHelp(uploadUrl: string) {
	const link = new URL(uploadUrl);
	link.pathname = `${link.pathname}/multipart`;
	const startUrl = link.toString();
	return {
		over: "90 MB",
		startUrl,
		steps: [
			`curl -s -X POST "${startUrl}" -H 'content-type: application/json' -d '{"name":"talk.mov","bytes":'$(stat -f%z talk.mov 2>/dev/null || stat -c%s talk.mov)'}'   # → uploadId, partSize, parts, partUrl, completeUrl`,
			"split -b <partSize> -a 3 -d talk.mov part.   # part.000, part.001, … (part.000 is part 1)",
			'for each part N: curl -s -T part.<N-1, 3 digits> "<partUrl with {partNumber} = N>"   # → { partNumber, etag }',
			`curl -s -X POST "<completeUrl>" -H 'content-type: application/json' -d '{"parts":[{"partNumber":1,"etag":"…"}, …]}'   # → the new asset`,
		],
		cli: "retween upload talk.mov --project <projectId>   (splits large files automatically)",
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
			"Two ways to get files that are not on the web (logo, photos, footage, voiceover, music, fonts) into a project. " +
			"`uploadUrl` is for you: if you can run commands and have the files locally, upload each one with no sign-in: " +
			'`curl -T <file> "<uploadUrl>&name=<file name>"` (add `&tags=logo,reference` or `&description=…` as wanted); each upload returns the new asset. ' +
			"`pageUrl` is for the person you are working with: they open it in their browser, signed in to Retween, and drop files in; ask them to say when they are done, then find the files with asset.list. " +
			"Files over 90 MB (most phone footage) must go up in parts: POST `multipart.startUrl` with JSON `{name, bytes}`, PUT each `partSize` slice of the file to `partUrl` (part numbers from 1), " +
			"then POST the returned etags to `completeUrl` (see `multipart.steps`). The Retween CLI (`retween upload <file> --project <id>`) does this by itself. " +
			"The upload URL works until it expires and can only add files to this project, so do not share it more widely than needed.",
		input: z.object({
			projectId,
			expiresInMinutes: z.number().int().min(5).max(24 * 60).default(60).describe("How long the upload URL keeps working"),
		}),
		readOnly: true,
		handler: async (input, { actor }) => {
			const project = await getProject(actor, input.projectId);
			const upload = await signedUploadUrl(project.id, actor.id, input.expiresInMinutes * 60);
			return {
				uploadUrl: upload.url,
				expiresAt: upload.expiresAt.toISOString(),
				example: `curl -T logo.png "${upload.url}&name=logo.png&tags=logo"`,
				pageUrl: `${env.APP_URL}/projects/${encodeURIComponent(project.id)}/assets`,
				accepts: "Images, video, audio and fonts. Name each file with its extension so its type is clear.",
				multipart: multipartHelp(upload.url),
			};
		},
	}),

	defineOp({
		name: "asset.import_url",
		title: "Import from URL",
		description:
			"Download an image, video, audio or font file, or a Lottie animation (the .json file, e.g. from lottiefiles.com), from a public URL into the project. " +
			"A Lottie asset can then be a scene's visual (source \"asset\"); it plays over the brand backdrop. " +
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
			const allowed = await enforceControls(actor.id, spec);
			const asset = await createAsset({
				projectId: project.id,
				createdBy: actor.id,
				kind: "image",
				name: input.name ?? input.prompt.slice(0, 80),
				source: "generated",
				tags: input.tags,
				meta: { prompt: input.prompt },
				generation: allowed,
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
				generation: await enforceControls(actor.id, {
					type: "video",
					prompt: style ? `${input.prompt}\n\nStyle: ${style}` : input.prompt,
					seconds: input.seconds,
					aspectRatio: input.aspectRatio,
					resolution: input.resolution,
					firstFrameAssetId: input.firstFrameAssetId,
					withAudio: input.withAudio,
				}),
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
				generation: await enforceControls(actor.id, narrationSpec(project.brand, input.text, { voiceId: input.voiceId, speed: input.speed })),
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
				generation: await enforceControls(actor.id, { type: "music", prompt, seconds: input.seconds, instrumental: input.instrumental }),
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
				generation: await enforceControls(actor.id, { type: "sfx", prompt: input.prompt, seconds: input.seconds }),
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
			"Import a result with stock.import. Free stock is the cheapest way to fill a scene: reach for it before generating video. " +
			"Set preview to see the results as one numbered contact sheet, so you can pick by eye rather than by title.",
		input: z.object({
			query: z.string().min(2).max(200),
			media: z.enum(["image", "video", "audio"]).default("image"),
			orientation: z.enum(["landscape", "portrait", "square"]).optional(),
			provider: z.enum(STOCK_PROVIDERS).optional().describe("Search one source only"),
			limit: z.number().int().min(1).max(30).default(12),
			preview: z.boolean().default(false).describe("Also return the results' thumbnails as one numbered image (images and video; takes a few seconds)"),
		}),
		readOnly: true,
		handler: async ({ preview, ...query }, { actor }) => {
			const result = await searchStock(query);
			const shown = preview ? result.items.filter((item) => item.previewUrl) : [];
			const sheet = shown.length
				? await renderSheet(actor, {
						storeAs: `users/${actor.id}/previews/stock`,
						tiles: shown.map((item, i) => ({ kind: "image" as const, src: item.previewUrl!, label: `${i + 1}. ${item.provider} · ${item.title}` })),
						tileHeight: 180,
						maxWidth: 1600,
						quality: 75,
					})
				: null;
			return {
				results: result.items.map((item) => ({
					...(sheet ? { n: shown.indexOf(item) + 1 || undefined } : {}),
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
				sources: { available: availableProviders(query.media) },
				...(sheet ? { previewSheet: sheet.url, [INLINE_IMAGE]: { base64: bytesToBase64(sheet.bytes), mimeType: sheet.contentType } } : {}),
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
		name: "icon.search",
		title: "Search icons",
		description:
			"Find icons for scenes (text.icon, or an icon per bullet) among 200+ open-source Iconify sets. Free. " +
			"Use the returned name as is (\"lucide:rocket\"). Keep to one set per video so the style stays consistent: " +
			"the brand kit's visual.iconSet is used for names written without a prefix (lucide by default). " +
			"Glyph sets take the scene's colours; multi-colour sets (palette: true, e.g. emoji) keep their own.",
		input: z.object({
			query: z.string().min(2).max(100).describe("What the icon shows, in English: rocket, shield check, growth chart"),
			sets: z.array(z.string().max(40)).max(10).optional().describe('Only these icon sets, e.g. ["lucide"] or ["ph", "tabler"]'),
			limit: z.number().int().min(1).max(64).default(24),
		}),
		readOnly: true,
		handler: async (input) => {
			const { icons, sets } = await searchIcons({ query: input.query, prefixes: input.sets, limit: input.limit });
			return {
				icons: icons.map((name) => {
					const [prefix, icon] = name.split(":");
					return { name, previewUrl: `https://api.iconify.design/${prefix}/${icon}.svg?height=96` };
				}),
				sets: sets.map((set) => ({ prefix: set.prefix, name: set.name, license: set.license?.title, palette: set.palette, category: set.category })),
			};
		},
	}),

	defineOp({
		name: "place.search",
		title: "Find a place",
		description:
			"Look up the coordinates of a city, landmark or address (OpenStreetMap) for a map scene. " +
			"Use the lat/lng of the best match; give the place a short display name of your own in the scene.",
		input: z.object({
			query: z.string().min(2).max(200).describe('e.g. "Lisbon", "Eiffel Tower", "1 Infinite Loop, Cupertino"'),
			limit: z.number().int().min(1).max(10).default(5),
		}),
		readOnly: true,
		handler: async (input) => ({ places: await searchPlaces(input.query, input.limit) }),
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

