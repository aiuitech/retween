import "@fontsource-variable/inter/wght.css";
import type React from "react";
import { type CalculateMetadataFunction, Composition } from "remotion";
import { preflight } from "./lib/preflight.ts";
import { SHEET_FPS, SheetComposition, type SheetProps, calculateSheetMetadata } from "./Sheet.tsx";
import type { VideoProps } from "./types.ts";
import { VideoComposition } from "./Video.tsx";

/** Only used when the composition is opened without input props (e.g. in the Studio). */
const defaultProps: VideoProps = {
	width: 1920,
	height: 1080,
	timeline: {
		version: 1,
		fps: 30,
		durationInFrames: 90,
		theme: {
			colors: { primary: "#2F5BEA", secondary: "#101828", accent: "#F26B3A", background: "#F7F5F0", surface: "#FFFFFF", text: "#14161A", mutedText: "#5B6270" },
			fonts: { heading: { family: "Inter", weight: 700 }, body: { family: "Inter", weight: 400 } },
			radius: 16,
			motion: { energy: "balanced", textAnimation: "rise", kenBurns: "subtle" },
			captions: { enabled: false, mode: "phrase", position: "bottom", uppercase: false, highlightColor: "#F26B3A", background: "box" },
			scrim: 0.45,
		},
		scenes: [
			{
				id: "placeholder",
				type: "title",
				startFrame: 0,
				durationInFrames: 90,
				transition: { type: "cut", durationInFrames: 0 },
				background: { kind: "brand" },
				layout: { align: "left", textPosition: "center", mediaSide: "right" },
				content: { kicker: "Retween", heading: "Pass a timeline as input props" },
			},
		],
		audio: [],
		captions: [],
	},
};

/**
 * Sizes the composition from the props and runs the preflight (media probing
 * and font resolution) exactly once per render, before any frame is drawn.
 * A caller that already has the preflight result (stills reuse it) passes it in.
 */
const calculateMetadata: CalculateMetadataFunction<VideoProps> = async ({ props }) => {
	const { timeline, width, height } = props;
	const resolved = props.resolved ?? (await preflight(props));
	return {
		width,
		height,
		fps: timeline.fps,
		durationInFrames: timeline.durationInFrames,
		props: { ...props, resolved },
		defaultCodec: "h264",
		defaultPixelFormat: "yuv420p",
	};
};

const defaultSheetProps: SheetProps = {
	timeline: defaultProps.timeline,
	tiles: [0, 45, 89].map((frame) => ({ kind: "frame" as const, frame, width: 1280, height: 720, label: `frame ${frame}` })),
	tileHeight: 220,
	maxWidth: 1600,
};

export const Root: React.FC = () => (
	<>
		<Composition
			id="Video"
			component={VideoComposition}
			width={defaultProps.width}
			height={defaultProps.height}
			fps={defaultProps.timeline.fps}
			durationInFrames={defaultProps.timeline.durationInFrames}
			defaultProps={defaultProps}
			calculateMetadata={calculateMetadata}
		/>
		{/* Contact sheets: many frames or media files on one still (see Sheet.tsx). */}
		<Composition
			id="Sheet"
			component={SheetComposition}
			width={1600}
			height={900}
			fps={SHEET_FPS}
			durationInFrames={1}
			defaultProps={defaultSheetProps}
			calculateMetadata={calculateSheetMetadata}
		/>
	</>
);
