/**
 * Craft: short notes on what makes a video worth watching, served on demand
 * (`guide` with a topic, and as MCP resources at retween://guide/<topic>) so
 * they cost no context until an agent wants them. Principles, not recipes:
 * the numbers worth enforcing live in video.check, where they are measured.
 */

export interface CraftTopic {
	topic: string;
	title: string;
	summary: string;
	body: string;
}

export const CRAFT: CraftTopic[] = [
	{
		topic: "hook",
		title: "Opening the video",
		summary: "The first seconds: say the promise, show something, skip the title card.",
		body: `Most viewers decide in the first few seconds whether to stay. Spend them on the reason to watch.

- Open on the most interesting thing you have: the result, the surprising number, the question the video answers. The title and logo can wait or sit underneath.
- Speak in the first second or two. A silent title card, a slow logo sting or a lead-in of music reads as an advert and loses people. video.check flags a late first word and a silent title opening.
- Make the first line concrete: "Gesha sells out in three weeks every year. Here is why." beats "Welcome to our video about coffee."
- Change the picture early. A first scene that holds one still for many seconds while the voice explains feels slow; cue the points through it, cut sooner, or give it motion.
- Pay off the promise. If the opening asks a question, answer it; if it shows a result, show how. Viewers who feel tricked leave and do not come back.
- Match the opening to the thumbnail and title: the person clicked on that promise, so the first seconds should confirm they are in the right place.`,
	},
	{
		topic: "pacing",
		title: "Pacing and rhythm",
		summary: "One idea per scene, keep the picture moving, let points land.",
		body: `A video holds attention by giving the eye and the ear something new at a steady rate, without rushing either.

- One idea per scene. If a scene's narration has two "and also"s, it is two scenes.
- Keep the picture changing every few seconds in the opening and regularly after it: a cut, a bullet appearing as it is said, a chart value, a map stop, a clip or footage. video.check reports long stretches where nothing changes.
- Let the voice breathe. Natural narration sits around 150-190 words a minute; faster sounds like a disclaimer. Shorter sentences beat a faster voice.
- Cue reveals to the words (bullet, chart and map cues) so things appear as they are said, not all at once and not after the scene is over.
- Vary the kind of scene. Five bullet scenes in a row feel like slides. A stat for a number, a chart for a trend, a quote for a voice, footage for a person.
- Cut what does not earn its place. A shorter video that keeps people to the end does better than a longer one they leave halfway.
- Check it the way a viewer would: video.timing for the rhythm as text, video.draft to watch a stretch, review.request to ask a person.`,
	},
	{
		topic: "structure",
		title: "Shape of a video",
		summary: "Promise, delivery in steps, a clear ending with one next step.",
		body: `Most videos that work have the same bones, whatever their length.

- Promise: what the viewer gets, in the first lines.
- Delivery: the content in a few clear steps, each building on the last. Signpost them ("First…", "The second reason…") so people know where they are; long videos get chapters (scene.chapter) so viewers can jump.
- Proof: show rather than tell where you can. A number, a demo, the person's own footage, a customer's words.
- Ending: a short recap if it is long, then one call to action. One, not three. An outro scene or text.cta carries it. video.check notes a video with no call to action.
- Build every video around its own subject. A structure reused scene for scene across a channel, with only the words changed, is what YouTube treats as mass-produced (see topic "originality").`,
	},
	{
		topic: "shorts",
		title: "Vertical and Shorts",
		summary: "9:16, under three minutes, start mid-action, captions on, safe from the UI.",
		body: `Shorts and other vertical feeds are watched on a phone, often muted at first, between swipes.

- 9:16 and three minutes or less to be a YouTube Short (youtube.preflight says whether it will be one). Most good Shorts are far shorter: 20-60 seconds.
- There is no time for a run-up: the first frame must already be interesting. No intro, no logo sting.
- Captions on, large and high in the frame; the bottom fifth is covered by the title, buttons and channel name. Keep key text in the middle.
- One idea, told fast, with a loop if you can: an ending that flows back into the start keeps replays going.
- Check the layout in 9:16 itself (video.preview with aspects, video.check aspects), since text that fits in 16:9 often shrinks or crowds in portrait.
- A Short is a cut of its own, not the long video squeezed: a few of the strongest scenes, re-ordered so the best moment comes first.`,
	},
	{
		topic: "thumbnail",
		title: "Thumbnails",
		summary: "One subject, two to four words, high contrast, readable at 168 px wide.",
		body: `The thumbnail and title together are the whole pitch in a feed, and the thumbnail is seen first and small.

- One clear subject: a face with an expression, a product, a result. Cut it out so it separates from the background (thumbnail.design subject.fromPicture, or a transparent asset).
- Two to four words, big. The words add to the title rather than repeating it: the title says the topic, the thumbnail says the stakes or the twist.
- High contrast and few elements. If it does not read in the up-next column (168 px wide, which thumbnail.design shows), it does not read.
- Keep text clear of the bottom-right corner: the duration badge covers it.
- Be honest. A thumbnail that promises something the video does not deliver gets clicks once and loses the viewer.
- Try two or three variants side by side before choosing one; the one that reads at feed size usually wins.`,
	},
	{
		topic: "publishing",
		title: "Publishing",
		summary: "Preflight, approval, title and description, chapters, disclosure, private first, hosting on the web.",
		body: `Getting a good video in front of people without surprises.

- Run youtube.preflight first: it says whether the video will be a Short, whether the export is the current cut, whether the person approved it, and what is missing (thumbnail, chapters).
- Get the person's approval of the cut (review.request) before anything goes beyond private. youtube.publish refuses unlisted, public or scheduled uploads without it.
- Title: specific and honest, the topic up front, under about 60 characters so it is not cut off. Description: the first two lines show in search, so say what the video is and who it is for; chapters and required credits are added for you.
- Disclose realistic synthetic media honestly (containsSyntheticMedia). Preflight suggests an answer from the media; generated photoreal clips or a cloned voice mean yes. Stylised graphics, stock and a narrator voice do not.
- Upload private by default and let the person publish, unless they asked for it to go out.
- For the person's own site, a landing page or a client, hosting.publish gives a watch page and an embed with no ads or suggested videos. Host the shape the page shows (16:9 for most sites, 9:16 for phones), and list allowedOrigins when only their sites should embed it.`,
	},
	{
		topic: "originality",
		title: "Originality at volume",
		summary: "Each video shaped by its own content; templates for the brand, not the story.",
		body: `Making many videos is fine; making the same video many times is not. YouTube does not pay for "inauthentic" content: generic, repetitive or template-based videos with little variation between uploads, whatever tools made them.

- Keep the template for the brand (colours, fonts, voice, captions, outro) and let each video's content decide its structure: how it opens, which scene types it uses, how long it runs.
- Bring something only this video has: real data (chart scenes), the person's own footage or voice, their products, a specific place (map scenes), a real example.
- Do not reuse opening lines or scene sequences across a series. video.check warns when a video's structure matches several others in the project, or opens with the same words.
- Fewer, better videos beat many thin ones: each should leave the viewer knowing or able to do something they could not before.`,
	},
	{
		topic: "review",
		title: "Working with a reviewer",
		summary: "Ask early on a draft, say what to look at, answer every note.",
		body: `A person's eye catches what checks cannot: whether it is interesting, whether it sounds right, whether it says the right thing.

- Ask early. A draft (review.request on a prepared video cuts one) is cheaper to change than a finished export.
- Say what you want them to look at (ask): "Is the opening strong enough?" gets better notes than "Thoughts?".
- Read the notes with review.get: each comes with its moment, scene, the point they clicked and what was being said. Group them, fix them, and answer each with review.resolve (done, or wontfix with a reason) so the next round shows what changed.
- Ask again for another round when the changes are in. Only an approved round lets the video go out beyond private.
- Save lasting preferences the reviewer states ("never use stock photos of people") with note.save or brand.update, so the next video does not repeat the mistake.`,
	},
];

export const CRAFT_TOPICS = CRAFT.map((item) => item.topic) as [string, ...string[]];

export const craftTopic = (topic: string) => CRAFT.find((item) => item.topic === topic);

/** The list of topics, for the workflow guide. */
export const craftIndex = () => CRAFT.map((item) => `${item.topic} (${item.summary})`).join("; ");
