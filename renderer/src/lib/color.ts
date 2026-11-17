/**
 * Colour helpers. Parsing goes through a 1x1 canvas so that anything the
 * browser understands (hex, rgb(), hsl(), oklch(), named colours) works.
 */
export type RGB = { r: number; g: number; b: number; a: number };

const cache = new Map<string, RGB>();
let ctx: CanvasRenderingContext2D | null = null;

export function parseColor(input: string): RGB {
	const hit = cache.get(input);
	if (hit) return hit;
	let out: RGB = { r: 0, g: 0, b: 0, a: 1 };
	const hex = /^#([0-9a-f]{3,8})$/i.exec(input.trim());
	if (hex && [3, 4, 6, 8].includes(hex[1]!.length)) {
		let h = hex[1]!;
		if (h.length <= 4) h = [...h].map((c) => c + c).join("");
		out = {
			r: parseInt(h.slice(0, 2), 16),
			g: parseInt(h.slice(2, 4), 16),
			b: parseInt(h.slice(4, 6), 16),
			a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
		};
	} else if (typeof document !== "undefined") {
		ctx ??= Object.assign(document.createElement("canvas"), { width: 1, height: 1 }).getContext("2d", {
			willReadFrequently: true,
		});
		if (ctx) {
			ctx.clearRect(0, 0, 1, 1);
			ctx.fillStyle = "#000";
			ctx.fillStyle = input;
			ctx.fillRect(0, 0, 1, 1);
			const d = ctx.getImageData(0, 0, 1, 1).data;
			const a = d[3]! / 255;
			// getImageData is un-premultiplied already; alpha 0 means "unparseable or transparent".
			out = { r: d[0]!, g: d[1]!, b: d[2]!, a };
		}
	}
	cache.set(input, out);
	return out;
}

export const rgba = (c: RGB, alpha = c.a) =>
	`rgba(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)}, ${Math.round(alpha * 1000) / 1000})`;

/** `color` at the given opacity. */
export const withAlpha = (color: string, alpha: number) => rgba(parseColor(color), alpha);

/** Linear mix in sRGB: t=0 gives `a`, t=1 gives `b`. */
export function mix(a: string, b: string, t: number): string {
	const A = parseColor(a);
	const B = parseColor(b);
	return rgba({
		r: A.r + (B.r - A.r) * t,
		g: A.g + (B.g - A.g) * t,
		b: A.b + (B.b - A.b) * t,
		a: A.a + (B.a - A.a) * t,
	});
}

const lin = (v: number) => {
	const s = v / 255;
	return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};

export function luminance(color: string): number {
	const c = parseColor(color);
	return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

/** WCAG contrast ratio, 1..21. */
export function contrast(a: string, b: string): number {
	const la = luminance(a);
	const lb = luminance(b);
	return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export const isDark = (color: string) => luminance(color) < 0.4;

const INK = "#0B0B0F";
const PAPER = "#FFFFFF";

/** Black or white, whichever reads better on `bg`. */
export const readableOn = (bg: string) => (contrast(PAPER, bg) >= contrast(INK, bg) ? PAPER : INK);

/** `preferred` if it has at least `min` contrast against `bg`, otherwise the first fallback that does. */
export function pickReadable(bg: string, min: number, preferred: string, ...fallbacks: string[]): string {
	for (const c of [preferred, ...fallbacks]) if (contrast(c, bg) >= min) return c;
	return readableOn(bg);
}

function toHsl(c: RGB): [number, number, number] {
	const r = c.r / 255;
	const g = c.g / 255;
	const b = c.b / 255;
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	const l = (max + min) / 2;
	if (max === min) return [0, 0, l];
	const d = max - min;
	const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
	const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
	return [h * 60, s, l];
}

/**
 * A tone of `color` that sits `step` lightness away from `base`: same hue, softened saturation.
 * Unlike mixing, this keeps the hue readable (blue over cream stays blue instead of going grey).
 */
export function tone(base: string, color: string, step: number, saturation = 0.5): string {
	const [, , baseL] = toHsl(parseColor(base));
	const [h, s] = toHsl(parseColor(color));
	const l = Math.min(0.97, Math.max(0.03, baseL < 0.5 ? baseL + step : baseL - step));
	return `hsl(${h.toFixed(1)}, ${(Math.min(s, 0.75) * saturation * 100).toFixed(1)}%, ${(l * 100).toFixed(1)}%)`;
}
