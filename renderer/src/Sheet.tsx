/**
 * Contact sheet: many frames (or media files) on one image, so an agent can
 * look at a whole video, an animation or a set of candidate pictures in a
 * single still instead of one render per frame.
 *
 * A `frame` tile is a full copy of the video composition, laid out at the
 * tile's own render size (so text wraps and fits exactly as it would in that
 * export) and frozen on one frame, then scaled down into the grid. Scaling is
 * a CSS transform, which layout ignores: FitBox measures the full-size copy,
 * and its fit reports describe the real export, not the thumbnail.
 *
 * The sheet is a still (frame 0), but it takes the timeline's length and fps:
 * a <Sequence> never shows past the end of its composition, and footage maps
 * frames to seconds with the composition's fps.
 */
import type React from "react";
import { useState } from "react";
import { Video } from "@remotion/media";
import { AbsoluteFill, type CalculateMetadataFunction, Freeze, Img, useVideoConfig } from "remotion";
import { preflight, probe } from "./lib/preflight.ts";
import type { ThumbnailOverlay as Overlay } from "../../shared/thumbnail.ts";
import { DurationBadge, ThumbnailOverlay } from "./components/ThumbnailOverlay.tsx";
import { type SheetGeometry, sheetGeometry } from "./lib/sheet.ts";
import type { Resolved, Timeline } from "./types.ts";
import { VideoComposition } from "./Video.tsx";

export type SheetTile =
	/** A frame of `timeline`, laid out at width x height (the export's pixel size). */
	| { kind: "frame"; frame: number; width: number; height: number; label?: string }
	| { kind: "image"; src: string; label?: string }
	/** The frame of a video file at `atSec`. */
	| { kind: "video"; src: string; atSec: number; label?: string }
	/**
	 * A thumbnail: frame `frame` of the (thumbnail) timeline with `overlay` drawn over it, laid out at
	 * width x height and shown `displayHeight` px tall, with the duration badge a feed would print over it.
	 */
	| { kind: "thumbnail"; frame: number; width: number; height: number; overlay: Overlay; label?: string; displayHeight?: number; badge?: string };

export type SheetProps = {
	/** Required by `frame` tiles. Asset references must already be signed URLs. */
	timeline?: Timeline;
	tiles: SheetTile[];
	/** Display height of a tile in the sheet, px. */
	tileHeight: number;
	/** The sheet is never wider than this, px. */
	maxWidth: number;
	/** One tile, no labels, no padding: a plain still. */
	bare?: boolean;
	/** Filled in by calculateMetadata. */
	resolved?: Resolved;
	geometry?: SheetGeometry;
	/** Media tiles that could not be read, by tile index. */
	failed?: Record<number, string>;
};

export const SHEET_FPS = 30;

export const calculateSheetMetadata: CalculateMetadataFunction<SheetProps> = async ({ props }) => {
	const needsTimeline = props.tiles.some((tile) => tile.kind === "frame" || tile.kind === "thumbnail");
	if (needsTimeline && !props.timeline) throw new Error("frame tiles need a timeline");
	const resolved = needsTimeline ? (props.resolved ?? (await preflight({ timeline: props.timeline!, width: 1280, height: 720 }))) : undefined;

	const failed: Record<number, string> = {};
	const aspects = await Promise.all(
		props.tiles.map(async (tile, i) => {
			if (tile.kind === "frame" || tile.kind === "thumbnail") return tile.width / tile.height;
			const info = await probe(tile.kind, tile.src);
			if (!info.ok || !info.width || !info.height) {
				failed[i] = info.error ?? "could not be read";
				return 16 / 9;
			}
			return info.width / info.height;
		}),
	);
	const heights = props.tiles.map((tile) => (tile.kind === "thumbnail" ? tile.displayHeight : undefined));
	const geometry = sheetGeometry(aspects, { tileHeight: props.tileHeight, maxWidth: props.maxWidth, bare: props.bare, heights });
	return {
		width: geometry.width,
		height: geometry.height,
		fps: props.timeline?.fps ?? SHEET_FPS,
		durationInFrames: props.timeline?.durationInFrames ?? 1,
		props: { ...props, resolved, geometry, failed },
	};
};

const INK = "#E8E8EA";
const PAPER = "#16171A";

export const SheetComposition: React.FC<SheetProps> = ({ timeline, tiles, resolved, geometry, failed = {} }) => {
	const { fps } = useVideoConfig();
	if (!geometry) return null;
	return (
		<AbsoluteFill style={{ background: PAPER }}>
			{tiles.map((tile, i) => {
				const box = geometry.tiles[i]!;
				return (
					<div key={i}>
						<div style={{ position: "absolute", left: box.x, top: box.y, width: box.w, height: box.h, overflow: "hidden", background: "#000" }}>
							{failed[i] ? (
								<Missing reason={failed[i]!} />
							) : tile.kind === "frame" ? (
								<FrameTile timeline={timeline!} resolved={resolved} tile={tile} index={i} w={box.w} />
							) : tile.kind === "thumbnail" ? (
								<>
									<FrameTile timeline={timeline!} resolved={resolved} tile={tile} index={i} w={box.w}>
										<ThumbnailOverlay overlay={tile.overlay} name={`thumb-${tile.frame + 1}`} />
									</FrameTile>
									{tile.badge ? <DurationBadge text={tile.badge} width={box.w} height={box.h} /> : null}
								</>
							) : tile.kind === "image" ? (
								<ImageTile src={tile.src} />
							) : (
								<Video src={tile.src} muted trimBefore={Math.max(0, Math.round(tile.atSec * fps))} objectFit="contain" style={{ width: "100%", height: "100%" }} delayRenderTimeoutInMilliseconds={45_000} />
							)}
						</div>
						{geometry.label > 0 && tile.label ? (
							<div
								style={{
									position: "absolute",
									left: box.x,
									top: box.y + box.h + 4,
									width: box.w,
									height: geometry.label - 6,
									color: INK,
									font: "500 15px/20px 'Inter Variable', Inter, sans-serif",
									whiteSpace: "nowrap",
									overflow: "hidden",
									textOverflow: "ellipsis",
								}}
							>
								{tile.label}
							</div>
						) : null}
					</div>
				);
			})}
		</AbsoluteFill>
	);
};

const FrameTile: React.FC<{ timeline: Timeline; resolved?: Resolved; tile: { frame: number; width: number; height: number }; index: number; w: number; children?: React.ReactNode }> = ({
	timeline,
	resolved,
	tile,
	index,
	w,
	children,
}) => (
	<div style={{ position: "absolute", left: 0, top: 0, width: tile.width, height: tile.height, transform: `scale(${w / tile.width})`, transformOrigin: "0 0" }}>
		<Freeze frame={Math.min(tile.frame, timeline.durationInFrames - 1)}>
			<VideoComposition timeline={timeline} resolved={resolved} width={tile.width} height={tile.height} audio={false} probe={String(index)}>
				{children}
			</VideoComposition>
		</Freeze>
	</div>
);

const ImageTile: React.FC<{ src: string }> = ({ src }) => {
	const [failed, setFailed] = useState(false);
	if (failed) return <Missing reason="could not be loaded" />;
	// A light checkerboard shows transparency, so a dark logo on nothing is still visible.
	return (
		<AbsoluteFill style={{ background: "repeating-conic-gradient(#D4D4D8 0% 25%, #F4F4F5 0% 50%) 50% / 16px 16px" }}>
			<Img src={src} maxRetries={1} delayRenderTimeoutInMilliseconds={25_000} onError={() => setFailed(true)} style={{ width: "100%", height: "100%", objectFit: "contain" }} />
		</AbsoluteFill>
	);
};

const Missing: React.FC<{ reason: string }> = ({ reason }) => (
	<AbsoluteFill style={{ alignItems: "center", justifyContent: "center", padding: 12, color: "#9A9AA2", font: "500 14px/18px 'Inter Variable', Inter, sans-serif", textAlign: "center" }}>
		{reason}
	</AbsoluteFill>
);
