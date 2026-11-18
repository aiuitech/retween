import type React from "react";
import { useCurrentFrame } from "remotion";
import { useRender } from "../context.ts";
import { contrast, isDark, mix, withAlpha } from "../lib/color.ts";
import { seeded } from "../lib/hash.ts";

/**
 * The renderer's own backdrop, built only from brand colours.
 *
 * Two flat, overlapping discs tinted with the backdrop colours (the palette's
 * primary and secondary unless the brand names its own) - a print-like
 * composition rather than a gradient - and a set of hairline rings in the text
 * colour sharing the larger disc's centre. The discs are the brand colours
 * themselves laid over the background at a strength set by `intensity`, so no
 * colour appears that is not in the brand. Everything drifts slowly and
 * deterministically; the arrangement is seeded by the scene id so consecutive
 * scenes do not look identical. The accent colour is left out unless the brand
 * names it: by default it belongs to the type that sits on top.
 */
/** Matches DEFAULT_BACKDROP_INTENSITY in shared/brand.ts (the bundle cannot import it: brand.ts pulls in zod). */
const DEFAULT_INTENSITY = 0.25;

export const BrandBackdrop: React.FC<{ seed: string; width: number; height: number }> = ({ seed, width, height }) => {
	const { theme, fps, u } = useRender();
	const t = useCurrentFrame() / fps;
	const { background, primary, secondary, text } = theme.colors;
	const style = theme.backdrop?.style ?? "shapes";
	const colors = theme.backdrop?.colors?.length ? theme.backdrop.colors : [primary, secondary];
	const intensity = theme.backdrop?.intensity ?? DEFAULT_INTENSITY;
	const [r0 = 0, r1 = 0, r2 = 0, r3 = 0] = seeded(seed, 4);

	if (style === "plain" || intensity <= 0) return <div style={{ position: "absolute", inset: 0, background }} />;

	const D = Math.max(width, height);
	const dark = isDark(background);
	// The default intensity gives a quiet tint (10% of the colour); full intensity shows the colours as they are.
	const strength = intensity <= DEFAULT_INTENSITY ? (intensity / DEFAULT_INTENSITY) * 0.1 : 0.1 + ((intensity - DEFAULT_INTENSITY) / (1 - DEFAULT_INTENSITY)) * 0.9;
	// A colour too close to the background to show (a dark primary on a dark background) gives way to the text colour.
	const tint = (color: string, amount: number) =>
		contrast(color, background) >= 1.25 ? mix(background, color, Math.min(1, amount)) : mix(background, text, Math.min(1, amount * 0.6));
	const tintA = tint(colors[0]!, strength);
	const tintB = tint(colors[1] ?? colors[0]!, strength * 0.8);
	const tintC = colors[2] ? tint(colors[2], strength * 0.8) : undefined;
	const ringScale = Math.min(3, intensity / DEFAULT_INTENSITY);

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
			{style === "shapes" ? (
				<>
					<circle cx={ax} cy={ay} r={ra} fill={tintA} />
					<circle cx={bx} cy={by} r={rb} fill={tintB} />
					{tintC ? <circle cx={(right ? 0.96 : 0.04) * width} cy={(bottom ? -0.04 : 1.04) * height} r={rb * 0.55} fill={tintC} /> : null}
				</>
			) : null}
			{rings.map((r, i) => (
				<circle
					key={i}
					cx={ax}
					cy={ay}
					r={r}
					fill="none"
					stroke={withAlpha(text, Math.min(0.5, (dark ? 0.1 - i * 0.015 : 0.12 - i * 0.02) * ringScale))}
					strokeWidth={1.5 * u}
				/>
			))}
		</svg>
	);
};
