import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import type { BrandKit } from "../../../shared/brand.ts";
import type { Storyboard } from "../../../shared/storyboard.ts";
import type { AspectRatio, Resolution, Timeline } from "../../../shared/timeline.ts";
import { user } from "./auth-schema.ts";

export * from "./auth-schema.ts";

const createdAt = () =>
	integer("created_at", { mode: "timestamp_ms" })
		.notNull()
		.$defaultFn(() => new Date());
const updatedAt = () =>
	integer("updated_at", { mode: "timestamp_ms" })
		.notNull()
		.$defaultFn(() => new Date())
		.$onUpdateFn(() => new Date());

export const projects = sqliteTable(
	"projects",
	{
		id: text("id").primaryKey(),
		ownerId: text("owner_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		description: text("description"),
		brand: text("brand", { mode: "json" }).$type<BrandKit>().notNull().default({}),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(t) => [index("projects_owner_idx").on(t.ownerId)],
);

export const NOTE_KINDS = ["instruction", "guideline", "learning", "reference", "script", "idea"] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];

export const notes = sqliteTable(
	"notes",
	{
		id: text("id").primaryKey(),
		projectId: text("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "cascade" }),
		kind: text("kind").$type<NoteKind>().notNull().default("guideline"),
		title: text("title").notNull(),
		body: text("body").notNull(),
		/** Pinned notes are included in the project brief. */
		pinned: integer("pinned", { mode: "boolean" }).notNull().default(true),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(t) => [index("notes_project_idx").on(t.projectId)],
);

/** `animation` is a Lottie (Bodymovin JSON) file. */
export const ASSET_KINDS = ["image", "video", "audio", "font", "animation", "other"] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];
export const ASSET_SOURCES = ["upload", "url", "generated", "stock"] as const;
export type AssetSource = (typeof ASSET_SOURCES)[number];
export type AssetStatus = "pending" | "ready" | "failed";

export type { SpokenWord } from "../../../shared/narration.ts";
import type { SpokenWord } from "../../../shared/narration.ts";

export interface AssetMeta {
	/** What produced this asset: the prompt, script or search query. */
	prompt?: string;
	model?: string;
	provider?: string;
	/** Word-level timestamps for narration. */
	words?: SpokenWord[];
	/** The narration text as it was sent to the voice. */
	spokenText?: string;
	voiceId?: string;
	/** Hash of the inputs that produced this asset, used to skip regeneration. */
	inputHash?: string;
	[key: string]: unknown;
}

export interface AssetLicense {
	/** Where the media came from, e.g. pexels, openverse, wikimedia. */
	provider: string;
	/** Licence name, e.g. "Pexels License", "CC BY 4.0", "Public domain". */
	license: string;
	licenseUrl?: string;
	author?: string;
	sourceUrl?: string;
	attributionRequired: boolean;
	/** Ready-to-paste credit line. */
	attribution?: string;
}

/** What a pending asset is waiting on. Read by the asset workflow. */
export type GenerationSpec =
	| {
			type: "speech";
			text: string;
			pronunciations: { term: string; say: string }[];
			voiceId: string;
			modelId: string;
			settings: { stability?: number; similarity?: number; style?: number; speed?: number; speakerBoost?: boolean };
			language?: string;
	  }
	| { type: "image"; prompt: string; aspectRatio: string; quality: string; referenceAssetIds: string[]; transparent?: boolean; model?: string }
	/** A flat vector illustration (SVG). `colors` are hex values the illustration should favour. */
	| { type: "vector"; prompt: string; aspectRatio: string; colors: string[]; background?: string; pro: boolean }
	/** The main subject of an image asset, with its background removed. */
	| { type: "cutout"; sourceAssetId: string }
	| { type: "video"; prompt: string; seconds: number; aspectRatio: string; resolution: string; firstFrameAssetId?: string; withAudio: boolean; model?: string }
	| { type: "music"; prompt: string; seconds: number; instrumental: boolean }
	| { type: "sfx"; prompt: string; seconds?: number }
	| { type: "url"; url: string; headers?: Record<string, string> };

export const assets = sqliteTable(
	"assets",
	{
		id: text("id").primaryKey(),
		projectId: text("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "cascade" }),
		kind: text("kind").$type<AssetKind>().notNull(),
		name: text("name").notNull(),
		description: text("description"),
		/** Free-form labels such as logo, reference, music, narration, b-roll. */
		tags: text("tags", { mode: "json" }).$type<string[]>().notNull().default([]),
		status: text("status").$type<AssetStatus>().notNull().default("pending"),
		source: text("source").$type<AssetSource>().notNull(),
		r2Key: text("r2_key"),
		contentType: text("content_type"),
		bytes: integer("bytes"),
		width: integer("width"),
		height: integer("height"),
		durationMs: integer("duration_ms"),
		meta: text("meta", { mode: "json" }).$type<AssetMeta>().notNull().default({}),
		license: text("license", { mode: "json" }).$type<AssetLicense>(),
		generation: text("generation", { mode: "json" }).$type<GenerationSpec>(),
		error: text("error"),
		createdBy: text("created_by").notNull(),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(t) => [index("assets_project_idx").on(t.projectId, t.kind)],
);

export type VideoStatus = "draft" | "preparing" | "ready" | "failed";

export interface PipelineState {
	stage?: "assets" | "compose" | "render" | "done";
	message?: string;
	startedAt?: number;
	finishedAt?: number;
	error?: string;
	warnings?: string[];
	/** Asset generation progress while preparing. */
	total?: number;
	completed?: number;
}

/** Assets generated for a storyboard, keyed so unchanged scenes are not regenerated. */
export interface ResolvedMedia {
	/** scene id → narration asset */
	narration: Record<string, { assetId: string; hash: string }>;
	/** scene id → generated/stock visual asset */
	visual: Record<string, { assetId: string; hash: string }>;
	/** `${sceneId}:${index}` → generated sound effect */
	sfx: Record<string, { assetId: string; hash: string }>;
	music?: { assetId: string; hash: string };
	/** `prefix:name` → icon file. Missing on videos prepared before icons existed. */
	icons?: Record<string, { assetId: string; hash: string }>;
	/** scene id → the scene picture's subject, cut out */
	cutout?: Record<string, { assetId: string; hash: string }>;
}

export const videos = sqliteTable(
	"videos",
	{
		id: text("id").primaryKey(),
		projectId: text("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "cascade" }),
		title: text("title").notNull(),
		/** What the video is for: goal, audience, key message. */
		brief: text("brief"),
		/** The aspect ratio visuals are generated for. Other ratios crop from it. */
		aspect: text("aspect").$type<AspectRatio>().notNull().default("16:9"),
		status: text("status").$type<VideoStatus>().notNull().default("draft"),
		pipeline: text("pipeline", { mode: "json" }).$type<PipelineState>().notNull().default({}),
		storyboard: text("storyboard", { mode: "json" }).$type<Storyboard>().notNull(),
		resolved: text("resolved", { mode: "json" }).$type<ResolvedMedia>().notNull(),
		timeline: text("timeline", { mode: "json" }).$type<Timeline>(),
		/** Hash of the storyboard + media the current timeline was composed from. */
		composedFrom: text("composed_from"),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(t) => [index("videos_project_idx").on(t.projectId)],
);

export type RenderStatus = "queued" | "starting" | "rendering" | "uploading" | "done" | "failed" | "cancelled";

export const renders = sqliteTable(
	"renders",
	{
		id: text("id").primaryKey(),
		videoId: text("video_id")
			.notNull()
			.references(() => videos.id, { onDelete: "cascade" }),
		projectId: text("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "cascade" }),
		aspect: text("aspect").$type<AspectRatio>().notNull(),
		resolution: text("resolution").$type<Resolution>().notNull(),
		width: integer("width").notNull(),
		height: integer("height").notNull(),
		fps: integer("fps").notNull(),
		durationMs: integer("duration_ms"),
		status: text("status").$type<RenderStatus>().notNull().default("queued"),
		progress: integer("progress_pct").notNull().default(0),
		r2Key: text("r2_key"),
		bytes: integer("bytes"),
		error: text("error"),
		/** Things the renderer worked around, e.g. media it could not load. */
		warnings: text("warnings", { mode: "json" }).$type<string[]>().notNull().default([]),
		/** The exact timeline this render was made from. */
		timeline: text("timeline", { mode: "json" }).$type<Timeline>().notNull(),
		createdBy: text("created_by").notNull(),
		createdAt: createdAt(),
		startedAt: integer("started_at", { mode: "timestamp_ms" }),
		finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
	},
	(t) => [index("renders_video_idx").on(t.videoId), index("renders_project_idx").on(t.projectId)],
);

export type UsageKind = "image" | "video" | "speech" | "music" | "sfx" | "render";

export const usageEvents = sqliteTable(
	"usage_events",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		projectId: text("project_id"),
		kind: text("kind").$type<UsageKind>().notNull(),
		provider: text("provider").notNull(),
		model: text("model"),
		quantity: integer("quantity").notNull().default(0),
		unit: text("unit").notNull(),
		/** Cost in millionths of a US dollar. Provider-reported where possible, otherwise estimated. */
		costMicros: integer("cost_micros").notNull().default(0),
		estimated: integer("estimated", { mode: "boolean" }).notNull().default(false),
		ref: text("ref"),
		createdAt: createdAt(),
	},
	(t) => [index("usage_user_idx").on(t.userId, t.createdAt)],
);

/**
 * A YouTube channel a person has allowed Retween to publish to. Tokens are
 * encrypted at rest (see services/youtube.ts). One row per channel, so a
 * person can connect several, including brand-account channels.
 */
export const youtubeChannels = sqliteTable(
	"youtube_channels",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		/** YouTube's id for the channel (UC…). */
		channelId: text("channel_id").notNull(),
		title: text("title").notNull(),
		/** The channel's @handle, when it has one. */
		handle: text("handle"),
		thumbnailUrl: text("thumbnail_url"),
		refreshToken: text("refresh_token").notNull(),
		accessToken: text("access_token"),
		accessTokenExpiresAt: integer("access_token_expires_at", { mode: "timestamp_ms" }),
		scope: text("scope"),
		/** `reconnect` once Google stops accepting the refresh token (revoked, or the password changed). */
		status: text("status").$type<"active" | "reconnect">().notNull().default("active"),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(t) => [uniqueIndex("youtube_channels_user_channel_idx").on(t.userId, t.channelId)],
);

export const YOUTUBE_PRIVACY = ["private", "unlisted", "public"] as const;
export type YoutubePrivacy = (typeof YOUTUBE_PRIVACY)[number];

/** What was asked for when publishing. Read by the publish workflow. */
export interface YoutubePublishRequest {
	title: string;
	description: string;
	tags: string[];
	categoryId: string;
	privacy: YoutubePrivacy;
	publishAt?: string;
	madeForKids: boolean;
	containsSyntheticMedia: boolean;
	notifySubscribers: boolean;
	language?: string;
	captions: boolean;
	thumbnailAssetId?: string;
	playlistId?: string;
}

export type YoutubeUploadStatus = "queued" | "uploading" | "finishing" | "done" | "failed";

/** One render sent to one YouTube channel. Kept after a channel is disconnected, as history. */
export const youtubeUploads = sqliteTable(
	"youtube_uploads",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		projectId: text("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "cascade" }),
		videoId: text("video_id")
			.notNull()
			.references(() => videos.id, { onDelete: "cascade" }),
		renderId: text("render_id").notNull(),
		connectionId: text("connection_id").references(() => youtubeChannels.id, { onDelete: "set null" }),
		/** Snapshot of the channel, so history reads well after a disconnect. */
		channelId: text("channel_id").notNull(),
		channelTitle: text("channel_title").notNull(),
		status: text("status").$type<YoutubeUploadStatus>().notNull().default("queued"),
		progress: integer("progress_pct").notNull().default(0),
		request: text("request", { mode: "json" }).$type<YoutubePublishRequest>().notNull(),
		youtubeVideoId: text("youtube_video_id"),
		error: text("error"),
		/** Optional extras (captions, thumbnail, playlist) that did not work out. The upload itself succeeded. */
		warnings: text("warnings", { mode: "json" }).$type<string[]>().notNull().default([]),
		createdAt: createdAt(),
		startedAt: integer("started_at", { mode: "timestamp_ms" }),
		finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
	},
	(t) => [index("youtube_uploads_video_idx").on(t.videoId), index("youtube_uploads_user_idx").on(t.userId)],
);
