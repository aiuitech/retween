/**
 * What a thumbnail adds over its picture: a scrim on the text side, a cut-out
 * subject outlined so it separates from the background, a heavy headline with
 * a dark stroke (it has to read at 168 px wide), a kicker tag and the logo.
 *
 * Drawn inside the video composition's render context, so it uses the brand's
 * loaded fonts and colours and its FitBox reports how far the headline shrank.
 */
import type React from "react";
import { Img } from "remotion";
import type { ThumbnailOverlay as Overlay } from "../../../shared/thumbnail.ts";
import { HEADLINE_DESIGN_PX } from "../../../shared/thumbnail-layout.ts";
import { mediaOk, U, useRender } from "../context.ts";
import { pickReadable, withAlpha } from "../lib/color.ts";
import { FitBox } from "./FitBox.tsx";

const clean = (word: string) => word.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

export const ThumbnailOverlay: React.FC<{ overlay: Overlay; name: string }> = ({ overlay, name }) => {
	const { theme, frame, u, fonts, resolved } = useRender();
	const { width: W, height: H } = frame;
	const { textSide, textPosition, subject } = overlay;
	const accent = pickReadable("#101014", 3, theme.colors.accent, theme.colors.primary, "#FFD43B");
	const highlight = new Set((overlay.highlight ?? []).flatMap((phrase) => phrase.split(/\s+/)).map(clean).filter(Boolean));

	// The text takes the side away from the subject; a centred subject pushes it up or down.
	const padX = W * 0.055;
	const padY = H * 0.08;
	const textW = subject && subject.side !== "center" && textSide !== "center" ? W * 0.56 : W * 0.86;
	const textX = textSide === "left" ? padX : textSide === "right" ? W - padX - textW : (W - textW) / 2;
	// The bottom-right corner is covered by the duration badge in every feed.
	const bottomPad = textX + textW > W * 0.8 ? H * 0.17 : padY;
	const rect = { x: textX, y: padY, w: textW, h: H - padY - bottomPad };

	const scrim = overlay.scrim > 0 && overlay.headline;
	const towards = textSide === "left" ? "to right" : textSide === "right" ? "to left" : textPosition === "bottom" ? "to top" : "to bottom";
	const logoSrc = theme.logo ? (theme.logo.darkSrc && mediaOk(resolved, theme.logo.darkSrc) ? theme.logo.darkSrc : theme.logo.src) : undefined;

	const words = (overlay.headline ?? "").split(/\s+/).filter(Boolean);
	const stroke = HEADLINE_DESIGN_PX * 0.06;

	return (
		<>
			{scrim ? (
				<div
					style={{
						position: "absolute",
						inset: 0,
						background: `linear-gradient(${towards}, ${withAlpha("#000000", overlay.scrim)} 0%, ${withAlpha("#000000", overlay.scrim * 0.6)} 45%, transparent 78%)`,
					}}
				/>
			) : null}
			{subject ? (
				<Img
					src={subject.src}
					maxRetries={1}
					delayRenderTimeoutInMilliseconds={25_000}
					style={{
						position: "absolute",
						bottom: 0,
						height: H * 0.98 * subject.scale,
						width: W * 0.62,
						objectFit: "contain",
						objectPosition: subject.side === "left" ? "left bottom" : subject.side === "right" ? "right bottom" : "center bottom",
						...(subject.side === "left" ? { left: W * 0.02 } : subject.side === "right" ? { right: W * 0.02 } : { left: W * 0.19 }),
						// A white keyline and a soft shadow lift the subject off any background.
						filter: `drop-shadow(0 0 ${5 * u}px #FFFFFF) drop-shadow(0 0 ${2 * u}px #FFFFFF) drop-shadow(0 ${14 * u}px ${28 * u}px rgba(0, 0, 0, 0.55))`,
					}}
				/>
			) : null}
			{overlay.logo && logoSrc && mediaOk(resolved, logoSrc) ? (
				<Img
					src={logoSrc}
					style={{
						position: "absolute",
						top: padY * 0.7,
						height: 64 * u,
						maxWidth: 300 * u,
						objectFit: "contain",
						...(textSide === "right" ? { left: padX } : { right: padX }),
						filter: `drop-shadow(0 ${3 * u}px ${8 * u}px rgba(0, 0, 0, 0.5))`,
					}}
				/>
			) : null}
			{overlay.headline || overlay.kicker ? (
				<FitBox rect={rect} u={u} justify={textPosition} align={textSide === "center" ? "center" : "left"} fitKey={JSON.stringify(overlay)} name={`${name}/headline`}>
					<div data-block style={{ textAlign: textSide === "right" ? "right" : textSide }}>
						{overlay.kicker ? (
							<div
								style={{
									display: "inline-block",
									marginBottom: U(22),
									padding: `${U(8)} ${U(22)}`,
									borderRadius: U(theme.radius * 0.8),
									background: accent,
									color: pickReadable(accent, 4.5, "#101014", "#FFFFFF"),
									font: `800 ${U(44)}/1.1 ${fonts.heading}`,
									letterSpacing: "0.04em",
									textTransform: "uppercase",
								}}
							>
								<span data-w>{overlay.kicker}</span>
							</div>
						) : null}
						{words.length ? (
							<div
								style={{
									fontFamily: fonts.heading,
									fontWeight: Math.max(theme.fonts.heading.weight, 700),
									fontSize: U(HEADLINE_DESIGN_PX),
									lineHeight: 0.98,
									letterSpacing: "-0.02em",
									color: "#FFFFFF",
									textTransform: overlay.uppercase ? "uppercase" : undefined,
									WebkitTextStroke: `${U(stroke)} #0B0B0F`,
									paintOrder: "stroke fill",
									textShadow: `0 ${U(6)} ${U(18)} rgba(0, 0, 0, 0.55)`,
									overflowWrap: "normal",
								}}
							>
								{words.map((word, i) => (
									<span key={i}>
										<span data-w style={{ color: highlight.has(clean(word)) ? accent : undefined }}>
											{word}
										</span>
										{i < words.length - 1 ? " " : null}
									</span>
								))}
							</div>
						) : null}
					</div>
				</FitBox>
			) : null}
		</>
	);
};

/** The video length as YouTube prints it over the bottom-right corner of every thumbnail. */
export const DurationBadge: React.FC<{ text: string; width: number; height: number }> = ({ text, width, height }) => {
	const h = height * 0.085;
	return (
		<div
			style={{
				position: "absolute",
				right: width * 0.012,
				bottom: height * 0.02,
				height: h,
				padding: `0 ${h * 0.28}px`,
				borderRadius: h * 0.22,
				background: "rgba(0, 0, 0, 0.82)",
				color: "#FFFFFF",
				font: `600 ${h * 0.68}px/${h}px Roboto, 'Inter Variable', Inter, sans-serif`,
			}}
		>
			{text}
		</div>
	);
};
