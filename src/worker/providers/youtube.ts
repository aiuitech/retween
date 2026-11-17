/**
 * Google OAuth and the YouTube Data API v3, over plain HTTP.
 *
 * One scope, youtube.force-ssl, covers everything publishing needs: uploads,
 * captions, playlists, thumbnails and reading the channel. (youtube.upload
 * alone cannot add captions or playlist items.)
 *
 * Uses the same Google OAuth client as sign-in; its redirect URIs must include
 * `${APP_URL}/api/youtube/callback`, and the project must have the YouTube
 * Data API enabled.
 */
import { env } from "cloudflare:workers";
import { AppError } from "../lib/util.ts";

export const YOUTUBE_SCOPE = "https://www.googleapis.com/auth/youtube.force-ssl";
const API = "https://www.googleapis.com/youtube/v3";
const UPLOAD_API = "https://www.googleapis.com/upload/youtube/v3";

export const redirectUri = () => `${env.APP_URL}/api/youtube/callback`;

/** Where to send the browser to ask for access. `prompt=consent` makes Google return a refresh token every time. */
export function authorizationUrl(state: string): string {
	const params = new URLSearchParams({
		client_id: env.GOOGLE_CLIENT_ID,
		redirect_uri: redirectUri(),
		response_type: "code",
		scope: YOUTUBE_SCOPE,
		access_type: "offline",
		prompt: "consent select_account",
		state,
	});
	return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

export interface GoogleTokens {
	accessToken: string;
	expiresAt: Date;
	refreshToken?: string;
	scope?: string;
}

/** Raised when Google no longer accepts a refresh token; the person has to connect again. */
export class ReconnectNeeded extends AppError {
	constructor(message = "YouTube access was revoked or has expired. Connect the channel again with youtube.connect.") {
		super(409, message, "youtube_reconnect");
	}
}

async function tokenRequest(body: Record<string, string>): Promise<GoogleTokens> {
	const response = await fetch("https://oauth2.googleapis.com/token", {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, ...body }),
	});
	const json = (await response.json().catch(() => ({}))) as {
		access_token?: string;
		expires_in?: number;
		refresh_token?: string;
		scope?: string;
		error?: string;
		error_description?: string;
	};
	if (json.error === "invalid_grant") {
		throw body.grant_type === "authorization_code"
			? new AppError(422, "Google's sign-in code expired or was already used. Start connecting again.", "youtube_code_expired")
			: new ReconnectNeeded();
	}
	if (!response.ok || !json.access_token) {
		const status = response.status >= 500 || response.status === 429 ? 502 : 422;
		throw new AppError(status, `Google sign-in error: ${json.error_description ?? json.error ?? response.status}`, "upstream_error");
	}
	return {
		accessToken: json.access_token,
		// A minute of slack so a token is never used at the edge of its life.
		expiresAt: new Date(Date.now() + ((json.expires_in ?? 3600) - 60) * 1000),
		refreshToken: json.refresh_token,
		scope: json.scope,
	};
}

export const exchangeCode = (code: string) => tokenRequest({ code, grant_type: "authorization_code", redirect_uri: redirectUri() });
export const refreshAccessToken = (refreshToken: string) => tokenRequest({ refresh_token: refreshToken, grant_type: "refresh_token" });

/** Best effort: tells Google to forget the grant. */
export async function revokeToken(token: string): Promise<void> {
	await fetch("https://oauth2.googleapis.com/revoke", {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ token }),
	}).catch(() => undefined);
}

/** Reads a YouTube API error into one line, mapping the cases worth explaining. */
export async function youtubeError(response: Response): Promise<AppError> {
	const body = (await response.json().catch(() => null)) as { error?: { message?: string; errors?: { reason?: string; message?: string }[] } } | null;
	const reason = body?.error?.errors?.[0]?.reason ?? "";
	const message = (body?.error?.message ?? response.statusText).replace(/<[^>]*>/g, "");
	if (response.status === 401) return new ReconnectNeeded();
	if (reason === "quotaExceeded" || reason === "rateLimitExceeded" || reason === "userRateLimitExceeded") {
		return new AppError(429, "YouTube's daily API quota for Retween is used up. Try again after midnight Pacific time.", "youtube_quota", { reason });
	}
	if (reason === "uploadLimitExceeded") {
		return new AppError(429, "This channel has reached YouTube's upload limit for now. Try again later.", "youtube_upload_limit", { reason });
	}
	if (reason === "youtubeSignupRequired") {
		return new AppError(409, "This Google account has no YouTube channel yet. Create one on youtube.com, then connect again.", "youtube_no_channel", { reason });
	}
	const status = response.status >= 500 || response.status === 429 ? 502 : 422;
	return new AppError(status, `YouTube error (${response.status}${reason ? `, ${reason}` : ""}): ${message}`, "upstream_error", { reason });
}

const bearer = (accessToken: string) => ({ authorization: `Bearer ${accessToken}` });

export interface ChannelInfo {
	channelId: string;
	title: string;
	handle?: string;
	thumbnailUrl?: string;
}

/** The channel the token was granted for. Google asks the person to pick one when they own several. */
export async function myChannel(accessToken: string): Promise<ChannelInfo> {
	const response = await fetch(`${API}/channels?part=snippet&mine=true`, { headers: bearer(accessToken) });
	if (!response.ok) throw await youtubeError(response);
	const json = (await response.json()) as {
		items?: { id: string; snippet: { title: string; customUrl?: string; thumbnails?: Record<string, { url: string }> } }[];
	};
	const channel = json.items?.[0];
	if (!channel) throw new AppError(409, "This Google account has no YouTube channel yet. Create one on youtube.com, then connect again.", "youtube_no_channel");
	const thumbs = channel.snippet.thumbnails ?? {};
	return {
		channelId: channel.id,
		title: channel.snippet.title,
		handle: channel.snippet.customUrl,
		thumbnailUrl: (thumbs.medium ?? thumbs.default ?? Object.values(thumbs)[0])?.url,
	};
}

/** The resource sent with an upload: snippet + status. */
export interface VideoResource {
	snippet: { title: string; description: string; tags?: string[]; categoryId: string; defaultLanguage?: string; defaultAudioLanguage?: string };
	status: {
		privacyStatus: "private" | "unlisted" | "public";
		publishAt?: string;
		selfDeclaredMadeForKids: boolean;
		containsSyntheticMedia: boolean;
		embeddable: boolean;
		license: "youtube";
	};
}

/** Opens a resumable upload session and returns its URI. */
export async function startUpload(accessToken: string, resource: VideoResource, bytes: number, notifySubscribers: boolean): Promise<string> {
	const params = new URLSearchParams({ uploadType: "resumable", part: "snippet,status", notifySubscribers: String(notifySubscribers) });
	const response = await fetch(`${UPLOAD_API}/videos?${params}`, {
		method: "POST",
		headers: {
			...bearer(accessToken),
			"content-type": "application/json; charset=UTF-8",
			"x-upload-content-length": String(bytes),
			"x-upload-content-type": "video/mp4",
		},
		body: JSON.stringify(resource),
	});
	if (!response.ok) throw await youtubeError(response);
	const location = response.headers.get("location");
	if (!location) throw new AppError(502, "YouTube did not return an upload session", "upstream_error");
	return location;
}

export interface UploadedVideo {
	id: string;
	privacyStatus?: string;
	uploadStatus?: string;
}

export type UploadProgress = { done: false; received: number } | { done: true; video: UploadedVideo };

/** `Range: bytes=0-N` → N + 1 bytes received; no header → nothing yet. */
const receivedFrom = (response: Response) => {
	const match = response.headers.get("range")?.match(/bytes=0-(\d+)/);
	return match ? Number(match[1]) + 1 : 0;
};

async function progressFrom(response: Response): Promise<UploadProgress> {
	if (response.status === 308) return { done: false, received: receivedFrom(response) };
	if (response.status === 200 || response.status === 201) {
		const video = (await response.json()) as { id: string; status?: { privacyStatus?: string; uploadStatus?: string } };
		return { done: true, video: { id: video.id, privacyStatus: video.status?.privacyStatus, uploadStatus: video.status?.uploadStatus } };
	}
	if (response.status === 404 || response.status === 410) {
		throw new AppError(422, "The YouTube upload session expired. Publish again to start over.", "youtube_session_expired");
	}
	throw await youtubeError(response);
}

/** Asks an upload session how much it has received (or for the finished video). */
export async function uploadStatus(accessToken: string, sessionUri: string, total: number): Promise<UploadProgress> {
	const response = await fetch(sessionUri, {
		method: "PUT",
		headers: { ...bearer(accessToken), "content-length": "0", "content-range": `bytes */${total}` },
	});
	return progressFrom(response);
}

/** Sends bytes [offset, offset + chunk.length) of a `total`-byte file. */
export async function uploadChunk(accessToken: string, sessionUri: string, chunk: ArrayBuffer, offset: number, total: number): Promise<UploadProgress> {
	const response = await fetch(sessionUri, {
		method: "PUT",
		headers: {
			...bearer(accessToken),
			"content-type": "video/mp4",
			"content-length": String(chunk.byteLength),
			"content-range": `bytes ${offset}-${offset + chunk.byteLength - 1}/${total}`,
		},
		body: chunk,
	});
	return progressFrom(response);
}

/** Uploads a caption track (SRT) for a video. Costs 400 quota units. */
export async function insertCaptions(accessToken: string, input: { videoId: string; language: string; name: string; srt: string }): Promise<void> {
	const boundary = `retween${crypto.randomUUID().replace(/-/g, "")}`;
	const snippet = JSON.stringify({ snippet: { videoId: input.videoId, language: input.language, name: input.name, isDraft: false } });
	const body =
		`--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${snippet}\r\n` +
		`--${boundary}\r\ncontent-type: application/octet-stream\r\n\r\n${input.srt}\r\n` +
		`--${boundary}--`;
	const response = await fetch(`${UPLOAD_API}/captions?uploadType=multipart&part=snippet`, {
		method: "POST",
		headers: { ...bearer(accessToken), "content-type": `multipart/related; boundary=${boundary}` },
		body,
	});
	if (!response.ok) throw await youtubeError(response);
}

/** Sets a custom thumbnail. The channel must be verified on YouTube for this to be allowed. */
export async function setThumbnail(accessToken: string, videoId: string, image: Uint8Array, contentType: string): Promise<void> {
	const response = await fetch(`${UPLOAD_API}/thumbnails/set?videoId=${encodeURIComponent(videoId)}&uploadType=media`, {
		method: "POST",
		headers: { ...bearer(accessToken), "content-type": contentType },
		body: image as BufferSource,
	});
	if (!response.ok) throw await youtubeError(response);
}

export async function addToPlaylist(accessToken: string, playlistId: string, videoId: string): Promise<void> {
	const response = await fetch(`${API}/playlistItems?part=snippet`, {
		method: "POST",
		headers: { ...bearer(accessToken), "content-type": "application/json" },
		body: JSON.stringify({ snippet: { playlistId, resourceId: { kind: "youtube#video", videoId } } }),
	});
	if (!response.ok) throw await youtubeError(response);
}

export interface LiveStatus {
	privacyStatus?: string;
	uploadStatus?: string;
	failureReason?: string;
	rejectionReason?: string;
	publishAt?: string;
	processingStatus?: string;
}

/** What YouTube currently says about a video. Null when it no longer exists (deleted on YouTube). */
export async function videoStatus(accessToken: string, videoId: string): Promise<LiveStatus | null> {
	const response = await fetch(`${API}/videos?part=status,processingDetails&id=${encodeURIComponent(videoId)}`, { headers: bearer(accessToken) });
	if (!response.ok) throw await youtubeError(response);
	const json = (await response.json()) as {
		items?: {
			status?: { privacyStatus?: string; uploadStatus?: string; failureReason?: string; rejectionReason?: string; publishAt?: string };
			processingDetails?: { processingStatus?: string };
		}[];
	};
	const item = json.items?.[0];
	if (!item) return null;
	return { ...item.status, processingStatus: item.processingDetails?.processingStatus };
}
