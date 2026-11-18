import { type CSSProperties, type ReactNode, useEffect, useRef } from "react";
import { ELEVENLABS_VOICE_MODELS } from "../../shared/audio-models.ts";
import { ELEVENLABS, FAL_LIST_USD, containerUsdPerSecond } from "../worker/services/pricing.ts";
import { Wordmark } from "./public.tsx";
import { signIn } from "./session.ts";

const SOURCE_URL = "https://github.com/aiuitech/retween";

/** What the hosted copy adds to vendor cost. Keep in line with BILLING_MARKUP in cloudflare.config.ts. */
const MARKUP = 0.4;

/** The storyboard an agent might write for a coffee roaster. The times are what the recorded voice gives back. */
const SCENES = [
	{ type: "Title", shown: "A lighter roast for longer days", said: "Spring is here, and so is the lightest roast we have ever made.", picture: "Generated still, cut out for a camera move", sec: 5 },
	{ type: "Media", shown: "Roasted every Tuesday", said: "We roast it in small batches every Tuesday morning, and it ships the same afternoon.", picture: "Stock clip", sec: 9 },
	{ type: "Stat", shown: "72 hours", said: "From the roaster to your door in seventy-two hours.", picture: "Brand backdrop", sec: 6 },
	{ type: "Bullets", shown: "Peach, jasmine, honey", said: "Expect peach up front, a jasmine middle, and a long honey finish.", picture: "Generated still", sec: 11 },
	{ type: "Outro", shown: "Order by Sunday", said: "Order by Sunday to be part of this week's roast.", picture: "Brand backdrop", sec: 7 },
] as const;
const TOTAL_SEC = SCENES.reduce((sum, scene) => sum + scene.sec, 0);
const CHARACTERS = SCENES.reduce((sum, scene) => sum + scene.said.length, 0);
const stamp = (seconds: number) => `0:${String(seconds).padStart(2, "0")}`;

/**
 * Vendor rates, taken from the same tables billing uses where a vendor has a list price.
 * Stills are priced per request by the vendor; this is what they have averaged.
 */
const RATE = {
	voicePer1k: ELEVENLABS_VOICE_MODELS.find((model) => model.id === "eleven_multilingual_v2")?.usdPer1kCharacters ?? 0.08,
	still: 0.045,
	cutout: FAL_LIST_USD["fal-ai/birefnet/v2"] ?? 0.003,
	musicPerMinute: ELEVENLABS.musicUsdPerMinute,
	renderPerSecond: containerUsdPerSecond(),
};
/** A 1080p render takes about 1.2 times the video's length, plus a few seconds to start. */
const RENDER_SEC = Math.round(TOTAL_SEC * 1.2) + 4;

const RECEIPT = [
	{ item: "Narration", detail: `${CHARACTERS} characters`, usd: (CHARACTERS / 1000) * RATE.voicePer1k },
	{ item: "Stills", detail: "2 generated", usd: 2 * RATE.still },
	{ item: "Stock clip", detail: "1, free to use", usd: 0 },
	{ item: "Cut-out", detail: "1 subject", usd: RATE.cutout },
	{ item: "Music", detail: `${TOTAL_SEC} seconds`, usd: (TOTAL_SEC / 60) * RATE.musicPerMinute },
	{ item: "Render", detail: `${RENDER_SEC} s of machine time`, usd: RENDER_SEC * RATE.renderPerSecond },
];
const COST = RECEIPT.reduce((sum, line) => sum + line.usd, 0);
const mills = (usd: number) => `$${usd.toFixed(3)}`;
/** 0.3¢, 4.5¢, 15¢: a decimal only while it says something. */
const cents = (usd: number) => `${Number((usd * 100).toFixed(usd < 0.1 ? 1 : 0))}¢`;

/** The sheets of glass, back to front. `step` is the part of the story that lights each one. */
const PLANES = ["backdrop", "subject", "leaves", "type", "captions", "board"] as const;
type Plane = (typeof PLANES)[number];
const STEP_OF: Record<Plane, number> = { board: 1, backdrop: 2, subject: 2, leaves: 2, type: 3, captions: 4 };

/** The price label on each sheet's top edge, staggered like index tabs so every one can be read. */
const TABS: Partial<Record<Plane, { label: string; at: string }>> = {
	backdrop: { label: `still ${cents(RATE.still)}`, at: "4%" },
	subject: { label: `cut-out ${cents(RATE.cutout)}`, at: "24%" },
	type: { label: "type 0¢", at: "47%" },
	captions: { label: `voice ${cents(RATE.voicePer1k)} / 1k`, at: "62%" },
	board: { label: "storyboard 0¢", at: "83%" },
};

const img = (name: string) => `/landing/${name}.webp`;

function Price({ children, ours }: { children: ReactNode; ours?: boolean }) {
	return <span className={`price${ours ? " ours" : ""}`}>{children}</span>;
}

/** Registration crosses and a timing chart, drawn the way an animator marks a cel: in blue that the camera does not see. */
function Guides() {
	return (
		<svg className="guides" viewBox="0 0 160 90" aria-hidden="true">
			{[
				[10, 10],
				[150, 10],
				[10, 80],
				[150, 80],
			].map(([x, y]) => (
				<path key={`${x}${y}`} d={`M${x! - 4} ${y}h8M${x} ${y! - 4}v8`} />
			))}
			<path d="M22 84h116" />
			{[0, 0.06, 0.2, 0.42, 0.66, 0.86, 0.96, 1].map((at) => (
				<path key={at} d={`M${22 + at * 116} 81.5v5`} />
			))}
		</svg>
	);
}

function PlaneArt({ plane }: { plane: Plane }) {
	switch (plane) {
		case "backdrop":
			return (
				<>
					<img src={img("backdrop")} alt="" />
					<i className="contact" />
				</>
			);
		case "subject":
			return <img className="cutout" src={img("subject")} alt="" />;
		case "leaves":
			return <img src={img("foreground")} alt="" />;
		case "type":
			return (
				<p className="ad-title">
					A lighter
					<br />
					roast for
					<br />
					longer days
				</p>
			);
		case "captions":
			return (
				<p className="ad-caption">
					<span>
						Spring is here, and so is the <b>lightest roast</b>
					</span>
				</p>
			);
		case "board":
			return (
				<>
					<img src={img("sketch")} alt="" />
					<Guides />
				</>
			);
	}
}

/**
 * One frame of the example video, taken apart the way a multiplane camera holds it:
 * each part on its own sheet of glass. Scrolling lights the sheets in turn, then
 * closes the stack into the finished frame. Everything moves through CSS variables
 * set on the page root, so the picture is complete before any script runs.
 */
function Multiplane() {
	return (
		<div className="mp" aria-hidden="true">
			<div className="mp-rig">
				<div className="mp-floor" />
				{PLANES.map((plane, z) => (
					<div key={plane} className={`mp-plane is-${plane}`} data-lit={STEP_OF[plane]} style={{ "--z": z } as CSSProperties}>
						<span className="mp-pegs">
							<i />
							<i />
							<i />
						</span>
						<div className="mp-art">
							<PlaneArt plane={plane} />
						</div>
						{TABS[plane] && (
							<span className="mp-tab" style={{ "--at": TABS[plane]!.at } as CSSProperties}>
								<Price>{TABS[plane]!.label}</Price>
							</span>
						)}
					</div>
				))}
			</div>
			<p className="mp-slate">
				<span>Scene 1 of {SCENES.length}</span>
				<span className="num">
					{stamp(0)} to {stamp(SCENES[0].sec)}
				</span>
				<span>1080p, 16:9</span>
			</p>
		</div>
	);
}

/** A scene as the renderer would lay it out, small. */
function Thumb({ index }: { index: number }) {
	const scene = SCENES[index]!;
	const art = [
		<>
			<img src={img("backdrop")} alt="" />
			<img className="cutout" src={img("subject")} alt="" />
			<p className="ad-title">
				A lighter
				<br />
				roast for
				<br />
				longer days
			</p>
		</>,
		<>
			<img src={img("scene-pour")} alt="" />
			<p className="ad-lower">{scene.shown}</p>
		</>,
		<p className="ad-stat">
			<b>72</b>
			hours, roaster to door
		</p>,
		<>
			<img src={img("scene-cups")} alt="" />
			<ul className="ad-bullets">
				<li>Peach</li>
				<li>Jasmine</li>
				<li>Honey</li>
			</ul>
		</>,
		<p className="ad-outro">{scene.shown}</p>,
	][index];
	return <div className={`frame kind-${scene.type.toLowerCase()}`}>{art}</div>;
}

const STEPS: { title: string; price: ReactNode; body: ReactNode }[] = [
	{
		title: "It starts as a storyboard",
		price: <Price>0¢</Price>,
		body: (
			<>
				Your agent writes the scenes: what is shown and what is said. It leaves out durations, because the recorded voice decides those. Writing a storyboard is free. Preview
				frames and checks use a few seconds of machine time, billed like a render.
			</>
		),
	},
	{
		title: "Pictures",
		price: <Price>{cents(RATE.still)} a generated still</Price>,
		body: (
			<>
				Your own files and free stock cost nothing. A generated still is about {cents(RATE.still)}. For {cents(RATE.cutout)} more, the subject is cut out onto its own layer so
				the camera can move through the shot, which is the stack you are looking at.
			</>
		),
	},
	{
		title: "Type",
		price: <Price>0¢</Price>,
		body: (
			<>Titles, bullets, charts and maps are set in the brand's own fonts and colours, then laid out again for each aspect ratio. No vendor is involved, so nothing is charged.</>
		),
	},
	{
		title: "Voice",
		price: <Price>{cents(RATE.voicePer1k)} per 1,000 characters</Price>,
		body: (
			<>
				Narration is recorded first, and everything else is timed to it: scene lengths, captions, when each bullet lands, when the music ducks. The default voice is{" "}
				{cents(RATE.voicePer1k)} per 1,000 characters, and the cheapest is under a tenth of a cent. Music is about {cents(RATE.musicPerMinute)} a minute.
			</>
		),
	},
	{
		title: "Render",
		price: <Price>{cents(RATE.renderPerSecond * 60)} a minute</Price>,
		body: (
			<>
				A container renders the timeline to MP4 at 16:9, 9:16, 1:1 or 4:5, up to 4K. It is billed by the second while it runs, about {cents(RATE.renderPerSecond * 60)} a
				minute, and a 1080p video takes roughly as long to render as it does to watch.
			</>
		),
	},
];

/** Follows scrolling and the pointer, and writes them to the page root as CSS variables. */
function useStage() {
	const root = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const el = root.current;
		if (!el) return;
		const steps = [...el.querySelectorAll<HTMLElement>("[data-step]")];
		const calm = matchMedia("(prefers-reduced-motion: reduce)").matches;
		const last = steps.length - 1;
		let frame = 0;
		let lit = -1;
		const aim = { x: 0, y: 0 };
		const now = { x: 0, y: 0 };

		const place = () => {
			// Where the reading line sits: the middle of the screen, or lower when the stage is pinned above the text.
			const line = innerHeight * (matchMedia("(max-width: 899px)").matches ? 0.74 : 0.5);
			const centres = steps.map((step) => {
				const box = step.getBoundingClientRect();
				return box.top + box.height / 2;
			});
			let t = 0;
			if (line >= centres[last]!) t = last;
			else {
				for (let i = 0; i < last; i++) {
					if (line >= centres[i]! && line < centres[i + 1]!) t = i + (line - centres[i]!) / (centres[i + 1]! - centres[i]!);
				}
			}
			const closing = Math.max(0, Math.min(1, (t - (last - 1)) / 0.8));
			el.style.setProperty("--fold", String(closing * closing * (3 - 2 * closing)));
			const step = Math.round(t);
			if (step !== lit) {
				lit = step;
				el.dataset.lit = String(step);
				for (const item of steps) item.toggleAttribute("data-now", item.dataset.step === String(step));
			}
		};

		const drift = () => {
			now.x += (aim.x - now.x) * 0.08;
			now.y += (aim.y - now.y) * 0.08;
			el.style.setProperty("--px", now.x.toFixed(4));
			el.style.setProperty("--py", now.y.toFixed(4));
			frame = Math.abs(aim.x - now.x) + Math.abs(aim.y - now.y) > 0.002 ? requestAnimationFrame(drift) : 0;
		};
		const point = (event: PointerEvent) => {
			if (event.pointerType !== "mouse") return;
			aim.x = (event.clientX / innerWidth) * 2 - 1;
			aim.y = (event.clientY / innerHeight) * 2 - 1;
			if (!frame) frame = requestAnimationFrame(drift);
		};

		place();
		addEventListener("scroll", place, { passive: true });
		addEventListener("resize", place);
		if (!calm) addEventListener("pointermove", point, { passive: true });
		return () => {
			removeEventListener("scroll", place);
			removeEventListener("resize", place);
			removeEventListener("pointermove", point);
			cancelAnimationFrame(frame);
		};
	}, []);
	return root;
}

export function Landing({ connecting, next }: { connecting?: boolean; next?: string }) {
	const root = useStage();
	const enter = () => signIn(next);
	let at = 0;
	const starts = SCENES.map((scene) => {
		const start = at;
		at += scene.sec;
		return start;
	});
	return (
		<div className="land" ref={root} data-lit="0">
			<header className="land-top">
				<Wordmark />
				<nav aria-label="Site">
					<a href="#cost">Pricing</a>
					<a href={SOURCE_URL}>Source</a>
					<button type="button" className="btn quiet" onClick={enter}>
						Sign in
					</button>
				</nav>
			</header>

			<main>
				<section className="story">
					<div className="story-stage">
						<Multiplane />
					</div>
					<div className="story-copy">
						<div className="step opener" data-step="0">
							<h1>Agent-made video without the subscription</h1>
							<p className="lede">
								{connecting
									? "An app is asking to make videos with your Retween account. Sign in to review the request."
									: "Retween is an open-source video studio that your agent operates. Give it a storyboard and it voices the script, finds or generates the pictures, times every scene to the recording and renders the video. You pay what that video cost to make, plus 40%."}
							</p>
							<div className="enter">
								<button type="button" className="btn big" onClick={enter}>
									Continue with Google
								</button>
								<a href={SOURCE_URL}>Or host it yourself, at cost</a>
							</div>
							<p className="terms">No plan to choose. You add a card, set a monthly cap, and are billed for what you made.</p>
						</div>
						{STEPS.map((step, i) => (
							<div key={step.title} className="step" data-step={i + 1}>
								<h2>{step.title}</h2>
								{step.price}
								<p>{step.body}</p>
							</div>
						))}
					</div>
				</section>

				<section className="cost" id="cost">
					<div className="cost-head">
						<h2>What that video cost</h2>
						<p>
							The frame above is the first of five scenes in a {TOTAL_SEC}-second advert. Here is the whole storyboard, and the bill for turning it into a 1080p video.
						</p>
					</div>

					<ol className="strip">
						{SCENES.map((scene, i) => (
							<li key={scene.shown}>
								<Thumb index={i} />
								<p className="strip-when">
									<span className="num">{stamp(starts[i]!)}</span>
									{scene.type}
								</p>
								<p className="strip-said">{scene.said}</p>
								<p className="strip-picture">{scene.picture}</p>
							</li>
						))}
					</ol>

					<div className="bill">
						<div className="receipt">
							<p className="receipt-head">
								<span>retween</span>
								<span>
									{stamp(TOTAL_SEC)}, 1080p
								</span>
							</p>
							<table>
								<tbody>
									{RECEIPT.map((line) => (
										<tr key={line.item}>
											<th scope="row">
												{line.item}
												<small>{line.detail}</small>
											</th>
											<td>{mills(line.usd)}</td>
										</tr>
									))}
								</tbody>
								<tbody className="sums">
									<tr>
										<th scope="row">What the vendors charged</th>
										<td>{mills(COST)}</td>
									</tr>
									<tr className="ours">
										<th scope="row">
											<mark>Retween, 40%</mark>
										</th>
										<td>
											<mark>{mills(COST * MARKUP)}</mark>
										</td>
									</tr>
								</tbody>
								<tfoot>
									<tr>
										<th scope="row">You pay</th>
										<td>${(COST * (1 + MARKUP)).toFixed(2)}</td>
									</tr>
								</tfoot>
							</table>
							<p className="receipt-foot">An example at November 2026 vendor rates. In your account, every video shows its own.</p>
						</div>

						<div className="why">
							<h2>Why it is priced this way</h2>
							<p>
								There are plenty of tools that edit video with an agent. Nearly all of them charge a monthly subscription that costs far more than the videos most people make
								with it.
							</p>
							<p>
								I build several products and needed videos for all of them, so I built the tool myself and ran it at cost. Keeping it to myself seemed like a waste, so the code is
								open source and this site is a hosted copy of it.
							</p>
							<p>
								The hosted copy charges what each video cost to make, plus 40%. The 40% is for convenience: you skip setting up the vendor accounts, the renderer and the
								deployment. It is not a business model. I built this for my own work and would be running it either way.
							</p>
							<p>
								If you make one or two videos and never come back, you pay for one or two videos. If you would rather not pay the 40%, host it yourself and pay your vendors
								directly.
							</p>
						</div>
					</div>
				</section>

				<section className="ways">
					<h2>Two ways to run it</h2>
					<div className="ways-scroll">
						<table>
							<thead>
								<tr>
									<td />
									<th scope="col">
										Hosted, at retween.app
										<Price ours>cost + 40%</Price>
									</th>
									<th scope="col">
										Self-hosted
										<Price>cost</Price>
									</th>
								</tr>
							</thead>
							<tbody>
								<tr>
									<th scope="row">What you pay</th>
									<td>What the vendors charged for your videos, plus 40%. One bill a month, with a spend cap that starts at $10.</td>
									<td>What the vendors charge, on your own accounts with them.</td>
								</tr>
								<tr>
									<th scope="row">What you set up</th>
									<td>A Google sign-in and a card.</td>
									<td>A Cloudflare account for the Worker, database, storage and render containers, plus keys for OpenRouter and ElevenLabs.</td>
								</tr>
								<tr>
									<th scope="row">When it fits</th>
									<td>You want a video today, or a few a month, without running anything.</td>
									<td>You make enough video for the 40% to matter, or you want to change how it works.</td>
								</tr>
								<tr>
									<th scope="row">Start</th>
									<td>
										<button type="button" className="btn" onClick={enter}>
											Continue with Google
										</button>
									</td>
									<td>
										<a className="btn quiet" href={SOURCE_URL}>
											Read the setup guide
										</a>
									</td>
								</tr>
							</tbody>
						</table>
					</div>
					<p className="ways-open">
						The code is the same in both. If something is missing or wrong, <a href={`${SOURCE_URL}/pulls`}>pull requests are welcome</a>.
					</p>
				</section>

				<section className="agent">
					<div>
						<h2>Point your agent at it</h2>
						<p>
							Retween has no editor to learn. Your agent works it over MCP or the command line, and checks its own work with still frames, cue sheets and loudness readings before
							anything is rendered. The web app is where you keep brand kits, files and bills.
						</p>
					</div>
					<dl>
						<dt>MCP server</dt>
						<dd>
							<code>https://retween.app/mcp</code>
						</dd>
						<dt>Claude Code</dt>
						<dd>
							<code>claude mcp add --transport http retween https://retween.app/mcp</code>
						</dd>
						<dt>Command line</dt>
						<dd>
							<code>npm install -g https://retween.app/cli/retween.tgz</code>
						</dd>
					</dl>
				</section>
			</main>

			<footer className="land-foot">
				<Wordmark />
				<p>Open source. Built for my own videos, shared in case it is useful for yours.</p>
				<a href={SOURCE_URL}>Source on GitHub</a>
			</footer>
		</div>
	);
}
