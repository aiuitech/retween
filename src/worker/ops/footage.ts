/**
 * Operations on a person's own recordings: process them, read what was said,
 * and look at them. Cutting them into a video happens in the storyboard: a
 * scene's `footage` names a stretch by quoting it (see shared/footage.ts).
 */
import { z } from "zod";
import { AppError, bytesToBase64 } from "../lib/util.ts";
import { getAsset } from "../services/assets.ts";
import { footageCostUsd, footageFrames, footageOf, footageSummary, footageTranscript, startFootage, waitForFootage } from "../services/footage.ts";
import { renderSheet } from "../services/inspect.ts";
import { signedUrl } from "../services/storage.ts";
import { INLINE_IMAGE, defineOp, waitSeconds } from "./registry.ts";

const assetId = z.string().describe("The video or recording (ast_…)");

export const footageOps = [
	defineOp({
		name: "footage.process",
		title: "Process footage",
		description:
			"Prepare a recording of the person (a phone video of them talking, a voice memo, an interview) for editing: it is converted to a steady, upright H.264 edit master, " +
			"its sound is levelled into a voice track, shot changes and silences are found, and the speech is transcribed with word timings and speakers. " +
			"Uploaded videos are processed automatically; call this for audio, imported video, or to redo it with a language, key terms (names, jargon) or noise reduction. " +
			`Costs about $${footageCostUsd(3600)} an hour of recording. Then read it with footage.transcript, look at it with footage.view, and cut it into scenes with a scene's footage field.`,
		input: z.object({
			assetId,
			language: z.string().min(2).max(3).optional().describe("ISO 639 code, e.g. en. Detected when left out"),
			keyterms: z.array(z.string().min(1).max(50)).max(100).optional().describe("Names, products and jargon that are said, so they are spelled right"),
			speakers: z.number().int().min(1).max(32).optional().describe("How many people speak, if known"),
			denoise: z.boolean().optional().describe("Light noise reduction on the voice (for noisy rooms or wind)"),
			wait: waitSeconds,
		}),
		paid: true,
		handler: async (input, { actor }) => {
			const { asset } = await getAsset(actor, input.assetId);
			const { wait, assetId: _id, ...options } = input;
			await startFootage(asset, actor, options);
			const done = await waitForFootage(asset.id, wait);
			return { ...footageSummary(done), estimatedCostUsd: footageCostUsd((asset.durationMs ?? 0) / 1000, options) };
		},
	}),

	defineOp({
		name: "footage.get",
		title: "Footage status",
		description:
			"Where processing of a recording stands and what it holds: length, picture, loudness as recorded, and the size of its transcript (words, speakers, paragraphs, likely retakes and filler words).",
		input: z.object({ assetId, wait: waitSeconds.default(0) }),
		readOnly: true,
		handler: async (input, { actor }) => {
			await getAsset(actor, input.assetId);
			return footageSummary(await waitForFootage(input.assetId, input.wait));
		},
	}),

	defineOp({
		name: "footage.transcript",
		title: "Read footage",
		description:
			"What is said in a recording, with times, to write a script from or to choose what to cut. paragraphs (default): timed paragraphs by speaker, " +
			"with marks for likely retakes (a sentence started again: drop the first attempt), filler words, long pauses and shot changes. " +
			"srt: subtitles. words: every word with its start and end. search: where some words are said. Times are seconds into the recording. " +
			'To use a stretch in the video, quote its first and last words in a scene: footage { assetId, from: "so here is the thing", to: "every single time" }.',
		input: z.object({
			assetId,
			format: z.enum(["paragraphs", "srt", "words"]).default("paragraphs"),
			fromSec: z.number().min(0).optional(),
			toSec: z.number().min(0).optional(),
			search: z.string().min(1).max(200).optional().describe("Find where these words are said instead"),
			maxParagraphs: z.number().int().min(1).max(500).default(150),
		}),
		readOnly: true,
		handler: async (input, { actor }) => {
			const { asset } = await getAsset(actor, input.assetId);
			return footageTranscript(asset, input);
		},
	}),

	defineOp({
		name: "footage.view",
		title: "Look at footage",
		description:
			"Frames from a recording on one contact sheet, each labelled with its time and what is being said, so you can see what is on screen while choosing cuts: " +
			"framing, where the face is (for focus when cropping to other aspect ratios), gestures, things shown to camera, and b-roll moments. " +
			"By default one frame per paragraph of speech; or one per shot, evenly spaced, or at the times you give.",
		input: z.object({
			assetId,
			fromSec: z.number().min(0).optional(),
			toSec: z.number().min(0).optional(),
			by: z.enum(["paragraphs", "shots", "even"]).optional(),
			at: z.array(z.number().min(0)).max(32).optional().describe("Exact times to show, in seconds"),
			count: z.number().int().min(1).max(32).default(12),
		}),
		readOnly: true,
		handler: async (input, { actor }) => {
			const { asset, project } = await getAsset(actor, input.assetId);
			if (asset.kind !== "video") throw new AppError(422, `This is ${asset.kind === "audio" ? "a sound recording" : `a ${asset.kind}`}; there is nothing to look at. Read it with footage.transcript.`, "unsupported_media");
			if (asset.status !== "ready" || !asset.r2Key) throw new AppError(409, "This video is still uploading", "not_ready");
			const footage = footageOf(asset);
			const frames = footageFrames(asset, input);
			const src = await signedUrl(asset.r2Key, { expiresIn: 1800 });
			const portrait = (asset.height ?? 0) > (asset.width ?? 0);
			const sheet = await renderSheet(actor, {
				storeAs: `projects/${project.id}/previews/${asset.id}`,
				tiles: frames.map((frame) => ({ kind: "video" as const, src, atSec: frame.atSec, label: frame.label.slice(0, 70) })),
				tileHeight: portrait ? 300 : 200,
				maxWidth: 1600,
			});
			const failed = Object.entries(sheet.failed).map(([index, reason]) => ({ tile: Number(index) + 1, reason }));
			return {
				assetId: asset.id,
				frames: frames.map((frame, i) => ({ tile: i + 1, ...frame })),
				...(footage?.status !== "ready" ? { note: footage?.status === "processing" ? "Still processing: frames are from the upload and may be slow, sideways or missing." : "Not processed: labels have no speech. footage.process adds a transcript." } : {}),
				...(failed.length ? { failed } : {}),
				url: sheet.url,
				[INLINE_IMAGE]: { base64: bytesToBase64(sheet.bytes), mimeType: sheet.contentType },
			};
		},
	}),
];
