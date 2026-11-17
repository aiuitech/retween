/**
 * The project brief: one document an agent reads before making anything, so
 * that the hundredth video matches the first.
 */
import { and, desc, eq } from "drizzle-orm";
import type { BrandKit } from "../../../shared/brand.ts";
import { db, schema } from "../db/client.ts";
import { type Project, brandCompleteness } from "./projects.ts";

const humanise = (key: string) =>
	key
		.replace(/([a-z])([A-Z])/g, "$1 $2")
		.replace(/Id\b/, "")
		.replace(/^./, (c) => c.toUpperCase())
		.trim();

function render(value: unknown, depth = 0): string[] {
	const pad = "  ".repeat(depth);
	if (Array.isArray(value)) {
		if (value.every((item) => typeof item !== "object")) return [`${pad}${value.join("; ")}`];
		return value.flatMap((item) => {
			if (typeof item !== "object" || item === null) return [`${pad}- ${item}`];
			const entries = Object.entries(item).filter(([, v]) => v !== undefined && v !== "" && !(Array.isArray(v) && !v.length));
			const [first, ...rest] = entries;
			if (!first) return [];
			return [
				`${pad}- **${String(first[1])}**`,
				...rest.map(([key, v]) => `${pad}  ${humanise(key)}: ${Array.isArray(v) ? v.join("; ") : typeof v === "object" ? JSON.stringify(v) : v}`),
			];
		});
	}
	if (value && typeof value === "object") {
		return Object.entries(value).flatMap(([key, v]) => {
			if (v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length)) return [];
			if (typeof v === "object") {
				const body = render(v, depth + 1);
				if (!body.length) return [];
				const inline = Array.isArray(v) && v.every((item) => typeof item !== "object");
				return inline ? [`${pad}- ${humanise(key)}: ${body[0]!.trim()}`] : [`${pad}- ${humanise(key)}:`, ...body];
			}
			return [`${pad}- ${humanise(key)}: ${v}`];
		});
	}
	return value === undefined || value === null ? [] : [`${pad}${value}`];
}

const SECTIONS: [keyof BrandKit, string][] = [
	["identity", "Who the brand is"],
	["audience", "Who the videos are for"],
	["messaging", "How it writes"],
	["narration", "How it sounds (voice)"],
	["visual", "How it looks"],
	["motion", "How it moves"],
	["captions", "Captions"],
	["audio", "Music and sound"],
	["format", "Format and pacing"],
	["cast", "Cast: recurring people, products and places"],
];

export async function projectBrief(project: Project): Promise<string> {
	const brand = project.brand;
	const [pinned, library] = await Promise.all([
		db.query.notes.findMany({
			where: and(eq(schema.notes.projectId, project.id), eq(schema.notes.pinned, true)),
			orderBy: desc(schema.notes.updatedAt),
			limit: 40,
		}),
		db.query.assets.findMany({
			where: and(eq(schema.assets.projectId, project.id), eq(schema.assets.status, "ready")),
			orderBy: desc(schema.assets.createdAt),
			limit: 200,
		}),
	]);

	const lines: string[] = [`# ${project.name}: production brief`, ""];
	if (project.description) lines.push(project.description, "");

	if (brand.instructions?.trim()) lines.push("## Standing instructions", "", brand.instructions.trim(), "");

	for (const [key, title] of SECTIONS) {
		const body = render(brand[key]);
		if (body.length) lines.push(`## ${title}`, "", ...body, "");
	}

	if (pinned.length) {
		lines.push("## Notes", "");
		for (const note of pinned) lines.push(`### ${note.title} (${note.kind})`, "", note.body.trim(), "");
	}

	const reusable = library.filter((asset) => !asset.tags.includes("auto"));
	if (reusable.length) {
		lines.push("## Library", "", "Reusable assets in this project (use the id as `assetId`):", "");
		for (const asset of reusable.slice(0, 60)) {
			const details = [
				asset.kind,
				asset.tags.length ? `tags: ${asset.tags.join(", ")}` : "",
				asset.width && asset.height ? `${asset.width}×${asset.height}` : "",
				asset.durationMs ? `${(asset.durationMs / 1000).toFixed(1)}s` : "",
			].filter(Boolean);
			lines.push(`- \`${asset.id}\` ${asset.name} (${details.join(", ")})${asset.description ? `: ${asset.description}` : ""}`);
		}
		if (reusable.length > 60) lines.push(`- …and ${reusable.length - 60} more (asset.list)`);
		lines.push("");
	}

	const { missing } = brandCompleteness(brand);
	if (missing.length) {
		lines.push(
			"## Not defined yet",
			"",
			`These parts of the brand kit are empty: ${missing.join(", ")}.`,
			"Sensible defaults are used until they are set. If the person you are working with states a preference that belongs in one of them, save it with brand.update so it sticks.",
			"",
		);
	}
	return lines.join("\n");
}

/** How to use the service, given to agents as MCP server instructions and by `guide`. */
export const WORKFLOW_GUIDE = `Retween makes finished videos from a storyboard. Work in this order:

1. Pick a project (project.list / project.create) and read project.brief. It holds the brand kit, voice, look, standing instructions and reusable assets. Follow it. When the person states a lasting preference, save it (brand.update for structured settings, note.save for anything else) so future videos stay consistent.
2. Create a video (video.create) with a storyboard: an ordered list of scenes. Each scene has a type (title, media, bullets, quote, stat, split, chart, map, outro), optional narration (what the voice says), a visual (an existing asset, a generated image or vector illustration, free stock, a short generated clip, or the brand backdrop) and on-screen text. Do not put durations in scenes: a scene lasts as long as its narration.
3. Check the layout cheaply with video.preview (one frame, works before any media exists) and the length with video.estimate.
4. Run video.prepare. It generates the narration and visuals, then times every scene, bullet and caption to the recorded voice and composes the timeline. Unchanged scenes are not regenerated, so editing one scene and preparing again only pays for that scene.
5. Run video.render for each aspect ratio and resolution you need (16:9, 9:16, 1:1, 4:5; 480p to 2160p), then render.get for the download link. One timeline renders to every aspect ratio.
6. To put it on YouTube, use youtube.publish with a finished render (youtube.connect gives the person a link to connect their channel first). It appends required credits and adds captions; uploads are private unless the person asks otherwise.

Files the person already has (a logo, product shots, footage, a voiceover, a font) are better than anything generated. If they mention one, or a video would clearly benefit from one, call asset.upload_link: upload the files yourself with its uploadUrl if you have them locally, or give the person its pageUrl to drop them in. Uploaded files appear in project.brief and asset.list.

Motion without clips: chart scenes animate real numbers, map scenes pin and fly between places (coordinates from place.search), and icons (icon.search) mark bullets and headings. All three are free and stay on-brand. A still with cutout "parallax" gets a 2.5D camera move, and cutout "isolate" puts its subject alone on the brand backdrop. A vector visual draws itself on in the brand colours. A Lottie animation imported with asset.import_url can be any scene's visual. Bullets, chart values and map places can each carry a cue (words from the narration) so they land as they are spoken.

Costs: images and narration are cheap; generated video clips are expensive and limited to 3-15 seconds, so use them sparingly for moments that need motion, and prefer stills, stock footage and the brand backdrop elsewhere. The account's cost controls (in project.brief, whoami and account.controls) can switch kinds of media off or limit them; plan storyboards within them rather than asking for what is switched off, and change them only when the person asks. Call video.credits before publishing: some stock media, icon sets and all map data must be credited.`;
