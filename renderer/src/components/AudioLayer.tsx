import { Audio } from "@remotion/media";
import type React from "react";
import { Sequence, useCurrentFrame } from "remotion";
import { mediaOk, useRender } from "../context.ts";
import { volumeAt } from "../lib/audio.ts";
import type { TimelineAudio } from "../types.ts";

const Clip: React.FC<{ clip: TimelineAudio }> = ({ clip }) => {
	const { fps } = useRender();
	// Inside the <Sequence> the frame is clip-local; ducking ranges are absolute.
	const frame = useCurrentFrame() + clip.startFrame;
	return (
		<Audio
			src={clip.src}
			trimBefore={Math.round(clip.trimStartSec * fps)}
			loop={clip.loop}
			volume={volumeAt(clip, frame)}
			delayRenderTimeoutInMilliseconds={45_000}
		/>
	);
};

/** Every usable audio clip, placed at its absolute start frame. Clips the preflight rejected are skipped. */
export const AudioLayer: React.FC = () => {
	const { timeline, resolved } = useRender();
	return (
		<>
			{timeline.audio
				.filter((clip) => mediaOk(resolved, clip.src))
				.map((clip) => (
					<Sequence key={clip.id} from={clip.startFrame} durationInFrames={clip.durationInFrames} layout="none" name={`${clip.kind}:${clip.id}`}>
						<Clip clip={clip} />
					</Sequence>
				))}
		</>
	);
};
