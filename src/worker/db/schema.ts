import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import type { BrandKit } from "../../../shared/brand.ts";
import type { CostControls } from "../../../shared/controls.ts";
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
	/** The video whose preparation generated this asset, so what it cost is charged to that video. */
	videoId?: string;
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
			/** How the read should feel. Sent only to OpenRouter models that take direction (Gemini, OpenAI). */
			instructions?: string;
	  }
	| { type: "image"; prompt: string; aspectRatio: string; quality: string; referenceAssetIds: string[]; transparent?: boolean; model?: string }
	/** A flat vector illustration (SVG). `colors` are hex values the illustration should favour. */
	| { type: "vector"; prompt: string; aspectRatio: string; colors: string[]; background?: string; pro: boolean }
	/** The main subject of an image asset, with its background removed. */
	| { type: "cutout"; sourceAssetId: string }
	| { type: "video"; prompt: string; seconds: number; aspectRatio: string; resolution: string; firstFrameAssetId?: string; withAudio: boolean; model?: string }
	/** `model` is "elevenlabs" (or absent) or an OpenRouter music model such as google/lyria-3-pro-preview. */
	| { type: "music"; prompt: string; seconds: number; instrumental: boolean; model?: string }
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
	/** The pipeline workflow instance doing the work, so a new run or video.cancel can stop it. */
	instanceId?: string;
	/** What that run was started from (storyboard, brand and regenerate options). */
	inputHash?: string;
	/** The music bed is still being composed; the timeline is recomposed with it when it lands. */
	musicPending?: boolean;
	cancelled?: boolean;
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
	/**
	 * Media left out on purpose because the account's cost controls switched it
	 * off: `visual:<scene id>` or `sfx:<scene id>:<index>` → reason. Compose falls back instead of failing.
	 */
	withheld?: Record<string, string>;
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
		/** The chosen thumbnail (an image asset tagged `thumbnail`): published with the video and used as its poster. */
		thumbnailAssetId: text("thumbnail_asset_id"),
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
		/** A still of the opening, in this render's shape, taken by the render container when it finished: the player's poster frame. */
		posterKey: text("poster_key"),
		createdBy: text("created_by").notNull(),
		createdAt: createdAt(),
		startedAt: integer("started_at", { mode: "timestamp_ms" }),
		finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
	},
	(t) => [index("renders_video_idx").on(t.videoId), index("renders_project_idx").on(t.projectId)],
);

export type UsageKind = "image" | "video" | "speech" | "music" | "sfx" | "transcription" | "render" | "preview" | "footage" | "storage";

/**
 * How a usage event's cost was arrived at, from most to least exact:
 * - `vendor`: the vendor reported the charge for this request (OpenRouter `usage.cost`, fal's per-request billing).
 * - `metered`: billable units the vendor reported or we measured (ElevenLabs credits, container seconds,
 *   stored bytes) multiplied by our contracted rate in `services/pricing.ts`.
 * - `list`: a published list price for the request, used when neither is available.
 */
export type CostBasis = "vendor" | "metered" | "list";

export const usageEvents = sqliteTable(
	"usage_events",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		projectId: text("project_id"),
		/** The video the charge was made for: its prepared media and its renders. Empty for account-wide costs (storage, previews, footage). */
		videoId: text("video_id"),
		kind: text("kind").$type<UsageKind>().notNull(),
		provider: text("provider").notNull(),
		model: text("model"),
		quantity: integer("quantity").notNull().default(0),
		unit: text("unit").notNull(),
		/** Cost in millionths of a US dollar. Provider-reported where possible, otherwise estimated. */
		costMicros: integer("cost_micros").notNull().default(0),
		estimated: integer("estimated", { mode: "boolean" }).notNull().default(false),
		basis: text("basis").$type<CostBasis>().notNull().default("list"),
		/** Our id for what was produced: an asset, render or container run. */
		ref: text("ref"),
		/** The vendor's id for the request (OpenRouter generation, ElevenLabs request, fal request), for reconciling against invoices. */
		vendorRef: text("vendor_ref"),
		createdAt: createdAt(),
	},
	(t) => [index("usage_user_idx").on(t.userId, t.createdAt), index("usage_created_idx").on(t.createdAt), index("usage_video_idx").on(t.videoId)],
);

/** An account's cost controls (see shared/controls.ts). Only the fields the person changed are stored. */
export const accountControls = sqliteTable("account_controls", {
	userId: text("user_id")
		.primaryKey()
		.references(() => user.id, { onDelete: "cascade" }),
	controls: text("controls", { mode: "json" }).$type<Partial<CostControls>>().notNull().default({}),
	updatedAt: updatedAt(),
});

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

export const REVIEW_VERDICTS = ["approved", "changes"] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];
/** open: waiting for the person. submitted: they sent their notes. closed: replaced by a newer round, or withdrawn. */
export type ReviewStatus = "open" | "submitted" | "closed";

/** A scene as it was when a review was asked for, so comments map to scenes even after the storyboard changes. */
export interface ReviewScene {
	id: string;
	n: number;
	type: string;
	startSec: number;
	endSec: number;
	/** What is on screen or said, in a line. */
	summary: string;
}

/**
 * A request for a person to watch a cut and leave notes on it. The agent asks
 * (review.request) and hands over the link; the person comments on the review
 * page in the web app and submits; the agent reads the notes with review.get.
 * The link carries a token, so someone without a Retween account can review.
 */
export const reviews = sqliteTable(
	"reviews",
	{
		id: text("id").primaryKey(),
		videoId: text("video_id")
			.notNull()
			.references(() => videos.id, { onDelete: "cascade" }),
		projectId: text("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "cascade" }),
		/** The owner who asked for it. */
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		/** SHA-256 of the token in the review link. */
		tokenHash: text("token_hash").notNull(),
		/** 1 for the first review of a video, then counting up. */
		round: integer("round").notNull().default(1),
		status: text("status").$type<ReviewStatus>().notNull().default("open"),
		/** What the agent wants the person to look at. */
		ask: text("ask"),
		aspect: text("aspect").$type<AspectRatio>().notNull(),
		/** The draft cut being reviewed (R2 key) and the stretch of the video it covers. */
		draftId: text("draft_id"),
		mediaKey: text("media_key"),
		fromSec: real("from_sec").notNull().default(0),
		toSec: real("to_sec"),
		scenes: text("scenes", { mode: "json" }).$type<ReviewScene[]>().notNull().default([]),
		/** The timeline the cut was made from, so commented moments can be shown as they were seen. */
		timeline: text("timeline", { mode: "json" }).$type<Timeline>(),
		/** The finished export being reviewed, when it is one rather than a draft. */
		renderId: text("render_id"),
		/** The storyboard hash at the time, to tell whether a newer cut exists. */
		storyboardHash: text("storyboard_hash"),
		verdict: text("verdict").$type<ReviewVerdict>(),
		/** The person's overall note. */
		summary: text("summary"),
		reviewerName: text("reviewer_name"),
		submittedAt: integer("submitted_at", { mode: "timestamp_ms" }),
		/** When the agent last read the submitted notes. */
		readAt: integer("read_at", { mode: "timestamp_ms" }),
		expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(t) => [index("reviews_video_idx").on(t.videoId), index("reviews_project_idx").on(t.projectId, t.status)],
);

export const REVIEW_TAGS = ["cut", "too-slow", "too-fast", "wrong-picture", "mispronounced", "text", "sound", "love-it", "other"] as const;
export type ReviewTag = (typeof REVIEW_TAGS)[number];

export const reviewComments = sqliteTable(
	"review_comments",
	{
		id: text("id").primaryKey(),
		reviewId: text("review_id")
			.notNull()
			.references(() => reviews.id, { onDelete: "cascade" }),
		/** Seconds into the video (not the draft) the note is about, when it is about a moment. */
		atSec: real("at_sec"),
		sceneId: text("scene_id"),
		/** A point on the frame, 0–1 from the top-left, when the person clicked one. */
		x: real("x"),
		y: real("y"),
		tag: text("tag").$type<ReviewTag>(),
		body: text("body").notNull(),
		/** What the agent did about it. */
		resolution: text("resolution", { mode: "json" }).$type<{ status: "done" | "wontfix"; note?: string; at: number }>(),
		createdAt: createdAt(),
	},
	(t) => [index("review_comments_review_idx").on(t.reviewId)],
);

/**
 * Where an account stands with Stripe (`user.billing_status`):
 * none (no payment method yet: the account cannot be used), active (a payment method is on file),
 * past_due (a monthly invoice could not be collected: paid work is refused until it is settled).
 */
export type BillingStatus = "none" | "active" | "past_due";

/**
 * Credit a superuser gave an account, in millionths of a US dollar. A negative
 * row takes credit back. Credit is spent by monthly invoices (`invoices.credit_micros`)
 * before anything is charged to the payment method.
 */
export const billingCredits = sqliteTable(
	"billing_credits",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		amountMicros: integer("amount_micros").notNull(),
		note: text("note"),
		/** The superuser who granted it. */
		grantedBy: text("granted_by").notNull(),
		createdAt: createdAt(),
	},
	(t) => [index("billing_credits_user_idx").on(t.userId)],
);

/**
 * draft: being created in Stripe (a run that stopped part way resumes it).
 * open: finalized in Stripe and being collected. paid, failed, void, uncollectible: as Stripe reports.
 * credited: covered entirely by credit, nothing charged. no_charge: nothing to bill.
 * skipped: the account had charges but no payment method.
 */
export type InvoiceStatus = "draft" | "open" | "paid" | "failed" | "void" | "uncollectible" | "credited" | "no_charge" | "skipped";

/** One account's bill for one calendar month (UTC), produced from the usage ledger. */
export const invoices = sqliteTable(
	"invoices",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		/** The month billed, YYYY-MM (UTC). */
		period: text("period").notNull(),
		/** What the vendors charged us, before markup. */
		costMicros: integer("cost_micros").notNull(),
		markup: real("markup").notNull(),
		/** The usage charge (cost × markup), in cents, as the invoice lines add up. */
		chargeCents: integer("charge_cents").notNull(),
		/** Credit spent on this invoice, in cents. */
		creditCents: integer("credit_cents").notNull().default(0),
		/** What the payment method is charged: charge − credit. */
		amountDueCents: integer("amount_due_cents").notNull(),
		status: text("status").$type<InvoiceStatus>().notNull(),
		stripeInvoiceId: text("stripe_invoice_id"),
		hostedUrl: text("hosted_url"),
		error: text("error"),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(t) => [uniqueIndex("invoices_user_period_idx").on(t.userId, t.period), index("invoices_stripe_idx").on(t.stripeInvoiceId)],
);

/**
 * Saved states of a video's storyboard, to go back to. Named checkpoints are
 * made on purpose (video.checkpoint) and keep the media they use from being
 * cleaned up, so restoring one costs nothing. Automatic ones are taken before
 * every storyboard change (the last 20 are kept) and are for undo.
 */
export const videoCheckpoints = sqliteTable(
	"video_checkpoints",
	{
		id: text("id").primaryKey(),
		videoId: text("video_id")
			.notNull()
			.references(() => videos.id, { onDelete: "cascade" }),
		name: text("name"),
		auto: integer("auto", { mode: "boolean" }).notNull().default(false),
		/** What changed to make an automatic checkpoint, e.g. "scene.patch hook". */
		reason: text("reason"),
		storyboard: text("storyboard", { mode: "json" }).$type<Storyboard>().notNull(),
		resolved: text("resolved", { mode: "json" }).$type<ResolvedMedia>().notNull(),
		createdAt: createdAt(),
	},
	(t) => [index("video_checkpoints_video_idx").on(t.videoId, t.createdAt)],
);
