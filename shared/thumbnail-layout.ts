/**
 * Thumbnail sizes, kept free of imports so the Remotion bundle can use them
 * (the composition may only import types from the rest of shared/).
 */

/** YouTube's recommended thumbnail size, and the largest file it accepts. */
export const THUMBNAIL_SIZE = { width: 1280, height: 720 } as const;
export const THUMBNAIL_MAX_BYTES = 2 * 1024 * 1024;

/** Where thumbnails are seen, at their real size in CSS pixels. The headline has to read at the smallest. */
export const FEED_SIZES = [
	{ name: "home feed", width: 360, height: 202 },
	{ name: "up next", width: 168, height: 94 },
] as const;

/** Headline size in design px at a 1080 short side (the renderer's type scale for thumbnails). */
export const HEADLINE_DESIGN_PX = 230;
