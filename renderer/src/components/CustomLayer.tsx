/**
 * A layer drawn by the author's own code (a scene's `custom`): the escape
 * hatch for anything the scene types do not do, inside the same timeline, so
 * it is timed to the voice, previewed, checked and exported like the rest.
 *
 * The code is the body of a function of one argument, called on every frame,
 * that returns elements made with `h` (React.createElement). It gets the
 * frame, the scene's size and timing, the brand's colours and fonts, the
 * scene's spoken words and a few animation helpers. It must draw from the
 * frame alone. If it throws, the frame is drawn without it and the problem is
 * reported once (render warnings reach video.preview, video.sheet and video.check).
 */
import React, { useMemo } from "react";
import { Img, interpolate, spring, useCurrentFrame } from "remotion";
import { useRender } from "../context.ts";
import type { TimelineContent, TimelineScene } from "../types.ts";

type Custom = NonNullable<TimelineContent["custom"]>;
type Draw = (api: Record<string, unknown>) => React.ReactNode;

const reported = new Set<string>();
function report(sceneId: string, what: string, error: unknown) {
	const message = `Scene "${sceneId}": its custom layer ${what} (${error instanceof Error ? error.message : String(error)}), so the scene is shown without it`;
	if (reported.has(message)) return;
	reported.add(message);
	console.warn(`[retween] ${message}`);
}

/** A repeatable 0–1 number for a seed: the same every frame and in every render tab. */
const random = (seed: number | string) => {
	let h = 2166136261;
	for (const ch of String(seed)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
	h = Math.imul(h ^ (h >>> 15), 2246822507);
	h = Math.imul(h ^ (h >>> 13), 3266489909);
	return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

const ease = (t: number) => {
	const x = Math.min(1, Math.max(0, t));
	return x * x * (3 - 2 * x);
};

export const CustomLayer: React.FC<{ scene: TimelineScene; custom: Custom }> = ({ scene, custom }) => {
	const { theme, fonts, fps, frame: layout, u, timeline } = useRender();
	const f = useCurrentFrame();

	const draw = useMemo<Draw | null>(() => {
		try {
			// Names the code should not reach for are shadowed; this is a guard against accidents, not a sandbox.
			return new Function("api", "fetch", "XMLHttpRequest", "WebSocket", "setTimeout", "setInterval", "Date", `"use strict";\nconst { frame, fps, durationInFrames, seconds, width, height, u, colors, fonts, words, props, assets, interpolate, spring, ease, random, h, Img } = api;\n${custom.code}`).bind(
				null,
			) as unknown as Draw;
		} catch (error) {
			report(scene.id, "does not compile", error);
			return null;
		}
	}, [custom.code, scene.id]);

	const words = useMemo(() => {
		const start = scene.startFrame;
		const end = scene.startFrame + scene.durationInFrames;
		return timeline.captions
			.filter((cue) => cue.startFrame >= start && cue.startFrame < end)
			.flatMap((cue) => cue.words)
			.map((word) => ({ text: word.text, start: (word.startFrame - start) / fps, end: (word.endFrame - start) / fps }));
	}, [timeline.captions, scene.startFrame, scene.durationInFrames, fps]);

	if (!draw) return null;
	let out: React.ReactNode = null;
	try {
		out = (draw as unknown as (api: Record<string, unknown>, ...blocked: undefined[]) => React.ReactNode)(
			{
				frame: f,
				fps,
				durationInFrames: scene.durationInFrames,
				seconds: f / fps,
				width: layout.width,
				height: layout.height,
				u,
				colors: theme.colors,
				fonts,
				words,
				props: custom.props ?? {},
				assets: custom.assets ?? {},
				interpolate: (value: number, input: number[], output: number[], options?: { clamp?: boolean }) =>
					interpolate(value, input, output, options?.clamp === false ? undefined : { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
				spring: (frame: number, options: { damping?: number; stiffness?: number; mass?: number; delay?: number } = {}) =>
					spring({ frame: frame - (options.delay ?? 0), fps, config: { damping: options.damping ?? 14, stiffness: options.stiffness ?? 120, mass: options.mass ?? 1 } }),
				ease,
				random,
				h: React.createElement,
				Img,
			},
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
		);
	} catch (error) {
		report(scene.id, "failed while drawing", error);
		return null;
	}
	if (out !== null && out !== undefined && typeof out === "object" && !React.isValidElement(out) && !Array.isArray(out)) {
		report(scene.id, "returned something that is not an element", new Error(typeof out));
		return null;
	}
	return <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>{out as React.ReactNode}</div>;
};
