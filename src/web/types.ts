/** What the service's operations return, as the pages use them. */

export type ProjectRole = "owner" | "editor" | "viewer";

export interface ProjectRow {
	id: string;
	name: string;
	description?: string | null;
	brandName?: string;
	videos: number;
	assets: number;
	createdAt: string;
	updatedAt: string;
	/** What the signed-in person can do in it. */
	role: ProjectRole;
	/** Who owns it, when it is shared with the signed-in person. */
	owner?: { name: string; email: string };
}

export interface ProjectAccess {
	you: ProjectRole;
	owner: { userId: string; name: string; email: string; image: string | null } | null;
	members: { userId: string; name: string; email: string; image: string | null; role: "editor" | "viewer"; since: string }[];
	invites?: { id: string; email: string; role: "editor" | "viewer"; sentAt: string | null; expiresAt: string; expired: boolean; link: string }[];
}

export interface NotificationRow {
	id: string;
	kind: string;
	title: string;
	body?: string;
	link?: string;
	projectId?: string;
	read: boolean;
	emailed: boolean;
	createdAt: string;
}

export interface VideoRow {
	id: string;
	projectId: string;
	title: string;
	brief?: string;
	status: string;
	aspect: string;
	scenes: number;
	durationSec?: number;
	updatedAt: string;
	/** What the video has cost so far, as billed. Only video.list includes it. */
	chargeUsd?: number;
}

interface MediaState {
	status: string;
	assetId?: string;
	kind?: string;
	error?: string;
}

/** A storyboard scene, exactly as the service validates it. */
export type { Scene } from "../../shared/storyboard.ts";
import type { Scene } from "../../shared/storyboard.ts";

export interface VideoDetail extends VideoRow {
	pipeline: { stage?: string; message?: string; error?: string; warnings?: string[]; total?: number; completed?: number };
	spend: { chargeUsd: number; byKind: { kind: string; label: string; chargeUsd: number }[] };
	storyboard: { scenes: Scene[] };
	media: { scenes: { id: string; narration?: MediaState; visual?: MediaState; cutout?: MediaState }[] };
	timeline?: { stale: boolean; durationSec: number; scenes: { id: string; startSec: number; durationSec: number }[] };
}

export interface RenderRow {
	id: string;
	videoId: string;
	aspect: string;
	resolution: string;
	width: number;
	height: number;
	fps: number;
	status: string;
	progress: number;
	durationSec?: number;
	bytes?: number;
	error?: string;
	warnings?: string[];
	url?: string;
	downloadUrl?: string;
	posterUrl?: string;
	createdAt: string;
	finishedAt?: string;
}

export interface ReviewRow {
	reviewId: string;
	round: number;
	status: "open" | "submitted" | "closed" | "expired";
	verdict?: "approved" | "changes";
	summary?: string;
	reviewer?: string;
	submittedAt?: string;
	unread?: true;
	comments: number;
	reviewUrl?: string;
	cutSeconds?: number;
	expiresAt: string;
}

export interface ThumbnailInfo {
	thumbnail: { id: string; url?: string; description?: string; createdAt: string } | null;
	poster: { url: string; source: "thumbnail" | "render" } | null;
}

export const ASSET_KINDS = ["image", "video", "audio", "font", "animation"] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

export interface AssetRow {
	id: string;
	kind: AssetKind | "other";
	name: string;
	description?: string;
	tags: string[];
	status: string;
	source: string;
	contentType?: string;
	bytes?: number;
	width?: number;
	height?: number;
	durationSec?: number;
	prompt?: string;
	model?: string;
	license?: { license?: string; author?: string; sourceUrl?: string; attribution?: string };
	error?: string;
	footage?: { status: string; stage?: string; transcriptWords?: number; error?: string };
	url?: string;
	createdAt: string;
}

export const NOTE_KINDS = ["instruction", "guideline", "learning", "reference", "script", "idea"] as const;

export interface NoteRow {
	id: string;
	kind: (typeof NOTE_KINDS)[number];
	title: string;
	body: string;
	pinned: boolean;
	updatedAt: string;
}

export interface YoutubeUpload {
	id: string;
	renderId: string;
	channel: { title: string };
	status: string;
	progress: number;
	title: string;
	privacy: string;
	url?: string;
	studioUrl?: string;
	error?: string;
	createdAt: string;
}

export interface HostedVideo {
	id: string;
	renderId: string;
	status: string;
	enabled: boolean;
	title: string;
	description?: string;
	pageUrl: string;
	embedUrl: string;
	embedCode?: string;
	posterUrl?: string;
	width: number;
	height: number;
	durationSec?: number;
	captions?: string;
	allowedOrigins: string[];
	error?: string;
	warnings?: string[];
	createdAt: string;
}

export const ASPECTS = ["16:9", "9:16", "1:1", "4:5"] as const;
export const RESOLUTIONS = ["480p", "720p", "1080p", "1440p", "2160p"] as const;
