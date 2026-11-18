/**
 * The project brief: one document an agent reads before making anything, so
 * that the hundredth video matches the first.
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import type { BrandKit } from "../../../shared/brand.ts";
import { db, schema } from "../db/client.ts";
import { type Project, brandCompleteness } from "./projects.ts";
import { craftIndex } from "./craft.ts";
import { unreadReviews } from "./reviews.ts";

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

	const waiting = await unreadReviews({ projectId: project.id });
	if (waiting.length) {
		const titles = new Map(
			(await db.query.videos.findMany({ where: inArray(schema.videos.id, waiting.map((review) => review.videoId)), columns: { id: true, title: true } })).map((video) => [video.id, video.title]),
		);
		lines.push("## Feedback waiting", "", "The person reviewed these videos and their notes have not been read yet. Read them with review.get before changing these videos:", "");
		for (const review of waiting) lines.push(`- "${titles.get(review.videoId) ?? review.videoId}" (\`${review.videoId}\`): review \`${review.id}\`, ${review.verdict === "approved" ? "approved" : "changes asked for"}`);
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
3. Check your work cheaply before paying for anything; these all work before any media exists. video.sheet shows every scene on one image, video.preview shows one frame (in several aspect ratios side by side, or with a trial version of a scene that is not saved), video.check lists problems with fixes (text that does not fit, narration too fast, too much text to read, late reveals, dead air, a slow opening, stretches where the picture does not change, a structure copied from other videos), video.timing gives the cue sheet as text, and video.estimate gives the length and cost.
4. Run video.prepare. It generates the narration and visuals, then times every scene, bullet and caption to the recorded voice and composes the timeline. Unchanged scenes are not regenerated, so editing one scene and preparing again only pays for that scene. Afterwards, look at the media with asset.view or video.sheet, run video.check again for the real timings (it also listens to each narration take and reports words the voice seems to have misread or skipped), and video.audio for loudness, music balance and silences. video.draft makes a quick low-resolution MP4 of any stretch to check motion or to show the person. While it runs, poll video.get with waitSeconds (it stays small; ask for storyboard: true or media: "full" only when you need them). Calling video.prepare again restarts the run with your latest changes, and video.cancel stops it. Music never holds the video up: a bed still being composed is added when it lands (pipeline.musicPending). Change only the music with video.update music, not by resending the storyboard. Change parts of scenes with scene.patch (one or many at once) rather than resending them; every storyboard change can be undone (video.history, video.restore), and video.checkpoint saves a named state before you try something bold.
5. Run video.render for each aspect ratio and resolution you need (16:9, 9:16, 1:1, 4:5; 480p to 2160p), then render.get for the download link. One timeline renders to every aspect ratio. Exports are levelled to the brand's loudness (audio.loudness, default -14 LUFS with peaks under -1 dBTP), so there is no need to post-process the sound.
6. Show the person: review.request gives a link where they watch the cut and leave notes on moments, spots on the frame or scenes, then send them with a verdict. Collect them with review.get (waitSeconds), fix, answer each with review.resolve and ask again. video.get and project.brief flag notes that arrive while you work.
7. Design the thumbnail with thumbnail.design (up to three variants, shown at feed size) and keep one with choose; it is published with the video and is its poster.
8. To put it on YouTube, run youtube.preflight, then youtube.publish with a finished render (youtube.connect gives the person a link to connect their channel first). It sends the thumbnail, chapters (scenes with a chapter title), required credits and captions. Uploads are private unless the person asks otherwise, and anything beyond private needs their approval of the cut.
9. To put it on the person's own website, or share it without YouTube, run hosting.publish with a finished render: it returns a watch page link and an embed code (captions, poster, chapters and credits included). Anyone with the link can watch, so it needs their approval of the cut too. Storage and minutes watched are billed to the account.

Files the person already has (a logo, product shots, footage, a voiceover, a font) are better than anything generated. If they mention one, or a video would clearly benefit from one, call asset.upload_link: upload the files yourself with its uploadUrl if you have them locally, or give the person its pageUrl to drop them in. Uploaded files appear in project.brief and asset.list.

The person's own recordings (a phone video of them talking, an interview, a voice memo) can be edited like footage. Uploaded videos are processed automatically: converted for editing, levelled and transcribed with word timings (footage.get shows progress; footage.process does audio, or redoes it with key terms). Read what was said with footage.transcript (timed paragraphs, with likely retakes, filler words and pauses marked) and see it with footage.view (frames labelled with what is being said). Then cut it into scenes by quoting it: a scene with footage { assetId, from: "first words", to: "last words" } lasts exactly that stretch, cut in the pauses so no word is clipped, and its captions, cues and music ducking follow the person's voice. show "speaker" puts them on screen (a media scene, or beside text in a split scene; back-to-back cuts punch in to hide the jump); show "voice" plays them over the scene's own visual (stock, a chart, a still) as b-roll. Mix footage scenes with narrated ones freely, and drop retakes by quoting around them.

Motion without clips: chart scenes animate real numbers, map scenes pin and fly between places (coordinates from place.search), and icons (icon.search) mark bullets and headings. All three are free and stay on-brand. A still with cutout "parallax" gets a 2.5D camera move, and cutout "isolate" puts its subject alone on the brand backdrop. A vector visual draws itself on in the brand colours. A Lottie animation imported with asset.import_url can be any scene's visual. Bullets, chart values and map places can each carry a cue (words from the narration) so they land as they are spoken. For anything the scene types cannot do (a diagram, kinetic type, a custom animation), give a scene a custom layer: a few lines of JavaScript that draw from the frame number with the brand's colours, fonts and the scene's spoken word times. Try it with video.preview's trial scene (errors come back as warnings) before saving it.

Costs: images and narration are cheap, and narration is far cheaper still with an OpenRouter voice model (voice.list with models: true; e.g. narration.modelId "hexgrad/kokoro-82m" costs about 1% of ElevenLabs, with captions timed the same way), and music with Lyria (audio.musicModel); suggest these when cost matters, and audition with asset.generate_speech before switching; generated video clips are expensive and limited to 3-15 seconds, so use them sparingly for moments that need motion, and prefer stills, stock footage and the brand backdrop elsewhere. The account's cost controls (in project.brief, whoami and account.controls) can switch kinds of media off or limit them; plan storyboards within them rather than asking for what is switched off, and change them only when the person asks. Call video.credits before publishing: some stock media, icon sets and all map data must be credited.

Craft: guide with a topic gives short notes on making videos people watch: ${craftIndex()}. Read the ones that matter for the video in hand; video.check measures the rest.`;
