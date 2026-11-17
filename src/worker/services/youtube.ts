/**
 * YouTube channels a person has connected, and the uploads made to them.
 *
 * Connecting is a browser flow (GET /api/youtube/connect → Google →
 * /api/youtube/callback) that needs a signed-in session, so a link minted for
 * one account can never attach a channel to another. Tokens are encrypted at
 * rest with a key derived from the auth secret.
 */
import { env } from "cloudflare:workers";
import { and, desc, eq } from "drizzle-orm";
import { collectAssetRefs, type Timeline } from "../../../shared/timeline.ts";
import type { Actor } from "../auth/index.ts";
import { db, schema } from "../db/client.ts";
import { AppError, base64Url, bytesToBase64, base64ToBytes, newId, notFound } from "../lib/util.ts";
import { type ChannelInfo, type GoogleTokens, ReconnectNeeded, refreshAccessToken } from "../providers/youtube.ts";
import { assetsById } from "./assets.ts";

export type YoutubeChannel = typeof schema.youtubeChannels.$inferSelect;
export type YoutubeUpload = typeof schema.youtubeUploads.$inferSelect;

// ------------------------------------------------------------ secrets

const keys = new Map<string, Promise<CryptoKey>>();
function derivedKey(purpose: string, algorithm: "AES-GCM" | "HMAC"): Promise<CryptoKey> {
	const cacheKey = `${purpose}:${algorithm}`;
	let key = keys.get(cacheKey);
	if (!key) {
		key = crypto.subtle
			.digest("SHA-256", new TextEncoder().encode(`${purpose}:${env.BETTER_AUTH_SECRET}`))
			.then((raw) =>
				algorithm === "AES-GCM"
					? crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"])
					: crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]),
			);
		keys.set(cacheKey, key);
	}
	return key;
}

async function encrypt(plain: string): Promise<string> {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await derivedKey("retween-youtube-token", "AES-GCM"), new TextEncoder().encode(plain));
	return `v1.${bytesToBase64(iv)}.${bytesToBase64(new Uint8Array(sealed))}`;
}

async function decrypt(sealed: string): Promise<string> {
	const [version, iv, data] = sealed.split(".");
	if (version !== "v1" || !iv || !data) throw new Error("Unreadable stored token");
	const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64ToBytes(iv) as BufferSource }, await derivedKey("retween-youtube-token", "AES-GCM"), base64ToBytes(data) as BufferSource);
	return new TextDecoder().decode(plain);
}

/** OAuth `state`: which signed-in user started the flow, signed and short-lived. */
export async function connectState(userId: string): Promise<string> {
	const payload = base64Url.encode(JSON.stringify({ u: userId, n: crypto.randomUUID(), e: Math.floor(Date.now() / 1000) + 900 }));
	const signature = await crypto.subtle.sign("HMAC", await derivedKey("retween-youtube-state", "HMAC"), new TextEncoder().encode(payload));
	return `${payload}.${bytesToBase64(new Uint8Array(signature)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}

/** The user id inside a valid, unexpired state; null otherwise. */
export async function readConnectState(state: string): Promise<string | null> {
	const [payload, signature] = state.split(".");
	if (!payload || !signature) return null;
	try {
		const valid = await crypto.subtle.verify(
			"HMAC",
			await derivedKey("retween-youtube-state", "HMAC"),
			base64ToBytes(signature.replace(/-/g, "+").replace(/_/g, "/")) as BufferSource,
			new TextEncoder().encode(payload),
		);
		if (!valid) return null;
		const { u, e } = JSON.parse(base64Url.decode(payload)) as { u: string; e: number };
		return e > Date.now() / 1000 ? u : null;
	} catch {
		return null;
	}
}

// ----------------------------------------------------------- channels

/** Stores (or refreshes) a connection after the person granted access. */
export async function saveChannel(userId: string, tokens: GoogleTokens, channel: ChannelInfo): Promise<YoutubeChannel> {
	if (!tokens.refreshToken) throw new AppError(422, "Google did not grant offline access. Try connecting again.", "youtube_no_refresh_token");
	const values = {
		title: channel.title,
		handle: channel.handle ?? null,
		thumbnailUrl: channel.thumbnailUrl ?? null,
		refreshToken: await encrypt(tokens.refreshToken),
		accessToken: await encrypt(tokens.accessToken),
		accessTokenExpiresAt: tokens.expiresAt,
		scope: tokens.scope ?? null,
		status: "active" as const,
	};
	const [row] = await db
		.insert(schema.youtubeChannels)
		.values({ id: newId("ytc"), userId, channelId: channel.channelId, ...values })
		.onConflictDoUpdate({ target: [schema.youtubeChannels.userId, schema.youtubeChannels.channelId], set: values })
		.returning();
	return row!;
}

export const listChannels = (userId: string) =>
	db.query.youtubeChannels.findMany({ where: eq(schema.youtubeChannels.userId, userId), orderBy: desc(schema.youtubeChannels.createdAt) });

/** One of the actor's channels, by our id (ytc_…) or YouTube's (UC…). With no id, the only connected channel. */
export async function resolveChannel(actor: Actor, channel?: string): Promise<YoutubeChannel> {
	const channels = await listChannels(actor.id);
	if (!channels.length) {
		throw new AppError(409, "No YouTube channel is connected. Call youtube.connect and open the link it returns.", "youtube_not_connected");
	}
	if (!channel) {
		if (channels.length > 1) {
			throw new AppError(400, `Several channels are connected; say which with channel: ${channels.map((c) => `${c.id} (${c.title})`).join(", ")}`, "bad_request");
		}
		return channels[0]!;
	}
	const found = channels.find((candidate) => candidate.id === channel || candidate.channelId === channel);
	if (!found) throw notFound("YouTube channel");
	return found;
}

/** A usable access token, refreshing it when it has expired. */
export async function accessTokenFor(channel: YoutubeChannel): Promise<string> {
	if (channel.status === "reconnect") throw new ReconnectNeeded(`Access to "${channel.title}" has lapsed. Connect it again with youtube.connect.`);
	if (channel.accessToken && channel.accessTokenExpiresAt && channel.accessTokenExpiresAt > new Date()) {
		return decrypt(channel.accessToken);
	}
	try {
		const tokens = await refreshAccessToken(await decrypt(channel.refreshToken));
		await db
			.update(schema.youtubeChannels)
			.set({
				accessToken: await encrypt(tokens.accessToken),
				accessTokenExpiresAt: tokens.expiresAt,
				// Google may rotate the refresh token.
				...(tokens.refreshToken ? { refreshToken: await encrypt(tokens.refreshToken) } : {}),
			})
			.where(eq(schema.youtubeChannels.id, channel.id));
		return tokens.accessToken;
	} catch (error) {
		if (error instanceof ReconnectNeeded) {
			await db.update(schema.youtubeChannels).set({ status: "reconnect", accessToken: null }).where(eq(schema.youtubeChannels.id, channel.id));
			throw new ReconnectNeeded(`Access to "${channel.title}" has lapsed. Connect it again with youtube.connect.`);
		}
		throw error;
	}
}

/** The stored refresh token, for revoking on disconnect. */
export const refreshTokenOf = (channel: YoutubeChannel) => decrypt(channel.refreshToken);

export function channelView(channel: YoutubeChannel) {
	return {
		id: channel.id,
		channelId: channel.channelId,
		title: channel.title,
		handle: channel.handle ?? undefined,
		url: channel.handle ? `https://www.youtube.com/${channel.handle}` : `https://www.youtube.com/channel/${channel.channelId}`,
		thumbnailUrl: channel.thumbnailUrl ?? undefined,
		needsReconnect: channel.status === "reconnect" || undefined,
		connectedAt: channel.createdAt,
	};
}

// ------------------------------------------------------------ uploads

export async function getUpload(actor: Actor, uploadId: string): Promise<YoutubeUpload> {
	const upload = await db.query.youtubeUploads.findFirst({ where: eq(schema.youtubeUploads.id, uploadId) });
	if (!upload || (upload.userId !== actor.id && !actor.isAdmin)) throw notFound("YouTube upload");
	return upload;
}

export const uploadsForVideo = (actor: Actor, videoId: string) =>
	db.query.youtubeUploads.findMany({
		where: and(eq(schema.youtubeUploads.videoId, videoId), actor.isAdmin ? undefined : eq(schema.youtubeUploads.userId, actor.id)),
		orderBy: desc(schema.youtubeUploads.createdAt),
		limit: 50,
	});

export function uploadView(upload: YoutubeUpload) {
	const id = upload.youtubeVideoId;
	return {
		id: upload.id,
		videoId: upload.videoId,
		renderId: upload.renderId,
		channel: { id: upload.connectionId ?? undefined, channelId: upload.channelId, title: upload.channelTitle },
		status: upload.status,
		progress: upload.progress,
		title: upload.request.title,
		privacy: upload.request.privacy,
		publishAt: upload.request.publishAt,
		youtubeVideoId: id ?? undefined,
		/** Works once YouTube has processed the upload; private videos open only for the channel owner. */
		url: id ? `https://www.youtube.com/watch?v=${id}` : undefined,
		studioUrl: id ? `https://studio.youtube.com/video/${id}/edit` : undefined,
		error: upload.error ?? undefined,
		warnings: upload.warnings.length ? upload.warnings : undefined,
		createdAt: upload.createdAt,
		finishedAt: upload.finishedAt ?? undefined,
	};
}

// -------------------------------------------------- what goes with it

const srtTime = (seconds: number) => {
	const ms = Math.max(0, Math.round(seconds * 1000));
	const pad = (n: number, width = 2) => String(n).padStart(width, "0");
	return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor(ms / 60_000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
};

/** The rendered video's captions as SRT, timed to the recorded narration. Empty when there is no narration. */
export function captionsSrt(timeline: Timeline): string {
	return timeline.captions
		.filter((caption) => caption.text.trim() && caption.endFrame > caption.startFrame)
		.map((caption, i) => `${i + 1}\n${srtTime(caption.startFrame / timeline.fps)} --> ${srtTime(caption.endFrame / timeline.fps)}\n${caption.text.trim()}\n`)
		.join("\n");
}

/** Credit lines owed for third-party media in exactly what was rendered. */
export async function creditsFor(projectId: string, timeline: Timeline): Promise<string[]> {
	const assets = await assetsById(projectId, collectAssetRefs(timeline));
	return [...assets.values()]
		.filter((asset) => asset.license?.attributionRequired)
		.map((asset) => asset.license!.attribution ?? `${asset.name} (${asset.license!.license})`);
}

/** YouTube rejects angle brackets in titles and descriptions. */
export const youtubeSafe = (text: string) => text.replace(/</g, "‹").replace(/>/g, "›");

const utf8Length = (text: string) => new TextEncoder().encode(text).length;

/** Description with credits appended, kept inside YouTube's 5,000-byte limit. */
export function composeDescription(description: string, credits: string[]): string {
	const body = youtubeSafe(description.trim());
	if (!credits.length) return body;
	const block = `Credits:\n${credits.map((line) => youtubeSafe(line)).join("\n")}`;
	const full = body ? `${body}\n\n${block}` : block;
	if (utf8Length(full) > 5000) {
		throw new AppError(400, "The description plus the required credits is longer than YouTube's 5,000-byte limit. Shorten the description.", "bad_request");
	}
	return full;
}
