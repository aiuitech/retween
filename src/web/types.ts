/** What the service's operations return, as the pages use them. */

export interface ProjectRow {
	id: string;
	name: string;
	description?: string | null;
	brandName?: string;
	videos: number;
	assets: number;
	createdAt: string;
	updatedAt: string;
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
	error?: string;
}

export interface Scene {
	id: string;
	type: string;
	label?: string;
	narration?: string;
	footage?: { from?: string; to?: string; show?: string };
	visual?: { source: string; prompt?: string; query?: string; assetId?: string };
	text?: {
		kicker?: string;
		heading?: string;
		subheading?: string;
		body?: string;
		bullets?: { text: string }[];
		quote?: string;
		stat?: { value: string; label?: string };
		cta?: { text: string };
	};
	chart?: { title?: string };
	map?: { places?: { name?: string }[] };
}

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
	createdAt: string;
	finishedAt?: string;
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

export const ASPECTS = ["16:9", "9:16", "1:1", "4:5"] as const;
export const RESOLUTIONS = ["480p", "720p", "1080p", "1440p", "2160p"] as const;
