import type React from "react";
import { useId } from "react";
import { useCurrentFrame } from "remotion";
import { U, useRender } from "../context.ts";
import { contrast, mix, withAlpha } from "../lib/color.ts";
import { backOut, clamp01, progress } from "../lib/motion.ts";
import type { TimelineChart } from "../types.ts";

/** Colours a chart is drawn with, taken from the scene's palette so it reads on its background. */
export type ChartPalette = { text: string; muted: string; accent: string; rule: string; base: string };

type Props = {
	chart: TimelineChart;
	/** Design px (1080 short side). Bar charts use less when they need less. */
	height: number;
	/** Landscape: the donut puts its legend beside it rather than below. */
	wide: boolean;
	pal: ChartPalette;
};

/**
 * An animated chart, laid out entirely in design units (`U`) so the
 * surrounding FitBox can shrink it with the text. Every value grows in on its
 * own `atFrame` (cued to the narration by compose) and counts up as it goes.
 */
export const Chart: React.FC<Props> = (props) => {
	switch (props.chart.kind) {
		case "bar":
			return <BarChart {...props} />;
		case "line":
			return <LineChart {...props} />;
		case "donut":
			return <DonutChart {...props} />;
		default:
			return <ColumnChart {...props} />;
	}
};

function format(chart: TimelineChart, value: number): string {
	const decimals = chart.decimals ?? (chart.points.some((point) => !Number.isInteger(point.value)) ? 1 : 0);
	const text = Math.abs(value).toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
	return `${value < 0 ? "−" : ""}${chart.prefix ?? ""}${text}${chart.suffix ?? ""}`;
}

/** Shared timing and type for every chart kind. */
function useChart(chart: TimelineChart, pal: ChartPalette) {
	const { pace, fps, fonts, theme } = useRender();
	const f = useCurrentFrame();
	const grow = pace.duration * fps * 1.35;
	/** 0..1 eased progress of one item's entrance. */
	const at = (start: number, length = grow) => pace.ease(progress(f, start, length));
	const highlighted = chart.points.some((point) => point.highlight);
	const fill = (highlight?: boolean) => (!highlighted || highlight ? pal.accent : mix(pal.text, pal.base, 0.74));
	const body: React.CSSProperties = { fontFamily: fonts.body, fontWeight: theme.fonts.body.weight };
	const strong: React.CSSProperties = { ...body, fontWeight: Math.max(700, theme.fonts.body.weight), fontVariantNumeric: "tabular-nums lining-nums" };
	return { f, fps, pace, grow, at, fill, body, strong, theme };
}

/** Axis bounds: zero is always on the axis for bars; `max` from the storyboard wins. */
function bounds(chart: TimelineChart) {
	const values = chart.points.map((point) => point.value);
	const hi = chart.max ?? Math.max(0, ...values);
	const lo = Math.min(0, ...values);
	return { hi, lo, span: hi - lo || 1 };
}

const ColumnChart: React.FC<Props> = ({ chart, height, pal }) => {
	const { at, fill, body, strong } = useChart(chart, pal);
	const n = chart.points.length;
	const { hi, span } = bounds(chart);
	const valueSize = n > 8 ? 24 : n > 5 ? 28 : 32;
	const labelSize = n > 8 ? 20 : n > 5 ? 24 : 27;
	const valueBand = chart.showValues ? valueSize * 1.9 : 12;
	const labelBand = labelSize * 2.9;
	const plotH = height - valueBand - labelBand;
	const baseline = valueBand + plotH * (hi / span);

	return (
		<div style={{ position: "relative", width: "100%", height: U(height) }}>
			<div style={{ position: "absolute", left: 0, right: 0, top: U(baseline), height: U(2), background: pal.rule }} />
			<div style={{ position: "absolute", inset: 0, display: "flex", gap: U(n > 8 ? 10 : 22) }}>
				{chart.points.map((point, i) => {
					const t = at(point.atFrame);
					const h = (Math.abs(point.value) / span) * plotH * t;
					const up = point.value >= 0;
					const top = up ? baseline - h : baseline;
					const shown = clamp01(t * 4);
					return (
						<div key={i} style={{ position: "relative", flex: 1, minWidth: 0 }}>
							<div
								style={{
									position: "absolute",
									left: "50%",
									width: `min(76%, ${U(150)})`,
									transform: "translateX(-50%)",
									top: U(top),
									height: U(h),
									background: fill(point.highlight),
									borderRadius: up ? `${U(8)} ${U(8)} 0 0` : `0 0 ${U(8)} ${U(8)}`,
								}}
							/>
							{chart.showValues ? (
								<div
									style={{
										...strong,
										position: "absolute",
										left: U(-40),
										right: U(-40),
										textAlign: "center",
										fontSize: U(valueSize),
										lineHeight: 1,
										color: point.highlight ? pal.accent : pal.text,
										top: up ? U(top - valueSize * 1.35) : U(top + h + valueSize * 0.35),
										opacity: shown,
										whiteSpace: "nowrap",
									}}
								>
									{format(chart, point.value * t)}
								</div>
							) : null}
							<div
								data-block
								style={{
									...body,
									position: "absolute",
									left: 0,
									right: 0,
									top: U(valueBand + plotH + labelSize * 0.6),
									textAlign: "center",
									fontSize: U(labelSize),
									lineHeight: 1.15,
									color: pal.muted,
									opacity: shown,
									overflowWrap: "anywhere",
									display: "-webkit-box",
									WebkitLineClamp: 2,
									WebkitBoxOrient: "vertical",
									overflow: "hidden",
								}}
							>
								{point.label}
							</div>
						</div>
					);
				})}
			</div>
		</div>
	);
};

const BarChart: React.FC<Props> = ({ chart, height, pal }) => {
	const { at, fill, body, strong } = useChart(chart, pal);
	const n = chart.points.length;
	const { lo, span } = bounds(chart);
	const row = Math.min(104, height / n);
	const thickness = row * 0.5;
	const fontSize = Math.min(32, row * 0.36);
	const zero = (-lo / span) * 100;
	// The value is printed past the end of its bar, so bars stop short of the edge to leave room.
	const reach = chart.showValues ? 82 : 100;

	return (
		<div style={{ width: "100%", display: "flex", flexDirection: "column" }}>
			{chart.points.map((point, i) => {
				const t = at(point.atFrame);
				const length = (Math.abs(point.value) / span) * reach * t;
				const up = point.value >= 0;
				const left = up ? (zero * reach) / 100 : (zero * reach) / 100 - length;
				const shown = clamp01(t * 4);
				return (
					<div key={i} style={{ display: "flex", alignItems: "center", height: U(row), gap: U(28), opacity: shown }}>
						<div
							data-block
							style={{ ...body, flex: "none", width: "28%", fontSize: U(fontSize), lineHeight: 1.15, color: pal.text, textAlign: "right", overflowWrap: "anywhere" }}
						>
							{point.label}
						</div>
						<div style={{ position: "relative", flex: 1, height: U(thickness) }}>
							<div
								style={{
									position: "absolute",
									top: 0,
									bottom: 0,
									left: `${left}%`,
									width: `${length}%`,
									background: fill(point.highlight),
									borderRadius: up ? `0 ${U(8)} ${U(8)} 0` : `${U(8)} 0 0 ${U(8)}`,
								}}
							/>
							{chart.showValues ? (
								<div
									style={{
										...strong,
										position: "absolute",
										top: "50%",
										transform: up ? "translateY(-50%)" : "translateY(-50%) translateX(-100%)",
										left: up ? `calc(${left + length}% + ${U(16)})` : `calc(${left}% - ${U(16)})`,
										fontSize: U(fontSize),
										lineHeight: 1,
										color: point.highlight ? pal.accent : pal.text,
										whiteSpace: "nowrap",
									}}
								>
									{format(chart, point.value * t)}
								</div>
							) : null}
						</div>
					</div>
				);
			})}
		</div>
	);
};

const LineChart: React.FC<Props> = ({ chart, height, pal }) => {
	const { f, pace, fps, fill, body, strong } = useChart(chart, pal);
	const points = chart.points;
	const n = points.length;
	const values = points.map((point) => point.value);
	let lo = Math.min(...values);
	let hi = chart.max ?? Math.max(...values);
	// Include zero when the data sits close to it; otherwise zoom in on the trend.
	if (lo >= 0 && lo < (hi - lo) * 0.8) lo = 0;
	const pad = (hi - lo || Math.abs(hi) || 1) * 0.08;
	hi += pad;
	if (lo !== 0) lo -= pad;
	const labelSize = 25;
	const valueSize = 28;
	const top = chart.showValues ? valueSize * 2 : 16;
	const labelBand = labelSize * 2.4;
	const plotH = height - top - labelBand;
	const xAt = (i: number) => 0.035 + (0.93 * i) / Math.max(1, n - 1);
	const yAt = (v: number) => top + ((hi - v) / (hi - lo || 1)) * plotH;

	// The line's leading edge reaches point i on its own frame, easing between points.
	const arrive: number[] = [];
	points.forEach((point, i) => arrive.push(Math.max(point.atFrame, (arrive[i - 1] ?? -1) + 1)));
	const firstStart = Math.max(0, arrive[0]! - Math.round(pace.duration * fps * 0.5));
	let head = 0;
	if (f >= arrive[n - 1]!) head = 1;
	else if (f < arrive[0]!) head = xAt(0) * pace.ease(progress(f, firstStart, arrive[0]! - firstStart));
	else {
		const i = arrive.findIndex((frame) => frame > f);
		const p = pace.ease(progress(f, arrive[i - 1]!, arrive[i]! - arrive[i - 1]!));
		head = xAt(i - 1) + (xAt(i) - xAt(i - 1)) * p;
	}

	const vb = (x: number) => (x * 1000).toFixed(2);
	const linePath = points.map((point, i) => `${i ? "L" : "M"}${vb(xAt(i))},${(yAt(point.value) / height) * 1000}`).join(" ");
	const floor = (yAt(Math.max(lo, Math.min(hi, 0))) / height) * 1000;
	const areaPath = `${linePath} L${vb(xAt(n - 1))},${floor} L${vb(xAt(0))},${floor} Z`;
	const every = n <= 8 ? 1 : Math.ceil(n / 7);
	const clipId = `line-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;

	return (
		<div style={{ position: "relative", width: "100%", height: U(height) }}>
			<div style={{ position: "absolute", left: 0, right: 0, top: U(yAt(Math.max(lo, 0))), height: U(2), background: pal.rule }} />
			<svg viewBox={`0 0 1000 1000`} preserveAspectRatio="none" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", overflow: "visible" }}>
				<defs>
					<clipPath id={clipId}>
						<rect x={0} y={-50} width={head * 1000} height={1100} />
					</clipPath>
				</defs>
				<g clipPath={`url(#${clipId})`}>
					<path d={areaPath} fill={withAlpha(pal.accent, 0.12)} />
					<path
						d={linePath}
						fill="none"
						stroke={pal.accent}
						vectorEffect="non-scaling-stroke"
						strokeLinejoin="round"
						strokeLinecap="round"
						style={{ strokeWidth: U(6) }}
					/>
				</g>
			</svg>
			{points.map((point, i) => {
				const p = progress(f, arrive[i]! - 2, pace.duration * fps * 0.8);
				if (p <= 0) return null;
				const last = i === n - 1;
				const labelled = chart.showValues && (n <= 8 || point.highlight || last);
				const dot = point.highlight || last ? 22 : 15;
				return (
					<div key={i} style={{ position: "absolute", left: `${xAt(i) * 100}%`, top: U(yAt(point.value)), width: 0, height: 0 }}>
						<div
							style={{
								position: "absolute",
								width: U(dot),
								height: U(dot),
								left: U(-dot / 2),
								top: U(-dot / 2),
								borderRadius: "50%",
								background: fill(point.highlight) === pal.accent ? pal.accent : pal.text,
								boxShadow: `0 0 0 ${U(5)} ${pal.base}`,
								transform: `scale(${backOut(p, pace.overshoot + 0.6)})`,
							}}
						/>
						{labelled ? (
							<div
								style={{
									...strong,
									position: "absolute",
									left: 0,
									bottom: U(dot / 2 + 14),
									transform: `translateX(${i === 0 ? "-15%" : last ? "-85%" : "-50%"})`,
									fontSize: U(valueSize),
									lineHeight: 1,
									color: point.highlight || last ? pal.accent : pal.text,
									whiteSpace: "nowrap",
									opacity: clamp01(p * 2),
								}}
							>
								{format(chart, point.value)}
							</div>
						) : null}
					</div>
				);
			})}
			{points.map((point, i) =>
				i % every === 0 || i === n - 1 ? (
					<div
						key={`label-${i}`}
						style={{
							...body,
							position: "absolute",
							left: `${xAt(i) * 100}%`,
							top: U(height - labelBand + labelSize * 0.7),
							transform: `translateX(${i === 0 ? "-15%" : i === n - 1 ? "-85%" : "-50%"})`,
							fontSize: U(labelSize),
							lineHeight: 1.1,
							color: pal.muted,
							whiteSpace: "nowrap",
							opacity: clamp01(progress(f, point.atFrame - 4, 8)),
						}}
					>
						{point.label}
					</div>
				) : null,
			)}
		</div>
	);
};

/** Distinct colours for donut slices, all visible on the scene's background. */
function sliceColors(chart: TimelineChart, pal: ChartPalette, theme: { primary: string; secondary: string }): string[] {
	if (chart.points.some((point) => point.highlight)) {
		let k = 0;
		return chart.points.map((point) => (point.highlight ? pal.accent : mix(pal.text, pal.base, 0.42 + 0.14 * (k++ % 4))));
	}
	const pool = [pal.accent, theme.primary, theme.secondary, mix(pal.accent, pal.base, 0.45), mix(theme.primary, pal.base, 0.45), mix(pal.text, pal.base, 0.35), mix(theme.secondary, pal.base, 0.5), mix(pal.text, pal.base, 0.6)];
	const usable = pool.filter((color, i) => contrast(color, pal.base) >= 1.35 && pool.indexOf(color) === i);
	const colors = usable.length >= 2 ? usable : [pal.accent, mix(pal.text, pal.base, 0.4)];
	return chart.points.map((_, i) => colors[i % colors.length]!);
}

const DonutChart: React.FC<Props> = ({ chart, height, wide, pal }) => {
	const { at, body, strong, theme } = useChart(chart, pal);
	const total = chart.points.reduce((sum, point) => sum + Math.max(0, point.value), 0) || 1;
	const colors = sliceColors(chart, pal, theme.colors);
	const size = Math.min(height, wide ? 470 : 500);
	const focus = chart.points.findIndex((point) => point.highlight);
	const lead = focus >= 0 ? focus : chart.points.reduce((best, point, i) => (point.value > chart.points[best]!.value ? i : best), 0);
	const leadT = at(chart.points[lead]!.atFrame);
	const leadShare = (Math.max(0, chart.points[lead]!.value) / total) * 100 * leadT;
	let start = 0;

	return (
		<div style={{ display: "flex", flexDirection: wide ? "row" : "column", alignItems: "center", gap: U(wide ? 80 : 44), width: "100%", justifyContent: "center" }}>
			<div style={{ position: "relative", flex: "none", width: U(size), height: U(size) }}>
				<svg viewBox="0 0 100 100" style={{ width: "100%", height: "100%", transform: "rotate(-90deg)", overflow: "visible" }}>
					<circle cx={50} cy={50} r={40} fill="none" stroke={pal.rule} strokeWidth={15} />
					{chart.points.map((point, i) => {
						const share = (Math.max(0, point.value) / total) * 100;
						const from = start;
						start += share;
						const shown = share * at(point.atFrame);
						if (shown <= 0.05) return null;
						const gap = chart.points.length > 1 ? Math.min(0.7, shown / 3) : 0;
						return (
							<circle
								key={i}
								cx={50}
								cy={50}
								r={40}
								fill="none"
								pathLength={100}
								stroke={colors[i]}
								strokeWidth={15}
								strokeDasharray={`${Math.max(0, shown - gap)} ${100 - Math.max(0, shown - gap)}`}
								strokeDashoffset={-from}
							/>
						);
					})}
				</svg>
				<div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
					<div style={{ ...strong, fontSize: U(size * 0.2), lineHeight: 1, letterSpacing: "-0.03em", color: pal.text }}>{`${Math.round(leadShare)}%`}</div>
					<div
						data-block
						style={{ ...body, marginTop: U(10), maxWidth: U(size * 0.52), textAlign: "center", fontSize: U(Math.max(22, size * 0.055)), lineHeight: 1.15, color: pal.muted, opacity: clamp01(leadT * 3), overflowWrap: "anywhere" }}
					>
						{chart.points[lead]!.label}
					</div>
				</div>
			</div>
			<div style={{ display: "grid", gridTemplateColumns: chart.showValues ? "auto minmax(0, auto) auto" : "auto minmax(0, auto)", alignItems: "center", columnGap: U(18), rowGap: U(18), minWidth: 0, maxWidth: U(wide ? 680 : 760) }}>
				{chart.points.map((point, i) => {
					const shown = clamp01(at(point.atFrame) * 3);
					return [
						<span key={`s${i}`} style={{ width: U(22), height: U(22), borderRadius: "50%", background: colors[i], opacity: shown }} />,
						<span key={`l${i}`} data-block style={{ ...body, minWidth: 0, fontSize: U(30), lineHeight: 1.2, color: pal.text, overflowWrap: "anywhere", opacity: shown }}>
							{point.label}
						</span>,
						chart.showValues ? (
							<span key={`v${i}`} style={{ ...strong, marginLeft: U(14), fontSize: U(30), lineHeight: 1.2, textAlign: "right", color: point.highlight ? pal.accent : pal.muted, opacity: shown }}>
								{chart.prefix || chart.suffix ? format(chart, point.value) : `${Math.round((Math.max(0, point.value) / total) * 100)}%`}
							</span>
						) : null,
					];
				})}
			</div>
		</div>
	);
};
