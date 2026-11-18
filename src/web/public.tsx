import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { signIn } from "./session.ts";
import { Mark } from "./ui.tsx";

export function Wordmark() {
	return (
		<Link className="wordmark" to="/">
			<Mark />
			retween
		</Link>
	);
}

/** A storyboard of the kind an agent writes, to show what goes in. The times are what comes out. */
const EXAMPLE = [
	{ type: "Title", shown: "A lighter roast for longer days", said: "Spring is here, and so is the lightest roast we have ever made.", visual: "Brand backdrop", sec: 5 },
	{ type: "Media", shown: "Roasted every Tuesday", said: "We roast it in small batches every Tuesday morning, and it ships the same afternoon.", visual: "Stock: pouring coffee, close up", sec: 9 },
	{ type: "Stat", shown: "72 hours", said: "From the roaster to your door in seventy-two hours.", visual: "Counts up to 72", sec: 6 },
	{ type: "Bullets", shown: "Peach, jasmine, honey", said: "Expect peach up front, a jasmine middle, and a long honey finish.", visual: "Generated still: three cups", sec: 11 },
	{ type: "Outro", shown: "Order by Sunday", said: "Order by Sunday to be part of this week's roast.", visual: "Logo and call to action", sec: 7 },
];
const TOTAL = EXAMPLE.reduce((sum, scene) => sum + scene.sec, 0);
const stamp = (seconds: number) => `0:${String(seconds).padStart(2, "0")}`;

export function Landing({ connecting, next }: { connecting?: boolean; next?: string }) {
	let at = 0;
	const starts = EXAMPLE.map((scene) => {
		const start = at;
		at += scene.sec;
		return start;
	});
	return (
		<div className="welcome">
			<div className="welcome-top">
				<Wordmark />
			</div>
			<div className="hero">
				<h1>Storyboard in, finished video out.</h1>
				<p className="lede">
					{connecting
						? "An app is asking to make videos with your Retween account. Sign in to review the request."
						: "Retween is a video studio your agent operates. It keeps your brand, voices the script, finds or generates the pictures, times every scene to the recorded audio and renders it at any size."}
				</p>
				<div className="enter">
					<button type="button" className="btn big" onClick={() => signIn(next)}>
						Continue with Google
					</button>
					<span className="soft">New accounts are approved by an administrator.</span>
				</div>
			</div>

			<div className="specimen-cap">
				<span>An example: five scenes an agent wrote for a coffee roaster</span>
				<span className="num">{stamp(TOTAL)} once the voice is recorded</span>
			</div>
			<div className="cel">
				<div className="track" aria-hidden="true">
					{EXAMPLE.map((scene, i) => (
						<span key={scene.shown} className="seg" style={{ ["--len" as string]: scene.sec }}>
							{i + 1} {scene.type}
						</span>
					))}
				</div>
				<div className="track-keys" aria-hidden="true">
					{[...starts, TOTAL].map((start, i) => (
						<b key={start} className={i === EXAMPLE.length ? "end" : ""} style={{ left: `${(start / TOTAL) * 100}%` }} />
					))}
				</div>
				<div className="ruler" aria-hidden="true">
					{[...starts, TOTAL].map((start) => (
						<span key={start} style={{ left: `${(start / TOTAL) * 100}%` }}>
							{stamp(start)}
						</span>
					))}
				</div>
				<div className="sheet-scroll">
					<table className="xsheet" style={{ marginTop: 10 }}>
						<thead>
							<tr>
								<th className="n">
									<span className="hide">Scene</span>
								</th>
								<th>On screen</th>
								<th>Narration</th>
								<th>Picture</th>
								<th>Starts</th>
							</tr>
						</thead>
						<tbody>
							{EXAMPLE.map((scene, i) => (
								<tr key={scene.shown}>
									<td className="n">{i + 1}</td>
									<td className="shown">
										<strong>{scene.shown}</strong>
										<div className="softer">{scene.type}</div>
									</td>
									<td className="said">{scene.said}</td>
									<td className="soft">{scene.visual}</td>
									<td className="t">{stamp(starts[i]!)}</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			</div>

			<ol className="steps">
				{[
					["Brief", "A project remembers the brand: palette, fonts, voice, tone, cast, standing instructions."],
					["Storyboard", "Scenes say what is shown and said. No durations: the audio decides those."],
					["Prepare", "Narration, stills, stock and clips land first. Then every cue is timed to the voice."],
					["Render", "One timeline, laid out again for 16:9, 9:16, 1:1 and 4:5, up to 4K."],
				].map(([title, text]) => (
					<li key={title}>
						<h3>{title}</h3>
						<p>{text}</p>
					</li>
				))}
			</ol>
		</div>
	);
}

/** A single-purpose screen: consent, command-line sign-in, waiting for approval. */
export function Slate({ kind, title, children }: { kind: string; title: ReactNode; children: ReactNode }) {
	return (
		<>
			<div className="welcome" style={{ paddingBottom: 0 }}>
				<div className="welcome-top">
					<Wordmark />
				</div>
			</div>
			<div className="stage">
				<div className="cel slate">
					<p className="kind">{kind}</p>
					<h1>{title}</h1>
					{children}
				</div>
			</div>
		</>
	);
}
