import type React from "react";
import { useLayoutEffect, useRef, useState } from "react";
import { useRender } from "../context.ts";
import type { Rect } from "../lib/layout.ts";
import { FIT_REPORT_PREFIX, type FitReport } from "../lib/report.ts";

const MIN_SCALE = 0.3;

/**
 * Lays its children out inside `rect` and shrinks them until they fit.
 *
 * Children size everything with `U(n)` (a multiple of the `--u` custom
 * property), so shrinking is a single variable change that scales type,
 * spacing and rules together and lets text re-wrap at the new size.
 *
 * Measurement uses layout boxes only (`offsetHeight` / `offsetWidth`), which
 * transforms and opacity do not affect. Every text animation in this project
 * is transform/opacity based and keeps its final text in the DOM, so the fit
 * is identical on every frame and in every render tab.
 *
 * Elements marked `data-w` are unbreakable words: they must fit inside their
 * nearest `data-block` ancestor. If the content still does not fit at the
 * minimum scale, the whole block is scaled down as a last resort - text is
 * never clipped.
 *
 * Whenever it shrinks anything it logs a `FitReport` (see FIT_REPORT_PREFIX).
 */
export const FitBox: React.FC<{
	rect: Rect;
	/** Design px -> output px at scale 1. */
	u: number;
	justify: "top" | "center" | "bottom";
	align: "left" | "center";
	/** Cap on the column width, in output px. */
	maxWidth?: number;
	/** Changes whenever the content that affects layout changes. */
	fitKey: string;
	/** Names this box in layout reports, e.g. `intro/text`. */
	name: string;
	children: React.ReactNode;
}> = ({ rect, u, justify, align, maxWidth, fitKey, name, children }) => {
	const { probe } = useRender();
	const inner = useRef<HTMLDivElement>(null);
	const [fit, setFit] = useState({ scale: 1, squash: 1 });
	const width = Math.min(rect.w, maxWidth ?? rect.w);

	useLayoutEffect(() => {
		const el = inner.current;
		if (!el) return;
		el.style.transform = "none";
		const fits = (scale: number) => {
			el.style.setProperty("--u", `${u * scale}px`);
			if (el.offsetHeight > rect.h + 0.5) return false;
			for (const word of el.querySelectorAll<HTMLElement>("[data-w]")) {
				const block = word.closest<HTMLElement>("[data-block]") ?? el;
				if (word.offsetWidth > block.clientWidth + 0.5) return false;
			}
			return true;
		};

		let scale = 1;
		let squash = 1;
		if (!fits(1)) {
			if (!fits(MIN_SCALE)) {
				scale = MIN_SCALE;
				squash = Math.min(1, rect.h / Math.max(1, el.offsetHeight), ...[...el.querySelectorAll<HTMLElement>("[data-w]")].map((w) => width / Math.max(1, w.offsetWidth)));
			} else {
				let lo = MIN_SCALE;
				let hi = 1;
				for (let i = 0; i < 8; i++) {
					const mid = (lo + hi) / 2;
					if (fits(mid)) lo = mid;
					else hi = mid;
				}
				scale = lo;
			}
		}
		el.style.setProperty("--u", `${u * scale}px`);
		el.style.transform = squash < 1 ? `scale(${squash})` : "none";
		setFit((prev) => (prev.scale === scale && prev.squash === squash ? prev : { scale, squash }));
		if (scale < 0.995 || squash < 0.995) {
			const report: FitReport = { probe, box: name, scale: Math.round(scale * 1000) / 1000, squash: Math.round(squash * 1000) / 1000 };
			console.log(FIT_REPORT_PREFIX + JSON.stringify(report));
		}
	}, [fitKey, u, rect.h, width, name, probe]);

	const origin = `${align === "center" ? "center" : "left"} ${justify}`;
	return (
		<div
			style={{
				position: "absolute",
				left: rect.x,
				top: rect.y,
				width: rect.w,
				height: rect.h,
				display: "flex",
				flexDirection: "column",
				justifyContent: justify === "top" ? "flex-start" : justify === "bottom" ? "flex-end" : "center",
				alignItems: align === "center" ? "center" : "flex-start",
			}}
		>
			<div
				ref={inner}
				style={
					{
						"--u": `${u * fit.scale}px`,
						width,
						flex: "none",
						textAlign: align,
						transform: fit.squash < 1 ? `scale(${fit.squash})` : "none",
						transformOrigin: origin,
					} as React.CSSProperties
				}
			>
				{children}
			</div>
		</div>
	);
};
