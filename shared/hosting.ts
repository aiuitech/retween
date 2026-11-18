/**
 * Videos hosted by Retween (on Cloudflare Stream) and played from its own
 * watch page and embed: captions, who may embed them, and the embed snippet.
 * Pure, no I/O.
 */
import type { Timeline } from "./timeline.ts";

const vttTime = (seconds: number) => {
	const ms = Math.max(0, Math.round(seconds * 1000));
	const pad = (n: number, width = 2) => String(n).padStart(width, "0");
	return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor(ms / 60_000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}.${pad(ms % 1000, 3)}`;
};

/** The video's captions as WebVTT, timed to the recorded narration. Empty when there is no narration. */
export function captionsVtt(timeline: Timeline): string {
	const cues = timeline.captions
		.filter((caption) => caption.text.trim() && caption.endFrame > caption.startFrame)
		.map((caption) => `${vttTime(caption.startFrame / timeline.fps)} --> ${vttTime(caption.endFrame / timeline.fps)}\n${caption.text.trim().replace(/-->/g, "→")}`);
	return cues.length ? `WEBVTT\n\n${cues.join("\n\n")}\n` : "";
}

/**
 * Sites allowed to embed a hosted video, as given by a person ("example.com",
 * "https://www.example.com/page", "*.example.com"), reduced to the origins a
 * Content-Security-Policy `frame-ancestors` list takes. Throws on anything
 * that is not a host name.
 */
export function normalizeOrigins(entries: string[]): string[] {
	const out = new Set<string>();
	for (const raw of entries) {
		const entry = raw.trim().toLowerCase();
		if (!entry) continue;
		const withScheme = /^[a-z][a-z0-9+.-]*:\/\//.test(entry) ? entry : `https://${entry}`;
		const wildcard = withScheme.match(/^(https?):\/\/\*\.(.+)$/);
		let url: URL;
		try {
			url = new URL(wildcard ? `${wildcard[1]}://${wildcard[2]}` : withScheme);
		} catch {
			throw new Error(`"${raw}" is not a web address`);
		}
		if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`"${raw}" is not a web address`);
		if (!/^[a-z0-9.-]+$/.test(url.hostname) || (!url.hostname.includes(".") && url.hostname !== "localhost")) throw new Error(`"${raw}" is not a host name`);
		out.add(`${url.protocol}//${wildcard ? "*." : ""}${url.host}`);
	}
	return [...out];
}

/** The `frame-ancestors` directive for an embed: anywhere when no sites are listed. */
export const frameAncestors = (origins: string[]) => `frame-ancestors ${origins.length ? ["'self'", ...origins].join(" ") : "*"}`;

const escapeAttr = (text: string) => text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/**
 * HTML to paste into a page: a responsive iframe that keeps the video's shape
 * at any width.
 */
export function embedSnippet(embedUrl: string, title: string, width: number, height: number): string {
	const ratio = width && height ? `${width} / ${height}` : "16 / 9";
	return (
		`<div style="position:relative;aspect-ratio:${ratio};width:100%;">` +
		`<iframe src="${escapeAttr(embedUrl)}" title="${escapeAttr(title)}" style="position:absolute;inset:0;width:100%;height:100%;border:0;" ` +
		`allow="accelerometer; gyroscope; autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen loading="lazy"></iframe></div>`
	);
}
