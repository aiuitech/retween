import type React from "react";
import { useCurrentFrame } from "remotion";
import { useRender } from "../context.ts";
import { isDark, tone, withAlpha } from "../lib/color.ts";
import { seeded } from "../lib/hash.ts";

/**
 * The renderer's own backdrop, built only from theme colours.
 *
 * Two flat, overlapping discs in quiet tones of the primary and secondary
 * colours (a print-like composition rather than a gradient) and a set of
 * hairline rings sharing the larger disc's centre. Everything drifts slowly
 * and deterministically; the arrangement is seeded by the scene id so
 * consecutive scenes do not look identical. The accent colour is left out on
 * purpose: it belongs to the type that sits on top.
 */
export const BrandBackdrop: React.FC<{ seed: string; width: number; height: number }> = ({ seed, width, height }) => {
	const { theme, fps, u } = useRender();
	const t = useCurrentFrame() / fps;
	const { background, primary, secondary, text } = theme.colors;
	const [r0 = 0, r1 = 0, r2 = 0, r3 = 0] = seeded(seed, 4);

	const D = Math.max(width, height);
	const dark = isDark(background);
	const tintA = tone(background, primary, dark ? 0.065 : 0.07, dark ? 0.7 : 0.5);
	const tintB = tone(background, secondary, dark ? 0.045 : 0.05, dark ? 0.7 : 0.55);

	// Disc A hangs off one corner, disc B off the opposite one.
	const corner = Math.floor(r0 * 4);
	const right = corner % 2 === 1;
	const bottom = corner >= 2;
	const drift = (speed: number, phase: number) => Math.sin(t * speed + phase * Math.PI * 2);

	const ax = (right ? 1.04 : -0.04) * width + drift(0.21, r1) * D * 0.018;
	const ay = (bottom ? 1.1 : -0.1) * height + drift(0.17, r2) * D * 0.018;
	const ra = D * (0.56 + r1 * 0.1);

	const bx = (right ? -0.02 : 1.02) * width + drift(0.19, r2 + 0.3) * D * 0.02;
	const by = (bottom ? -0.06 : 1.06) * height + drift(0.23, r3) * D * 0.02;
	const rb = D * (0.3 + r3 * 0.08);

	const gap = D * 0.062;
	const breathe = drift(0.26, r3) * D * 0.006;
	const rings = [1, 2, 3, 4].map((k) => ra + k * gap + breathe * k);

	return (
		<svg
			width={width}
			height={height}
			viewBox={`0 0 ${width} ${height}`}
			style={{ position: "absolute", inset: 0, display: "block", background }}
		>
			<circle cx={ax} cy={ay} r={ra} fill={tintA} />
			<circle cx={bx} cy={by} r={rb} fill={tintB} />
			{rings.map((r, i) => (
				<circle
					key={i}
					cx={ax}
					cy={ay}
					r={r}
					fill="none"
					stroke={withAlpha(text, dark ? 0.1 - i * 0.015 : 0.12 - i * 0.02)}
					strokeWidth={1.5 * u}
				/>
			))}
		</svg>
	);
};
