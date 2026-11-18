/**
 * The public pages of a hosted video: the watch page (/v/<id>), the embed
 * (/embed/<id>) and its oEmbed description. Plain server-rendered HTML with no
 * app bundle, so they load fast on any site, themed with the project's brand colours.
 * Each view gets its own short-lived Stream token; see services/hosting.ts.
 */
import { env } from "cloudflare:workers";
import { resolvePalette } from "../../../shared/brand.ts";
import { embedSnippet, frameAncestors } from "../../../shared/hosting.ts";
import { stamp } from "../../../shared/publish.ts";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import { type Hosted, type Unavailable, hostedEmbedUrl, hostedPageUrl, playback } from "./hosting.ts";

const getProjectById = (projectId: string) => db.query.projects.findFirst({ where: eq(schema.projects.id, projectId) });

const esc = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const posterUrl = (row: Hosted) => (row.posterKey ? `${env.APP_URL}/v/${row.id}/poster` : undefined);

const UNAVAILABLE: Record<Unavailable, string> = {
	processing: "This video is still being prepared. Try again in a few minutes.",
	failed: "This video could not be prepared.",
	paused: "This video is not available right now.",
	account: "This video is not available right now.",
};

/** Stream's player for one view, with the poster, captions on by default and nothing preloaded until asked. */
function playerSrc(row: Hosted, token: string): string {
	const params = new URLSearchParams({ preload: "metadata", letterboxColor: "transparent" });
	const poster = posterUrl(row);
	if (poster) params.set("poster", poster);
	if (row.captionsLanguage) params.set("defaultTextTrack", row.captionsLanguage);
	return `${row.streamHost}/${token}/iframe?${params}`;
}

const PLAYER_ALLOW = "accelerometer; gyroscope; autoplay; encrypted-media; picture-in-picture; fullscreen";

function playerHtml(row: Hosted, token: string | undefined, unavailable: Unavailable | undefined): string {
	if (token) return `<iframe id="player" src="${esc(playerSrc(row, token))}" title="${esc(row.title)}" allow="${PLAYER_ALLOW}" allowfullscreen></iframe>`;
	const poster = posterUrl(row);
	return `<div class="gone"${poster ? ` style="background-image:url('${esc(poster)}')"` : ""}><p>${esc(UNAVAILABLE[unavailable ?? "paused"])}</p></div>`;
}

const notFoundHtml = (embed: boolean) =>
	`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Video not found</title>` +
	`<style>html,body{height:100%;margin:0}body{display:grid;place-items:center;background:#111;color:#bbb;font:15px/1.5 system-ui,sans-serif}</style></head>` +
	`<body><p>${embed ? "This video is no longer available." : "There is no video at this address. It may have been removed."}</p></body></html>`;

/** Headers every public page gets: never cached (tokens are per view), never sniffed. */
function headers(csp: string): HeadersInit {
	return {
		"content-type": "text/html; charset=utf-8",
		"cache-control": "private, no-store",
		"x-content-type-options": "nosniff",
		"referrer-policy": "strict-origin-when-cross-origin",
		"content-security-policy": csp,
	};
}

export async function watchPage(hostedId: string): Promise<Response> {
	const found = await playback(hostedId);
	if (!found) return new Response(notFoundHtml(false), { status: 404, headers: headers("frame-ancestors 'none'") });
	const { row, token, unavailable } = found;
	const project = await getProjectById(row.projectId);
	const brand = project?.brand ?? {};
	const palette = resolvePalette(brand.visual?.palette);
	const brandName = brand.identity?.name?.trim();
	const website = brand.identity?.website?.trim();
	const websiteUrl = website ? (/^https?:\/\//i.test(website) ? website : `https://${website}`) : undefined;
	const pageUrl = hostedPageUrl(row.id);
	const embedUrl = hostedEmbedUrl(row.id);
	const poster = posterUrl(row);
	const summary = (row.description || brand.identity?.tagline || "").replace(/\s+/g, " ").trim().slice(0, 200);
	const vertical = row.height > row.width;
	const chapters = token ? row.chapters : [];

	const html = `<!doctype html>
<html lang="${esc(row.captionsLanguage ?? "en")}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(row.title)}${brandName ? ` · ${esc(brandName)}` : ""}</title>
${summary ? `<meta name="description" content="${esc(summary)}">` : ""}
<link rel="canonical" href="${esc(pageUrl)}">
<link rel="alternate" type="application/json+oembed" href="${esc(`${env.APP_URL}/api/oembed?${new URLSearchParams({ url: pageUrl, format: "json" })}`)}" title="${esc(row.title)}">
<meta property="og:type" content="video.other">
<meta property="og:title" content="${esc(row.title)}">
<meta property="og:url" content="${esc(pageUrl)}">
${summary ? `<meta property="og:description" content="${esc(summary)}">` : ""}
${brandName ? `<meta property="og:site_name" content="${esc(brandName)}">` : ""}
${poster ? `<meta property="og:image" content="${esc(poster)}">` : ""}
<meta property="og:video:url" content="${esc(embedUrl)}">
<meta property="og:video:secure_url" content="${esc(embedUrl)}">
<meta property="og:video:type" content="text/html">
<meta property="og:video:width" content="${row.width}">
<meta property="og:video:height" content="${row.height}">
<meta name="twitter:card" content="player">
<meta name="twitter:title" content="${esc(row.title)}">
${poster ? `<meta name="twitter:image" content="${esc(poster)}">` : ""}
<meta name="twitter:player" content="${esc(embedUrl)}">
<meta name="twitter:player:width" content="${row.width}">
<meta name="twitter:player:height" content="${row.height}">
${token ? "" : '<meta name="robots" content="noindex">'}
<style>
:root{--bg:${palette.background};--text:${palette.text};--muted:${palette.mutedText};--surface:${palette.surface};--accent:${palette.accent}}
*{box-sizing:border-box}
html{background:var(--bg)}
body{margin:0;min-height:100vh;background:var(--bg);color:var(--text);font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
main{width:min(100% - 32px,${vertical ? "460px" : "1080px"});margin:0 auto;padding:clamp(16px,4vw,40px) 0 48px}
header{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:18px;font-size:14px;color:var(--muted)}
header a{color:inherit}
.frame{position:relative;aspect-ratio:${row.width} / ${row.height};width:100%;max-height:82vh;margin:0 auto;border-radius:12px;overflow:hidden;background:#000}
.frame iframe{position:absolute;inset:0;width:100%;height:100%;border:0}
.gone{position:absolute;inset:0;display:grid;place-items:center;background:#000 center/cover no-repeat}
.gone p{margin:0;padding:12px 18px;border-radius:8px;background:rgb(0 0 0 / .72);color:#eee;font-size:15px;text-align:center;max-width:80%}
h1{font-size:clamp(20px,3vw,28px);line-height:1.25;margin:20px 0 8px;text-wrap:balance}
.desc{white-space:pre-line;color:var(--text);opacity:.88;margin:0 0 20px;overflow-wrap:anywhere}
.chapters{list-style:none;margin:0 0 20px;padding:0;display:grid;gap:2px}
.chapters button{all:unset;cursor:pointer;display:flex;gap:12px;padding:8px 10px;border-radius:8px;width:100%;box-sizing:border-box}
.chapters button:hover,.chapters button:focus-visible{background:var(--surface)}
.chapters time{color:var(--accent);font-variant-numeric:tabular-nums;min-width:3.5em}
.credits{font-size:13px;color:var(--muted);margin:24px 0 0}
.credits p{margin:0 0 4px;overflow-wrap:anywhere}
footer{margin-top:32px;font-size:12px;color:var(--muted)}
footer a{color:inherit}
</style>
</head>
<body>
<main>
${brandName ? `<header><span>${websiteUrl ? `<a href="${esc(websiteUrl)}" rel="noopener">${esc(brandName)}</a>` : esc(brandName)}</span></header>` : ""}
<div class="frame">${playerHtml(row, token, unavailable)}</div>
<h1>${esc(row.title)}</h1>
${row.description ? `<p class="desc">${esc(row.description)}</p>` : ""}
${
	chapters.length
		? `<ol class="chapters" aria-label="Chapters">${chapters.map((chapter) => `<li><button type="button" data-at="${chapter.atSec}"><time>${stamp(chapter.atSec)}</time><span>${esc(chapter.title)}</span></button></li>`).join("")}</ol>`
		: ""
}
${row.credits.length ? `<div class="credits"><p><strong>Credits</strong></p>${row.credits.map((line) => `<p>${esc(line)}</p>`).join("")}</div>` : ""}
<footer>Hosted with <a href="${esc(env.APP_URL)}">Retween</a></footer>
</main>
${
	chapters.length
		? `<script src="https://embed.cloudflarestream.com/embed/sdk.latest.js"></script>
<script>
(function(){var frame=document.getElementById("player");if(!frame||!window.Stream)return;var player=Stream(frame);
document.querySelectorAll(".chapters button").forEach(function(b){b.addEventListener("click",function(){player.currentTime=Number(b.dataset.at);var p=player.play();if(p&&p.catch)p.catch(function(){});frame.scrollIntoView({block:"nearest",behavior:"smooth"});});});})();
</script>`
		: ""
}
</body>
</html>`;
	return new Response(html, { status: token || unavailable !== "failed" ? 200 : 410, headers: headers("frame-ancestors 'none'") });
}

export async function embedPage(hostedId: string): Promise<Response> {
	const found = await playback(hostedId);
	if (!found) return new Response(notFoundHtml(true), { status: 404, headers: headers("frame-ancestors *") });
	const { row, token, unavailable } = found;
	const html = `<!doctype html>
<html lang="${esc(row.captionsLanguage ?? "en")}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(row.title)}</title>
<style>
html,body{margin:0;height:100%;background:#000;overflow:hidden}
iframe{position:absolute;inset:0;width:100%;height:100%;border:0}
.gone{position:absolute;inset:0;display:grid;place-items:center;background:#000 center/cover no-repeat;font:15px/1.5 system-ui,sans-serif}
.gone p{margin:0;padding:12px 18px;border-radius:8px;background:rgb(0 0 0 / .72);color:#eee;text-align:center;max-width:80%}
</style>
</head>
<body>${playerHtml(row, token, unavailable)}</body>
</html>`;
	return new Response(html, { headers: headers(frameAncestors(row.allowedOrigins)) });
}

/** The poster image, public and cacheable: it is shown in link previews. */
export async function posterImage(hostedId: string, request: Request): Promise<Response> {
	const row = await db.query.hostedVideos.findFirst({ where: eq(schema.hostedVideos.id, hostedId), columns: { posterKey: true } });
	if (!row?.posterKey) return new Response("Not found", { status: 404 });
	const object = await env.MEDIA.get(row.posterKey, { onlyIf: request.headers });
	if (!object) return new Response("Not found", { status: 404 });
	const out = new Headers({ "cache-control": "public, max-age=3600", etag: object.httpEtag, "x-content-type-options": "nosniff" });
	object.writeHttpMetadata(out);
	if (!("body" in object) || !object.body) return new Response(null, { status: 304, headers: out });
	return new Response(object.body, { headers: out });
}

/**
 * oEmbed (https://oembed.com), so pasting a watch page link into a CMS, Notion
 * or Slack shows the player. Only for videos that play right now.
 */
export async function oembed(request: Request): Promise<Response> {
	const query = new URL(request.url).searchParams;
	if ((query.get("format") ?? "json") !== "json") return new Response("Only JSON is supported", { status: 501 });
	let target: URL;
	try {
		target = new URL(query.get("url") ?? "");
	} catch {
		return Response.json({ error: "url is required" }, { status: 400 });
	}
	const match = target.origin === new URL(env.APP_URL).origin ? target.pathname.match(/^\/(?:v|embed)\/(hst_[a-z0-9]+)\/?$/) : null;
	const found = match ? await playback(match[1]!) : null;
	if (!found?.token) return Response.json({ error: "No playable video at that address" }, { status: 404 });
	const { row } = found;
	const maxWidth = Number(query.get("maxwidth")) || Infinity;
	const maxHeight = Number(query.get("maxheight")) || Infinity;
	const scale = Math.min(1, maxWidth / row.width, maxHeight / row.height, (row.width > row.height ? 1280 : 405) / row.width);
	const width = Math.round(row.width * scale);
	const height = Math.round(row.height * scale);
	const project = await getProjectById(row.projectId);
	return Response.json(
		{
			version: "1.0",
			type: "video",
			title: row.title,
			provider_name: "Retween",
			provider_url: env.APP_URL,
			...(project?.brand.identity?.name ? { author_name: project.brand.identity.name } : {}),
			width,
			height,
			html: embedSnippet(hostedEmbedUrl(row.id), row.title, row.width, row.height).replace('style="position:relative;', `style="position:relative;max-width:${width}px;`),
			...(row.posterKey ? { thumbnail_url: posterUrl(row), thumbnail_width: row.width, thumbnail_height: row.height } : {}),
		},
		{ headers: { "cache-control": "public, max-age=300", "access-control-allow-origin": "*" } },
	);
}
