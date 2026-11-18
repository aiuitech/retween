/**
 * Large uploads in parts (R2 multipart), for files bigger than one Worker
 * request body can carry, such as phone footage.
 *
 *   start    → a pending asset and a signed token (no session needed after this)
 *   PUT part → each `partSize` slice of the file, in any order, retried freely
 *   complete → R2 joins the parts and the asset is measured and marked ready
 */
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { type Actor, actorById, assertActive } from "../auth/index.ts";
import { db, schema } from "../db/client.ts";
import { AppError, badRequest } from "../lib/util.ts";
import { type Asset, assetView, createAsset, finishStoredObject } from "./assets.ts";
import { afterUpload } from "./footage.ts";
import { getProject } from "./projects.ts";
import { type MultipartGrant, assetKey, contentTypeFor, extensionFor, kindFor, multipartToken, verifyMultipartToken } from "./storage.ts";

/** Every part but the last is exactly this size (R2 needs equal parts of at least 5 MiB). */
export const PART_BYTES = 64 * 1024 * 1024;
/** Files above this go in parts. A little under the smallest Worker request body limit (100 MB). */
export const MULTIPART_THRESHOLD = 90 * 1000 * 1000;
const MAX_BYTES = 4 * 1024 * 1024 * 1024;
const TOKEN_SECONDS = 24 * 3600;

export interface StartUpload {
	name: string;
	contentType?: string;
	bytes: number;
	tags?: string[] | string;
	description?: string;
}

/** Starts a multipart upload into a project. `base` is the origin the part and complete URLs are built on. */
export async function startMultipart(actor: Actor, projectId: string, input: StartUpload, base: string) {
	const project = await getProject(actor, projectId);
	const name = typeof input?.name === "string" && input.name.trim() ? input.name.trim().slice(0, 200) : "";
	if (!name) throw badRequest("Give the file's name, with its extension (e.g. talk.mov)");
	const bytes = Number(input.bytes);
	if (!Number.isInteger(bytes) || bytes <= 0) throw badRequest("Give the file's size in bytes as `bytes`");
	if (bytes > MAX_BYTES) throw new AppError(413, "Files can be at most 4 GB", "too_large");
	const contentType = contentTypeFor(input.contentType, name);
	const kind = kindFor(contentType);
	if (kind === "other") throw badRequest(`Unsupported file type "${contentType}". Upload images, video, audio or fonts.`);
	if (kind === "animation") throw badRequest("Lottie JSON is uploaded in one request (PUT the file), not in parts.");

	const tags = (Array.isArray(input.tags) ? input.tags : (input.tags ?? "").split(","))
		.map((tag) => String(tag).trim())
		.filter(Boolean)
		.slice(0, 20);
	const asset = await createAsset({
		projectId: project.id,
		createdBy: actor.id,
		kind,
		name,
		description: typeof input.description === "string" ? input.description.slice(0, 2000) : undefined,
		source: "upload",
		tags,
	});
	const key = assetKey(project.id, asset.id, extensionFor(contentType, name));
	const multipart = await env.MEDIA.createMultipartUpload(key, { httpMetadata: { contentType } });
	const token = await multipartToken(
		{ assetId: asset.id, projectId: project.id, userId: actor.id, key, uploadId: multipart.uploadId, partSize: PART_BYTES, bytes },
		TOKEN_SECONDS,
	);
	const parts = Math.ceil(bytes / PART_BYTES);
	const root = `${base}/api/uploads/multipart/${token}`;
	return {
		uploadId: token,
		assetId: asset.id,
		partSize: PART_BYTES,
		parts,
		/** PUT part N (1-based) here: bytes [(N-1)*partSize, N*partSize) of the file. */
		partUrl: `${root}/{partNumber}`,
		/** POST `{ parts: [{ partNumber, etag }] }` here when every part is in. */
		completeUrl: `${root}/complete`,
		expiresAt: new Date(Date.now() + TOKEN_SECONDS * 1000).toISOString(),
	};
}

/** The grant behind a token, with its owner still active and still owning the project. */
async function grantFor(token: string): Promise<{ grant: MultipartGrant; actor: Actor }> {
	const grant = await verifyMultipartToken(token);
	if (!grant) throw new AppError(403, "This upload has expired or the link is not valid. Start the upload again.", "invalid_link");
	const actor = await actorById(grant.userId, "upload-link");
	assertActive(actor);
	await getProject(actor, grant.projectId);
	return { grant, actor };
}

async function pendingAsset(grant: MultipartGrant): Promise<Asset> {
	const asset = await db.query.assets.findFirst({ where: eq(schema.assets.id, grant.assetId) });
	if (!asset) throw new AppError(410, "This upload was cancelled. Start it again.", "cancelled");
	return asset;
}

export async function uploadPart(token: string, partNumber: number, request: Request) {
	const { grant } = await grantFor(token);
	const parts = Math.ceil(grant.bytes / grant.partSize);
	if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > parts) {
		throw badRequest(`Part numbers run from 1 to ${parts} for this file`);
	}
	const expected = partNumber < parts ? grant.partSize : grant.bytes - grant.partSize * (parts - 1);
	const length = Number(request.headers.get("content-length"));
	if (!request.body || !Number.isFinite(length)) throw new AppError(411, "Send the part as the request body with a Content-Length", "length_required");
	if (length !== expected) {
		throw badRequest(`Part ${partNumber} must be exactly ${expected} bytes (bytes ${(partNumber - 1) * grant.partSize}–${(partNumber - 1) * grant.partSize + expected - 1} of the file); got ${length}`);
	}
	const asset = await pendingAsset(grant);
	if (asset.status === "ready") throw new AppError(409, "This upload is already complete", "invalid_state");
	const part = await env.MEDIA.resumeMultipartUpload(grant.key, grant.uploadId).uploadPart(partNumber, request.body.pipeThrough(new FixedLengthStream(length)));
	return { partNumber: part.partNumber, etag: part.etag };
}

export async function completeMultipart(token: string, input: { parts?: { partNumber: number; etag: string }[] }) {
	const { grant, actor } = await grantFor(token);
	const asset = await pendingAsset(grant);
	if (asset.status === "ready") return { asset: await assetView(asset) };
	const expected = Math.ceil(grant.bytes / grant.partSize);
	const parts = (Array.isArray(input?.parts) ? input.parts : [])
		.map((part) => ({ partNumber: Number(part?.partNumber), etag: String(part?.etag ?? "") }))
		.sort((a, b) => a.partNumber - b.partNumber);
	const missing = Array.from({ length: expected }, (_, i) => i + 1).filter((n) => !parts.some((part) => part.partNumber === n && part.etag));
	if (missing.length || parts.length !== expected) {
		throw badRequest(`Give every part's etag: expected parts 1–${expected}${missing.length ? `, missing ${missing.slice(0, 10).join(", ")}` : ""}`);
	}
	let object: R2Object;
	try {
		object = await env.MEDIA.resumeMultipartUpload(grant.key, grant.uploadId).complete(parts);
	} catch (error) {
		throw new AppError(400, `The parts could not be joined (${error instanceof Error ? error.message : error}). Upload any failed parts again, then complete.`, "invalid_parts");
	}
	if (object.size !== grant.bytes) {
		await env.MEDIA.delete(grant.key);
		throw badRequest(`The parts add up to ${object.size} bytes, not the ${grant.bytes} announced. Start the upload again.`);
	}
	const contentType = object.httpMetadata?.contentType ?? contentTypeFor(null, asset.name);
	const stored = await finishStoredObject(asset, grant.key, contentType, object.size);
	await afterUpload(stored, actor);
	return { asset: await assetView(stored) };
}

export async function abortMultipart(token: string) {
	const { grant } = await grantFor(token);
	const asset = await db.query.assets.findFirst({ where: eq(schema.assets.id, grant.assetId) });
	if (asset?.status === "ready") throw new AppError(409, "This upload is already complete; delete the asset instead", "invalid_state");
	await env.MEDIA.resumeMultipartUpload(grant.key, grant.uploadId)
		.abort()
		.catch(() => undefined);
	if (asset) await db.delete(schema.assets).where(eq(schema.assets.id, asset.id));
	return { aborted: grant.assetId };
}
