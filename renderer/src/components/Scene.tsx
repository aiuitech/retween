import type React from "react";
import { Img, useCurrentFrame } from "remotion";
import { mediaOk, U, useRender } from "../context.ts";
import { contrast, isDark, mix, pickReadable, readableOn, withAlpha } from "../lib/color.ts";
import { contentRegion, type Format, inset, type Rect } from "../lib/layout.ts";
import { mapInk } from "../lib/mapStyle.ts";
import { clamp01, progress } from "../lib/motion.ts";
import type { TimelineContent, TimelineScene, TimelineTheme } from "../types.ts";
import { Background, hasMedia, isStaged } from "./Background.tsx";
import { Chart } from "./Chart.tsx";
import { CustomLayer } from "./CustomLayer.tsx";
import { FitBox } from "./FitBox.tsx";
import { Icon } from "./Icon.tsx";
import { MapScene } from "./MapScene.tsx";
import { Reveal, Rule, SplitText, typewriterSeconds } from "./Text.tsx";

type Palette = {
	text: string;
	muted: string;
	accent: string;
	rule: string;
	/** Kicker text: the accent on flat colour, white over footage (where the accent cannot be trusted to read). */
	kicker: string;
	/** Small words that would be set in the accent (bullet numbers, stat prefix and suffix): the accent, unless the brand keeps it off text. */
	ink: string;
	/** The colour text effectively sits on. */
	base: string;
	dark: boolean;
};

function paletteFor(theme: TimelineTheme, scene: TimelineScene, overMedia: boolean): Palette {
	const pal = basePalette(theme, scene, overMedia);
	const own = scene.content.color;
	// The scene's own text colour, when it asks for one (a warning in red), is used as given.
	const text = own ?? pal.text;
	const muted = own ? withAlpha(own, 0.8) : pal.muted;
	const accentText = theme.accentText !== false;
	return {
		...pal,
		text,
		muted,
		kicker: accentText || overMedia ? pal.kicker : text,
		ink: own ?? (accentText ? pal.accent : text),
	};
}

/** True when the scene's text sits on something dark (footage under a scrim counts as dark). */
export function sceneIsDark(theme: TimelineTheme, scene: TimelineScene, ok: (src: string) => boolean): boolean {
	const overMedia = scene.type !== "split" && !(scene.type === "map" && !!scene.content.map) && hasMedia(scene.background, ok);
	return basePalette(theme, scene, overMedia).dark;
}

function basePalette(theme: TimelineTheme, scene: TimelineScene, overMedia: boolean): Omit<Palette, "ink"> {
	const c = theme.colors;
	if (overMedia) {
		const base = "#101014";
		return {
			text: "#FFFFFF",
			muted: "rgba(255, 255, 255, 0.82)",
			accent: pickReadable(base, 3, c.accent, c.primary, c.secondary, "#FFFFFF"),
			rule: "rgba(255, 255, 255, 0.3)",
			kicker: "#FFFFFF",
			base,
			dark: true,
		};
	}
	const bg = scene.background;
	const base =
		scene.type === "map" && scene.content.map
			? mapInk(c, scene.content.map.style).land
			: scene.type === "split"
				? c.background
			: bg.kind === "solid"
				? bg.color
				: bg.kind === "gradient"
					? mix(bg.colors[0]!, bg.colors[bg.colors.length - 1]!, 0.5)
					: c.background;
	const text = pickReadable(base, 4.5, c.text);
	const accent = pickReadable(base, 2.2, c.accent, c.primary, text);
	return {
		text,
		muted: contrast(c.mutedText, base) >= 2.8 ? c.mutedText : withAlpha(text, 0.68),
		accent,
		rule: withAlpha(text, 0.16),
		kicker: accent,
		base,
		dark: isDark(base),
	};
}

type Sizes = { heading: number; sub: number; body: number; bullet: number; quote: number; stat: number; column: number };

/** Type scale in design px (1080 short side), per scene type and frame format. */
function sizesFor(type: TimelineScene["type"], format: Format, centered: boolean): Sizes {
	const pick = (l: number, s: number, p: number, t: number) => ({ landscape: l, square: s, portrait: p, tall: t })[format];
	const base = { sub: 34, body: 34, bullet: pick(46, 42, 44, 46), quote: pick(76, 64, 66, 70), stat: pick(300, 250, 260, 270) };
	switch (type) {
		case "title":
			return { ...base, heading: pick(128, 108, 108, 114), sub: 42, column: centered ? 1420 : 1320 };
		case "bullets":
			return { ...base, heading: pick(76, 68, 68, 72), column: 1280 };
		case "quote":
			return { ...base, heading: 40, column: 1360 };
		case "stat":
			return { ...base, heading: pick(48, 44, 46, 48), column: 1400 };
		case "media":
			return { ...base, heading: pick(72, 64, 64, 68), column: 1120, quote: pick(60, 54, 56, 58), stat: pick(200, 180, 180, 190) };
		case "split":
			return {
				...base,
				heading: pick(80, 70, 70, 76),
				bullet: pick(38, 38, 40, 42),
				quote: pick(54, 50, 52, 56),
				stat: pick(210, 190, 200, 210),
				column: 1100,
			};
		case "chart":
			return { ...base, heading: pick(64, 58, 60, 64), column: 1520 };
		case "map":
			return { ...base, heading: pick(72, 64, 64, 68), column: 1100 };
		case "outro":
			return { ...base, heading: pick(96, 86, 86, 92), sub: 38, column: 1300 };
	}
}

/** Height of a chart, in design px, per frame format. */
const CHART_HEIGHT = { landscape: 470, square: 560, portrait: 640, tall: 780 } as const;

const QUOTE_CHARS = /^["'“”‘’«»„]/;

function formatCount(stat: NonNullable<TimelineContent["stat"]>, value: number): string {
	const fixed = value.toFixed(stat.decimals ?? 0);
	if (!stat.value.includes(",")) return fixed;
	const [int, frac] = fixed.split(".");
	return int!.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (frac ? `.${frac}` : "");
}

const prettyUrl = (url: string) => url.replace(/^https?:\/\//, "").replace(/\/$/, "");

/**
 * One scene: background, scrim, and the content stack for its type.
 * `tail` is how many frames it stays visible underneath the next scene's
 * transition; `captioned` says whether captions appear while it is on screen.
 */
export const Scene: React.FC<{ scene: TimelineScene; tail: number; captioned: boolean }> = ({ scene, tail, captioned }) => {
	const ctx = useRender();
	const { theme, frame, u, fps, pace, anim, fonts, resolved } = ctx;
	const f = useCurrentFrame();
	const c = scene.content;
	const { align, textPosition, mediaSide } = scene.layout;
	const ok = (src: string) => mediaOk(resolved, src);
	const { width: W, height: H, format } = frame;
	const visibleFrames = scene.durationInFrames + tail;

	const isSplit = scene.type === "split";
	const isMap = scene.type === "map" && !!c.map;
	const stacked = isSplit && format !== "landscape";
	const overMedia = !isSplit && !isMap && hasMedia(scene.background, ok);
	const staged = !isSplit && !isMap && isStaged(scene.background, ok);
	const pal = paletteFor(theme, scene, overMedia);
	const size = sizesFor(scene.type, format, align === "center");
	const caption = captioned ? ctx.caption : null;

	// --- geometry -------------------------------------------------------------
	let mediaRect: Rect = { x: 0, y: 0, w: W, h: H };
	let region = contentRegion(frame, caption, stacked && caption?.position === "center" ? "bottom" : textPosition);
	if (isSplit && !stacked) {
		const mw = Math.round(W * 0.46);
		const gutter = 92 * u;
		mediaRect = { x: mediaSide === "left" ? 0 : W - mw, y: 0, w: mw, h: H };
		region =
			mediaSide === "left"
				? { ...region, x: mw + gutter, w: W - mw - gutter - frame.safe.x }
				: { ...region, w: W - mw - gutter - frame.safe.x };
	} else if (stacked) {
		const mh = Math.round(H * { square: 0.44, portrait: 0.42, tall: 0.4, landscape: 0.4 }[format]);
		mediaRect = { x: 0, y: 0, w: W, h: mh };
		const top = Math.max(region.y, mh + 52 * u);
		region = { ...region, y: top, h: Math.max(0, region.y + region.h - top) };
	}

	// Keep clear of the watermark: if it reaches into the region, give up the strip it occupies.
	const wm = ctx.watermark;
	const gapWm = 22 * u;
	const hitsWatermark = (r: Rect) => !!wm && r.x < wm.rect.x + wm.rect.w + gapWm && r.x + r.w > wm.rect.x - gapWm && r.y < wm.rect.y + wm.rect.h + gapWm && r.y + r.h > wm.rect.y - gapWm;
	const clearWatermark = (r: Rect): Rect => {
		if (!wm || !hitsWatermark(r)) return r;
		if (wm.position.startsWith("top")) return inset(r, Math.max(0, wm.rect.y + wm.rect.h + gapWm - r.y), 0, 0, 0);
		return inset(r, 0, 0, Math.max(0, r.y + r.h - (wm.rect.y - gapWm)), 0);
	};

	// Corner logo (every type except the outro, which features the logo in its stack).
	const logoSrc = theme.logo ? (pal.dark && theme.logo.darkSrc && ok(theme.logo.darkSrc) ? theme.logo.darkSrc : theme.logo.src) : undefined;
	const logoUsable = !!logoSrc && ok(logoSrc);
	const logoInfo = logoSrc ? resolved.media[logoSrc] : undefined;
	const logoAspect = logoInfo?.width && logoInfo.height ? logoInfo.width / logoInfo.height : 3;
	let cornerLogo: React.ReactNode = null;
	if (c.showLogo && logoUsable && scene.type !== "outro") {
		const h = 46 * u;
		const w = Math.min(h * logoAspect, 260 * u);
		const wmLeft = wm?.position === "top-left";
		const x = align === "center" ? region.x + (region.w - w) / 2 : wmLeft ? region.x + region.w - w : region.x;
		// The logo may share a row with the watermark, but never the same spot.
		if (hitsWatermark({ x, y: region.y, w, h })) region = clearWatermark(region);
		cornerLogo = (
			<Img
				src={logoSrc!}
				style={{ position: "absolute", left: x, top: region.y, width: w, height: h, objectFit: "contain", objectPosition: align === "center" ? "center" : wmLeft ? "right" : "left", opacity: progress(f, 0, pace.duration * fps) }}
			/>
		);
		region = inset(region, h + 34 * u, 0, 0, 0);
	}
	region = clearWatermark(region);

	// Lower third: a strip at the bottom of the region, reserved so the stack never runs into it.
	let lowerRect: Rect | null = null;
	if (c.lowerThird) {
		const h = Math.min(128 * u, region.h * 0.4);
		lowerRect = { x: region.x, y: region.y + region.h - h, w: region.w, h };
		region = inset(region, 0, 0, h + 26 * u, 0);
	}

	// --- timing ---------------------------------------------------------------
	// Text waits for roughly half of the scene's own entrance transition.
	const enterDelay = scene.transition.type === "cut" ? 0 : Math.round(scene.transition.durationInFrames * 0.55);
	let cursor = enterDelay;
	const beat = pace.beat * fps;
	const at = (extraSeconds = 0) => {
		const start = cursor;
		cursor += beat + extraSeconds * fps;
		return start;
	};
	const typed = (text: string) => (anim === "typewriter" ? typewriterSeconds([...text].length, pace.cps) : 0);

	const headingFont: React.CSSProperties = { fontFamily: fonts.heading, fontWeight: theme.fonts.heading.weight };
	const bodyFont: React.CSSProperties = { fontFamily: fonts.body, fontWeight: theme.fonts.body.weight };
	const strong = Math.max(700, theme.fonts.body.weight);
	const centered = align === "center";
	// Supporting text may shrink with the fit, but not below a size that still reads.
	const S = (n: number) => `max(${U(n)}, ${(n * 0.74 * u).toFixed(2)}px)`;
	const measure = (max: number): React.CSSProperties => ({ maxWidth: U(max), marginLeft: centered ? "auto" : undefined, marginRight: centered ? "auto" : undefined });
	const shadow = overMedia && scene.type === "media" ? `0 ${U(2)} ${U(28)} rgba(0, 0, 0, 0.38)` : undefined;

	// --- pieces ---------------------------------------------------------------
	const parts: React.ReactNode[] = [];
	const push = (key: string, gapBefore: number, node: React.ReactNode) => {
		parts.push(
			<div key={key} style={{ marginTop: parts.length === 0 ? 0 : U(gapBefore) }}>
				{node}
			</div>,
		);
	};

	const iconBadge = (gap = 0) => {
		const icon = c.icon;
		if (!icon || !ok(icon.src)) return;
		const start = at();
		const d = scene.type === "title" || scene.type === "stat" ? 124 : 108;
		push(
			"icon",
			gap,
			<Reveal
				start={start}
				anim={anim === "typewriter" || anim === "fade" ? "fade" : "pop"}
				origin={centered ? "center" : "left center"}
				style={{ display: "flex", justifyContent: centered ? "center" : "flex-start" }}
			>
				<div
					style={{
						width: U(d),
						height: U(d),
						flex: "none",
						borderRadius: "50%",
						display: "flex",
						alignItems: "center",
						justifyContent: "center",
						background: icon.mono ? withAlpha(pal.accent, overMedia ? 0.24 : 0.13) : withAlpha(pal.text, overMedia ? 0.14 : 0.06),
					}}
				>
					<Icon icon={icon} size={U(d * (icon.mono ? 0.5 : 0.62))} color={pal.accent} />
				</div>
			</Reveal>,
		);
	};

	const chartPart = (gap: number) => {
		if (!c.chart) return;
		push(
			"chart",
			gap,
			<Chart
				chart={c.chart}
				height={CHART_HEIGHT[format]}
				wide={format === "landscape"}
				pal={{ text: pal.text, muted: pal.muted, accent: pal.accent, rule: pal.rule, base: pal.base }}
			/>,
		);
	};

	const kicker = (gap = 30) => {
		if (!c.kicker) return;
		const start = at();
		push(
			"kicker",
			gap,
			<div style={{ display: "flex", alignItems: "center", justifyContent: centered ? "center" : "flex-start", gap: U(18) }}>
				{centered ? null : (
					<Rule start={start} axis="x" origin="left center" style={{ flex: "none", width: U(44), height: U(4), background: pal.accent }} />
				)}
				<Reveal
					start={start}
					anim={anim === "pop" ? "fade" : anim}
					style={{ ...bodyFont, fontWeight: strong, fontSize: S(26), lineHeight: 1.3, letterSpacing: "0.16em", textTransform: "uppercase", color: pal.kicker, overflowWrap: "anywhere", minWidth: 0, textShadow: shadow }}
				>
					{c.kicker}
				</Reveal>
			</div>,
		);
	};

	const heading = (gap: number, opts?: { small?: boolean }) => {
		if (!c.heading) return;
		const start = at(typed(c.heading));
		const tight = size.heading >= 90;
		push(
			"heading",
			gap,
			<div
				data-block
				style={{
					...headingFont,
					fontSize: U(size.heading),
					lineHeight: tight ? 1.02 : 1.1,
					letterSpacing: tight ? "-0.028em" : "-0.018em",
					color: opts?.small ? pal.muted : pal.text,
					textWrap: "balance",
					textShadow: shadow,
				}}
			>
				<SplitText text={c.heading} start={start} caretColor={pal.accent} />
			</div>,
		);
	};

	const paragraph = (key: string, text: string | undefined, fontSize: number, gap: number, color: string, wrap: "balance" | "pretty" = "pretty") => {
		if (!text) return;
		push(
			key,
			gap,
			<Reveal
				block
				start={at()}
				style={{ ...bodyFont, ...measure(1040), fontSize: S(fontSize), lineHeight: 1.42, color, textWrap: wrap, overflowWrap: "anywhere", textShadow: shadow }}
			>
				{text}
			</Reveal>,
		);
	};

	const bullets = (gap: number) => {
		if (!c.bullets?.length) return;
		const dim = 0.45 * fps;
		// Icons are wider than a two-digit number; when any bullet has one, every marker gets the same column.
		const numberWidth = c.bullets.some((b) => b.icon && ok(b.icon.src)) ? Math.max(52, size.bullet) : 52;
		push(
			"bullets",
			gap,
			<div style={{ textAlign: "left", ...measure(1180) }}>
				{c.bullets.map((bullet, i) => {
					const next = c.bullets![i + 1];
					// Once the next point lands, this one steps back so the eye follows the narration.
					const focus = next ? 1 - 0.46 * pace.ease(progress(f, next.atFrame, dim)) : 1;
					return (
						<div key={i} style={{ position: "relative", padding: `${U(22)} 0`, opacity: focus }}>
							<Rule start={bullet.atFrame} axis="x" origin="left center" style={{ position: "absolute", left: 0, right: 0, top: 0, height: U(2), background: pal.rule }} />
							<div style={{ display: "flex", alignItems: "baseline", gap: U(30) }}>
								{bullet.icon && ok(bullet.icon.src) ? (
									// An icon has no text baseline: its bottom edge is used, so a negative margin drops it to sit like a glyph.
									<Reveal start={bullet.atFrame} anim="fade" style={{ flex: "none", width: U(numberWidth), marginBottom: U(-size.bullet * 0.17) }}>
										<Icon icon={bullet.icon} size={U(size.bullet * 0.95)} color={bullet.color ?? pal.accent} />
									</Reveal>
								) : (
									<Reveal
										start={bullet.atFrame}
										anim="fade"
										style={{ ...bodyFont, flex: "none", width: U(numberWidth), fontWeight: strong, fontSize: S(size.bullet * 0.5), letterSpacing: "0.1em", color: bullet.color ?? pal.ink, fontVariantNumeric: "tabular-nums" }}
									>
										{String(i + 1).padStart(2, "0")}
									</Reveal>
								)}
								<div data-block style={{ ...bodyFont, flex: 1, minWidth: 0, fontSize: U(size.bullet), lineHeight: 1.24, letterSpacing: "-0.008em", color: bullet.color ?? pal.text, textWrap: "pretty" }}>
									<SplitText text={bullet.text} start={bullet.atFrame} caretColor={pal.accent} />
								</div>
							</div>
						</div>
					);
				})}
			</div>,
		);
	};

	const quote = (gap: number) => {
		if (!c.quote) return;
		const text = QUOTE_CHARS.test(c.quote.trim()) ? c.quote.trim() : `“${c.quote.trim()}”`;
		const barStart = at();
		const textStart = at(typed(text));
		const attributionStart = c.attribution ? at() : 0;
		const body = (
			<>
				<div data-block style={{ ...headingFont, fontSize: U(size.quote), lineHeight: 1.16, letterSpacing: "-0.016em", color: pal.text, textWrap: "balance", textShadow: shadow }}>
					<SplitText text={text} start={textStart} caretColor={pal.accent} />
				</div>
				{c.attribution ? (
					<Reveal
						start={attributionStart}
						style={{ marginTop: U(40), display: "flex", alignItems: "center", justifyContent: centered ? "center" : "flex-start", gap: U(18), ...bodyFont, fontSize: S(30), lineHeight: 1.3, color: pal.muted }}
					>
						<span style={{ flex: "none", width: U(36), height: U(2), background: pal.muted }} />
						<span style={{ minWidth: 0, overflowWrap: "anywhere" }}>{c.attribution}</span>
					</Reveal>
				) : null}
			</>
		);
		push(
			"quote",
			gap,
			centered ? (
				body
			) : (
				<div style={{ display: "flex", gap: U(44) }}>
					<Rule start={barStart} axis="y" origin="center top" style={{ flex: "none", width: U(6), background: pal.accent }} />
					<div data-block style={{ flex: 1, minWidth: 0, padding: `${U(6)} 0` }}>
						{body}
					</div>
				</div>
			),
		);
	};

	const stat = (gap: number) => {
		const s = c.stat;
		if (!s) return;
		const start = at(0.1);
		const counting = s.numeric !== undefined;
		const duration = pace.countUp * fps;
		const p = progress(f, start, duration);
		const eased = p >= 1 ? 1 : 1 - 2 ** (-10 * p);
		const final = counting ? formatCount(s, s.numeric!) : s.value;
		const current = counting ? formatCount(s, s.numeric! * eased) : s.value;
		const affix: React.CSSProperties = { fontSize: "0.42em", color: pal.ink, letterSpacing: "-0.01em" };
		push(
			"stat",
			gap,
			<>
				<Reveal
					block
					start={start}
					anim={anim === "typewriter" ? "fade" : anim}
					origin={centered ? "center bottom" : "left bottom"}
					style={{ ...headingFont, fontSize: U(size.stat), lineHeight: 0.98, letterSpacing: "-0.045em", color: pal.text, fontVariantNumeric: "tabular-nums lining-nums", whiteSpace: "nowrap", textShadow: shadow }}
				>
					<span data-w style={{ display: "inline-block" }}>
						{counting && s.prefix ? <span style={{ ...affix, verticalAlign: "0.72em", marginRight: "0.06em" }}>{s.prefix}</span> : null}
						{/* The final value reserves the width so the layout holds still while counting. */}
						<span style={{ position: "relative", display: "inline-block" }}>
							<span style={{ visibility: "hidden" }}>{final}</span>
							<span style={{ position: "absolute", left: 0, right: 0, top: 0, textAlign: centered ? "center" : "left" }}>{current}</span>
						</span>
						{counting && s.suffix ? <span style={{ ...affix, marginLeft: "0.16em" }}>{s.suffix}</span> : null}
					</span>
				</Reveal>
				{s.label ? (
					<Reveal
						block
						start={at()}
						style={{ marginTop: U(size.stat * 0.1), ...bodyFont, ...measure(900), fontWeight: strong, fontSize: S(Math.max(34, size.stat * 0.15)), lineHeight: 1.25, color: pal.text, textWrap: "balance", overflowWrap: "anywhere" }}
					>
						{s.label}
					</Reveal>
				) : null}
			</>,
		);
	};

	const cta = (gap: number) => {
		if (!c.cta) return;
		const start = at();
		const fill = pickReadable(pal.base, 1.7, theme.colors.primary, theme.colors.accent, pal.text);
		push(
			"cta",
			gap,
			<>
				<Reveal
					start={start}
					origin={centered ? "center" : "left center"}
					style={{ display: "inline-block", maxWidth: "100%", padding: `${U(24)} ${U(52)}`, background: fill, color: readableOn(fill), borderRadius: U(Math.min(theme.radius, 60)), ...bodyFont, fontWeight: strong, fontSize: U(36), lineHeight: 1.2, letterSpacing: "0.005em", overflowWrap: "anywhere" }}
				>
					{c.cta.text}
				</Reveal>
				{c.cta.url ? (
					<Reveal start={at()} anim="fade" style={{ marginTop: U(26), ...bodyFont, fontSize: S(28), lineHeight: 1.3, letterSpacing: "0.02em", color: pal.muted, overflowWrap: "anywhere" }}>
						{prettyUrl(c.cta.url)}
					</Reveal>
				) : null}
			</>,
		);
	};

	const stackLogo = () => {
		if (!logoUsable) return;
		const h = logoAspect < 1.6 ? 150 : 104;
		push(
			"logo",
			0,
			<Reveal start={at()} origin={centered ? "center" : "left center"} style={{ lineHeight: 0 }}>
				<Img src={logoSrc!} style={{ height: U(h), width: "auto", maxWidth: U(520), objectFit: "contain" }} />
			</Reveal>,
		);
	};

	// --- order per scene type -------------------------------------------------
	switch (scene.type) {
		case "stat":
			iconBadge();
			kicker();
			stat(28);
			heading(40);
			paragraph("sub", c.subheading, size.sub, 20, pal.muted, "balance");
			paragraph("body", c.body, size.body, 20, pal.muted);
			bullets(36);
			quote(48);
			cta(48);
			break;
		case "quote":
			iconBadge();
			kicker();
			heading(24, { small: true });
			quote(c.kicker || c.heading ? 44 : 0);
			paragraph("sub", c.subheading, size.sub, 36, pal.muted, "balance");
			paragraph("body", c.body, size.body, 20, pal.muted);
			stat(48);
			bullets(36);
			cta(48);
			break;
		case "outro":
			stackLogo();
			iconBadge(48);
			kicker(56);
			heading(c.kicker ? 28 : 56);
			paragraph("sub", c.subheading, size.sub, 28, pal.muted, "balance");
			paragraph("body", c.body, size.body, 20, pal.muted);
			stat(48);
			bullets(36);
			quote(48);
			cta(60);
			break;
		case "chart":
			iconBadge();
			kicker();
			heading(26);
			paragraph("sub", c.subheading, size.sub, 20, pal.muted, "balance");
			paragraph("body", c.body, size.body, 18, pal.muted);
			chartPart(52);
			cta(48);
			break;
		default:
			iconBadge();
			kicker();
			heading(scene.type === "title" ? 34 : 28);
			paragraph("sub", c.subheading, size.sub, scene.type === "title" ? 36 : 26, scene.type === "title" ? pal.text : pal.muted, "balance");
			paragraph("body", c.body, size.body, 22, pal.muted);
			bullets(scene.type === "bullets" ? 44 : 36);
			quote(48);
			stat(40);
			cta(52);
	}

	// A staged visual (Lottie, a subject on its own) takes the part of the frame the text does not.
	let stage: Rect | undefined;
	if (staged) {
		const safe = frame.safe;
		if (!parts.length) stage = safe;
		else if (format === "landscape" && !centered && textPosition === "center") {
			const middle = W * 0.5;
			stage = { x: middle, y: safe.y, w: safe.x + safe.w - middle, h: safe.h };
			region = { ...region, w: Math.min(region.w, middle - region.x - 48 * u) };
		} else if (textPosition === "top") stage = { ...safe, y: safe.y + safe.h * 0.44, h: safe.h * 0.56 };
		else {
			// Text at the bottom, or centred where there is no room beside it: the visual takes the top, the text what is below.
			stage = { ...safe, h: safe.h * (format === "landscape" ? 0.56 : 0.52) };
			if (textPosition === "center") {
				const top = stage.y + stage.h + 40 * u;
				region = { ...region, y: Math.max(region.y, top), h: Math.max(0, region.y + region.h - Math.max(region.y, top)) };
			}
		}
	}

	const fitKey = JSON.stringify([c, scene.type, align]);
	const columnMax = format === "landscape" && !isSplit ? size.column * u : undefined;
	const scrim = overMedia ? theme.scrim : 0;
	const edge = textPosition === "top" ? "to bottom" : textPosition === "bottom" ? "to top" : null;

	return (
		<div style={{ position: "absolute", inset: 0, overflow: "hidden", background: isSplit ? theme.colors.background : undefined }}>
			{isMap ? (
				<MapScene map={c.map!} seed={scene.id} width={W} height={H} visibleFrames={visibleFrames} textPosition={textPosition} hasText={parts.length > 0} />
			) : (
				<div style={{ position: "absolute", left: mediaRect.x, top: mediaRect.y, width: mediaRect.w, height: mediaRect.h, overflow: "hidden" }}>
					<Background scene={scene} width={mediaRect.w} height={mediaRect.h} visibleFrames={visibleFrames} stage={stage} />
				</div>
			)}
			{isMap && parts.length > 0 ? (
				// The map fades into the background colour behind the text, so type reads in the theme's own colours.
				<div
					style={{
						position: "absolute",
						inset: 0,
						background: edge
							? `linear-gradient(${edge}, ${withAlpha(pal.base, 0.95)} 0%, ${withAlpha(pal.base, 0.82)} 24%, ${withAlpha(pal.base, 0)} 44%)`
							: withAlpha(pal.base, 0.55),
					}}
				/>
			) : null}
			{scrim > 0 && parts.length > 0 ? (
				scene.type === "media" && edge ? (
					// Footage-led scene: darken only the edge the text sits on.
					<div style={{ position: "absolute", inset: 0, background: `linear-gradient(${edge}, rgba(0,0,0,${clamp01(scrim * 1.25)}) 0%, rgba(0,0,0,${scrim * 0.7}) 32%, rgba(0,0,0,0) 68%)` }} />
				) : (
					<div style={{ position: "absolute", inset: 0, background: `rgba(0, 0, 0, ${scrim})` }} />
				)
			) : null}
			{c.custom?.layer === "under" ? <CustomLayer scene={scene} custom={c.custom} /> : null}
			{cornerLogo}
			{parts.length > 0 ? (
				<FitBox rect={region} u={u} justify={textPosition} align={align} maxWidth={columnMax} fitKey={fitKey} name={`${scene.id}/text`}>
					{parts}
				</FitBox>
			) : null}
			{c.lowerThird && lowerRect ? (
				<FitBox rect={lowerRect} u={u} justify="bottom" align={align} fitKey={JSON.stringify(c.lowerThird)} name={`${scene.id}/lower-third`}>
					<LowerThird content={c.lowerThird} start={enterDelay + Math.round(beat)} overMedia={overMedia} pal={pal} />
				</FitBox>
			) : null}
			{c.custom && c.custom.layer !== "under" ? <CustomLayer scene={scene} custom={c.custom} /> : null}
		</div>
	);
};

const LowerThird: React.FC<{
	content: NonNullable<TimelineContent["lowerThird"]>;
	start: number;
	overMedia: boolean;
	pal: Palette;
}> = ({ content, start, overMedia, pal }) => {
	const { theme, fonts, pace, fps } = useRender();
	const f = useCurrentFrame();
	const plate = overMedia ? "rgba(10, 10, 14, 0.66)" : theme.colors.surface;
	const text = overMedia ? "#FFFFFF" : pickReadable(theme.colors.surface, 4.5, theme.colors.text);
	const accent = overMedia ? pal.accent : pickReadable(theme.colors.surface, 2.2, theme.colors.accent, theme.colors.primary, text);
	const p = pace.ease(progress(f, start, pace.duration * fps));
	const radius = Math.min(theme.radius, 18);
	return (
		<div
			style={{
				display: "inline-flex",
				alignItems: "stretch",
				gap: U(20),
				maxWidth: "100%",
				padding: `${U(18)} ${U(30)} ${U(18)} ${U(20)}`,
				background: plate,
				borderRadius: U(radius),
				textAlign: "left",
				// Wipes open from the left; the text follows a beat later.
				clipPath: `inset(0 ${(1 - p) * 100}% 0 0 round ${U(radius)})`,
			}}
		>
			<span style={{ flex: "none", width: U(5), background: accent, borderRadius: U(3) }} />
			<div style={{ minWidth: 0, opacity: progress(f, start + pace.duration * fps * 0.35, pace.duration * fps * 0.7) }}>
				<div data-block style={{ fontFamily: fonts.heading, fontWeight: theme.fonts.heading.weight, fontSize: U(34), lineHeight: 1.18, letterSpacing: "-0.01em", color: text, overflowWrap: "anywhere" }}>
					{content.title}
				</div>
				{content.subtitle ? (
					<div style={{ marginTop: U(4), fontFamily: fonts.body, fontWeight: theme.fonts.body.weight, fontSize: U(24), lineHeight: 1.3, color: withAlpha(text, 0.74), overflowWrap: "anywhere" }}>
						{content.subtitle}
					</div>
				) : null}
			</div>
		</div>
	);
};
