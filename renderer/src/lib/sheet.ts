/**
 * Contact-sheet geometry: tiles of mixed aspect ratios packed into rows of a
 * common height, each with a caption strip underneath.
 */

export type SheetGeometry = {
	width: number;
	height: number;
	tiles: { x: number; y: number; w: number; h: number }[];
	/** Height of the caption strip under each tile (0 when the sheet is bare). */
	label: number;
};

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/**
 * Packs tiles left to right into rows no wider than `maxWidth`. Every tile
 * gets the same height (or the one it asks for) unless it would not fit across the sheet on its own,
 * in which case it is shrunk to the sheet's width.
 *
 * A bare sheet (one tile, no labels, no padding) is just that tile, so a single
 * preview frame comes out at exactly the size it was asked for.
 */
export function sheetGeometry(aspects: number[], options: { tileHeight: number; maxWidth: number; bare?: boolean; heights?: (number | undefined)[] }): SheetGeometry {
	const bare = options.bare ?? false;
	const pad = bare ? 0 : 16;
	const gap = bare ? 0 : 12;
	const label = bare ? 0 : 26;
	const usable = Math.max(64, options.maxWidth - 2 * pad);

	const tiles: SheetGeometry["tiles"] = [];
	let x = pad;
	let y = pad;
	let rowHeight = 0;
	let right = 0;
	for (const [i, aspect] of aspects.entries()) {
		// A tile may ask for its own height, e.g. a thumbnail shown at its real size in a feed.
		let h = options.heights?.[i] ?? options.tileHeight;
		let w = Math.round(h * aspect);
		if (w > usable) {
			w = usable;
			h = Math.round(w / aspect);
		}
		if (x > pad && x + w > pad + usable) {
			x = pad;
			y += rowHeight + label + gap;
			rowHeight = 0;
		}
		tiles.push({ x, y, w, h });
		x += w + gap;
		rowHeight = Math.max(rowHeight, h);
		right = Math.max(right, x - gap);
	}
	return { width: even(right + pad), height: even(y + rowHeight + label + pad), tiles, label };
}
