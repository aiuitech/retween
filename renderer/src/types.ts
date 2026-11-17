import type { RenderProps } from "../../shared/timeline.ts";

export type {
	RenderProps,
	Timeline,
	TimelineAudio,
	TimelineBackground,
	TimelineCaption,
	TimelineContent,
	TimelineScene,
	TimelineTheme,
	TransitionType,
} from "../../shared/timeline.ts";

/** What the preflight learned about one media URL. */
export type MediaInfo = {
	ok: boolean;
	kind: "image" | "video" | "audio";
	width?: number;
	height?: number;
	durationSec?: number;
	error?: string;
};

export type FontFaceSpec = {
	family: string;
	url: string;
	weight: string;
	style: string;
	unicodeRange?: string;
};

export type ResolvedFont = {
	/** The family that was asked for. */
	requested: string;
	/** CSS family to use, or null when the family could not be loaded (system fallback). */
	family: string | null;
	faces: FontFaceSpec[];
};

/**
 * Computed once per render in `calculateMetadata` (a single browser tab) and
 * handed to every render tab, so that all tabs agree on which media is usable
 * and which font files to load.
 */
export type Resolved = {
	media: Record<string, MediaInfo>;
	fonts: { heading: ResolvedFont; body: ResolvedFont; extra: ResolvedFont[] };
	warnings: string[];
};

/** Props of the `Video` composition: the contract plus what the preflight added. */
export type VideoProps = RenderProps & { resolved?: Resolved };
