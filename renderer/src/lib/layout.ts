import type { TimelineTheme } from "../types.ts";

export type Rect = { x: number; y: number; w: number; h: number };

/** landscape 16:9, square 1:1, portrait 4:5, tall 9:16 (bucketed by aspect, so odd sizes still work). */
export type Format = "landscape" | "square" | "portrait" | "tall";

export type CaptionLayout = {
	position: TimelineTheme["captions"]["position"];
	fontSize: number;
	lineHeight: number;
	maxLines: number;
	padX: number;
	padY: number;
	/** Widest a caption line may be, excluding padding. */
	maxTextWidth: number;
	/** The strip captions are allowed to occupy. Scene content never enters it. */
	band: Rect;
};

export type FrameLayout = {
	width: number;
	height: number;
	/** Scale factor: design px (1080 short side) -> output px. */
	u: number;
	format: Format;
	/** Where text may go: inside the margins and clear of platform UI. */
	safe: Rect;
	/** Margin used by corner marks (watermark). */
	bug: { x: number; top: number; bottom: number };
};

export function frameLayout(width: number, height: number): FrameLayout {
	const u = Math.min(width, height) / 1080;
	const aspect = width / height;
	const format: Format = aspect >= 1.3 ? "landscape" : aspect >= 0.95 ? "square" : aspect >= 0.7 ? "portrait" : "tall";

	let x: number;
	let top: number;
	let bottom: number;
	let bug: FrameLayout["bug"];
	switch (format) {
		case "landscape":
			x = 120 * u;
			top = bottom = 88 * u;
			bug = { x: 56 * u, top: 48 * u, bottom: 48 * u };
			break;
		case "square":
			x = top = bottom = 84 * u;
			bug = { x: 48 * u, top: 48 * u, bottom: 48 * u };
			break;
		case "portrait":
			x = 80 * u;
			top = bottom = 92 * u;
			bug = { x: 48 * u, top: 48 * u, bottom: 48 * u };
			break;
		case "tall":
			// Platform chrome (TikTok / Reels / Shorts): keep clear of the top 10% and bottom 18%.
			x = 76 * u;
			top = height * 0.1 + 8 * u;
			bottom = height * 0.18;
			bug = { x: 56 * u, top: height * 0.1 + 8 * u, bottom: height * 0.18 };
			break;
	}

	return {
		width,
		height,
		u,
		format,
		safe: { x, y: top, w: width - 2 * x, h: height - top - bottom },
		bug,
	};
}

export type WatermarkBox = { position: NonNullable<TimelineTheme["watermark"]>["position"]; rect: Rect };

/** Where the watermark sits, given its natural aspect ratio (w / h). */
export function watermarkBox(
	frame: FrameLayout,
	watermark: NonNullable<TimelineTheme["watermark"]>,
	aspect: number,
): WatermarkBox {
	const w = watermark.scale * Math.min(frame.width, frame.height);
	const h = w / (aspect > 0 ? aspect : 3);
	const left = watermark.position.endsWith("left");
	const top = watermark.position.startsWith("top");
	return {
		position: watermark.position,
		rect: {
			x: left ? frame.bug.x : frame.width - frame.bug.x - w,
			y: top ? frame.bug.top : frame.height - frame.bug.bottom - h,
			w,
			h,
		},
	};
}

export function captionLayout(
	frame: FrameLayout,
	captions: TimelineTheme["captions"],
	watermark: WatermarkBox | null,
): CaptionLayout {
	const { u, width, height, format } = frame;
	const fontSize = { landscape: 46, square: 46, portrait: 48, tall: 54 }[format] * u;
	const lineHeight = 1.22;
	const maxLines = 2;
	const boxed = captions.background !== "none";
	const padX = boxed ? fontSize * 0.62 : 0;
	const padY = boxed ? fontSize * 0.3 : 0;
	const maxWidth = format === "landscape" ? Math.min(width * 0.72, 1340 * u) : frame.safe.w;
	const h = maxLines * fontSize * lineHeight + 2 * padY;
	const x = (width - maxWidth) / 2;

	// Captions sit a little closer to the edge than body content does.
	const edge = format === "tall" ? null : { landscape: 60, square: 60, portrait: 64 }[format] * u;
	let y: number;
	if (captions.position === "top") {
		y = edge ?? frame.safe.y;
		if (watermark?.position.startsWith("top") && overlapsX(watermark.rect, x, maxWidth, 24 * u)) {
			y = Math.max(y, watermark.rect.y + watermark.rect.h + 20 * u);
		}
	} else if (captions.position === "bottom") {
		y = height - (edge ?? height - frame.safe.y - frame.safe.h) - h;
		if (watermark?.position.startsWith("bottom") && overlapsX(watermark.rect, x, maxWidth, 24 * u)) {
			y = Math.min(y, watermark.rect.y - 20 * u - h);
		}
	} else {
		y = (height - h) / 2;
	}

	return {
		position: captions.position,
		fontSize,
		lineHeight,
		maxLines,
		padX,
		padY,
		maxTextWidth: maxWidth - 2 * padX,
		band: { x, y, w: maxWidth, h },
	};
}

const overlapsX = (r: Rect, x: number, w: number, gap: number) => r.x < x + w + gap && r.x + r.w > x - gap;

/**
 * The rectangle scene content may use: the safe area minus the caption band.
 * With centred captions the content goes above the band, unless it asked for
 * the bottom, in which case it goes below.
 */
export function contentRegion(
	frame: FrameLayout,
	caption: CaptionLayout | null,
	textPosition: "top" | "center" | "bottom",
): Rect {
	let top = frame.safe.y;
	let bottom = frame.safe.y + frame.safe.h;
	if (caption) {
		const gap = 30 * frame.u;
		const bandTop = caption.band.y;
		const bandBottom = caption.band.y + caption.band.h;
		if (caption.position === "bottom") bottom = Math.min(bottom, bandTop - gap);
		else if (caption.position === "top") top = Math.max(top, bandBottom + gap);
		else if (textPosition === "bottom") top = Math.max(top, bandBottom + gap);
		else bottom = Math.min(bottom, bandTop - gap);
	}
	return { x: frame.safe.x, y: top, w: frame.safe.w, h: Math.max(0, bottom - top) };
}

export const inset = (r: Rect, t: number, right: number, b: number, l: number): Rect => ({
	x: r.x + l,
	y: r.y + t,
	w: Math.max(0, r.w - l - right),
	h: Math.max(0, r.h - t - b),
});
