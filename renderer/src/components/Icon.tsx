import type React from "react";
import { Img } from "remotion";
import { mediaOk, useRender } from "../context.ts";
import { useSvg } from "../lib/svg.ts";
import type { TimelineIcon } from "../types.ts";

/**
 * An icon in a square box. Single-colour icons are inlined so they take
 * `color` (Iconify glyphs draw with `currentColor`); multi-colour ones (emoji,
 * logos) are shown as they are.
 */
export const Icon: React.FC<{ icon: TimelineIcon; size: string; color: string; style?: React.CSSProperties }> = ({ icon, size, color, style }) => {
	const { resolved } = useRender();
	const usable = mediaOk(resolved, icon.src);
	const box: React.CSSProperties = { width: size, height: size, flex: "none", ...style };
	if (!usable) return null;
	if (!icon.mono) return <Img src={icon.src} style={{ ...box, objectFit: "contain" }} />;
	return <MonoIcon src={icon.src} box={box} color={color} />;
};

const MonoIcon: React.FC<{ src: string; box: React.CSSProperties; color: string }> = ({ src, box, color }) => {
	const { svg } = useSvg(src, "icon");
	if (!svg) return null;
	// biome-ignore lint/security/noDangerouslySetInnerHtml: cleaned by cleanSvg (no scripts, handlers or external references)
	return <div style={{ ...box, color }} dangerouslySetInnerHTML={{ __html: svg.markup }} />;
};

/** Whether an icon will actually draw, so layouts can reserve room for it only then. */
export const useIconUsable = (icon: TimelineIcon | undefined) => {
	const { resolved } = useRender();
	return !!icon && mediaOk(resolved, icon.src);
};
