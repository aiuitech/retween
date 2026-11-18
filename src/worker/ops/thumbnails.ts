/**
 * Thumbnails: design a few, see them at feed size, keep one. The kept one is
 * published with the video and is its poster everywhere it is shown.
 */
import { z } from "zod";
import { ThumbnailDesign } from "../../../shared/thumbnail.ts";
import { badRequest, bytesToBase64 } from "../lib/util.ts";
import { assetView, assetsById } from "../services/assets.ts";
import { designThumbnails, noteLines, posterFor, saveThumbnail, setThumbnail } from "../services/thumbnails.ts";
import { getVideo } from "../services/videos.ts";
import { INLINE_IMAGE, defineOp, waitSeconds } from "./registry.ts";

const videoId = z.string().describe("Video id (vid_…)");

export const thumbnailOps = [
	defineOp({
		name: "thumbnail.design",
		title: "Design thumbnails",
		description:
			"Try up to three thumbnail designs at once and see each at full size and at the size people actually see it (a home feed, and the up-next column, " +
			"with the duration badge over the corner), with notes on what will not read. Drawn by the video's own renderer: brand fonts, colours and logo, " +
			"and pictures from the video's scenes (without their text), any image or clip asset, or a generated image (make one with asset.generate_image first). " +
			"What works at 168 px wide: one clear subject (a face or object, cut out with subject.fromPicture or a transparent asset), two to four words of headline that add to the title, high contrast. " +
			"Pass `choose` (a variant number) to make that one the video's thumbnail: it is saved as a 1280×720 image under 2 MB, published by youtube.publish and used as the video's poster. " +
			"Costs a few seconds of the preview renderer; a cut-out costs a fraction of a cent.",
		input: z.object({
			videoId,
			variants: z.array(ThumbnailDesign).min(1).max(3).describe("One to three designs to compare"),
			choose: z.number().int().min(1).max(3).optional().describe("Make this variant the video's thumbnail"),
			waitSeconds,
		}),
		handler: async (input, { actor }) => {
			const { video, project } = await getVideo(actor, input.videoId);
			if (input.choose && input.choose > input.variants.length) throw badRequest(`There is no variant ${input.choose}: only ${input.variants.length} were given`);
			const { sheet, variants } = await designThumbnails(actor, project, video, input.variants, input.waitSeconds);
			const chosen = input.choose ? await saveThumbnail(actor, project, video, input.variants[input.choose - 1]!, input.waitSeconds) : undefined;
			return {
				variants: variants.map((variant) => ({ n: variant.n, headline: variant.overlay.headline, subject: Boolean(variant.overlay.subject), notes: noteLines(variant.notes) })),
				url: sheet.url,
				...(chosen
					? { thumbnail: { ...(await assetView(chosen.asset, { url: true })), variant: input.choose }, note: "Saved as the video's thumbnail and poster. youtube.publish uses it unless told otherwise." }
					: { next: "Adjust and design again, or pass choose with the variant number to keep one." }),
				[INLINE_IMAGE]: { base64: bytesToBase64(sheet.bytes), mimeType: sheet.contentType },
			};
		},
	}),

	defineOp({
		name: "thumbnail.set",
		title: "Set the thumbnail",
		description:
			"Make an existing image asset (an uploaded thumbnail, say) the video's thumbnail and poster, or pass null to go back to none. " +
			"Says if YouTube will not take it as it is (over 2 MB, not 16:9, under 640 px wide).",
		input: z.object({ videoId, assetId: z.string().nullable() }),
		handler: async (input, { actor }) => {
			const { video, project } = await getVideo(actor, input.videoId);
			const notes = await setThumbnail(project, video, input.assetId);
			return { thumbnailAssetId: input.assetId, ...(notes.length ? { notes: noteLines(notes) } : {}) };
		},
	}),

	defineOp({
		name: "thumbnail.get",
		title: "Get the thumbnail",
		description: "The video's thumbnail, the design it was made from, and its poster (the thumbnail, or else the opening still of the latest export).",
		input: z.object({ videoId }),
		readOnly: true,
		handler: async (input, { actor }) => {
			const { video, project } = await getVideo(actor, input.videoId);
			const asset = video.thumbnailAssetId ? (await assetsById(project.id, [video.thumbnailAssetId])).get(video.thumbnailAssetId) : undefined;
			const poster = await posterFor(video);
			return {
				thumbnail: asset ? { ...(await assetView(asset, { url: true })), design: (asset.meta.thumbnail as { design?: unknown } | undefined)?.design } : null,
				poster: poster ?? null,
				...(asset ? {} : { note: "No thumbnail yet. Design one with thumbnail.design." }),
			};
		},
	}),
];
