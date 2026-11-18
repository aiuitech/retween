import { createFileRoute } from "@tanstack/react-router";
import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { clock } from "../api.ts";
import { Wordmark } from "../public.tsx";
import { type ReviewPage, loadReview, reviewCut, sendReview } from "../review.ts";
import { Empty, Field, Status, Tween } from "../ui.tsx";

/**
 * The review page: someone watches a cut and leaves notes on moments, spots
 * on the frame or whole scenes, then sends them with a verdict. Opened from a
 * link with a token, so it works without signing in.
 */
export const Route = createFileRoute("/review/$reviewId")({
	validateSearch: (search: Record<string, unknown>) => ({ t: typeof search.t === "string" ? search.t : undefined }),
	loaderDeps: ({ search }) => ({ t: search.t }),
	loader: async ({ params, deps }) => loadReview({ data: { reviewId: params.reviewId, token: deps.t } }),
	head: ({ loaderData }) => ({
		meta: [{ title: loaderData?.ok ? `Review: ${loaderData.value.title} · Retween` : "Review · Retween" }, { name: "robots", content: "noindex" }],
	}),
	component: ReviewRoute,
});

const TAGS: { tag: string; label: string }[] = [
	{ tag: "cut", label: "Cut this" },
	{ tag: "too-slow", label: "Too slow" },
	{ tag: "too-fast", label: "Too fast" },
	{ tag: "wrong-picture", label: "Wrong picture" },
	{ tag: "mispronounced", label: "Mispronounced" },
	{ tag: "text", label: "Text on screen" },
	{ tag: "sound", label: "Sound" },
	{ tag: "love-it", label: "Love this" },
];
const tagLabel = (tag?: string) => TAGS.find((item) => item.tag === tag)?.label ?? "Note";

interface Draft {
	key: string;
	atSec?: number;
	sceneId?: string;
	x?: number;
	y?: number;
	tag?: string;
	body: string;
}

const SAVED = (id: string) => `retween-review-${id}`;

function ReviewRoute() {
	const reply = Route.useLoaderData();
	if (!reply.ok) {
		return (
			<Shell>
				<main className="page narrow">
					<Empty title={reply.status === 404 ? "This review link does not work" : "This review could not be opened"}>{reply.message}</Empty>
				</main>
			</Shell>
		);
	}
	return <Review initial={reply.value} />;
}

function Shell({ children, aside }: { children: React.ReactNode; aside?: React.ReactNode }) {
	return (
		<>
			<header className="top">
				<div className="top-in">
					<Wordmark />
					<span className="soft review-where">{aside}</span>
				</div>
			</header>
			{children}
		</>
	);
}

function Review({ initial }: { initial: ReviewPage }) {
	const { reviewId } = Route.useParams();
	const { t: token } = Route.useSearch();
	const [page, setPage] = useState(initial);
	const [media, setMedia] = useState(initial.media);
	const video = useRef<HTMLVideoElement>(null);
	const [now, setNow] = useState(page.fromSec);
	const [notes, setNotes] = useState<Draft[]>([]);
	const [composer, setComposer] = useState<Draft>({ key: "new", body: "" });
	const [whole, setWhole] = useState(false);
	const [verdict, setVerdict] = useState<"approved" | "changes" | null>(null);
	const [summary, setSummary] = useState("");
	const [name, setName] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const open = page.status === "open";

	// Unsent notes survive a reload.
	useEffect(() => {
		if (!open) return;
		try {
			const saved = JSON.parse(localStorage.getItem(SAVED(reviewId)) ?? "null") as { notes?: Draft[]; summary?: string; name?: string } | null;
			if (saved?.notes?.length) setNotes(saved.notes);
			if (saved?.summary) setSummary(saved.summary);
			if (saved?.name) setName(saved.name);
		} catch {
			// Storage is a convenience.
		}
	}, [reviewId, open]);
	useEffect(() => {
		if (!open) return;
		try {
			localStorage.setItem(SAVED(reviewId), JSON.stringify({ notes, summary, name }));
		} catch {
			// Storage is a convenience.
		}
	}, [notes, summary, name, reviewId, open]);

	// A draft cut may still be rendering when the page opens.
	useEffect(() => {
		if (media.status !== "rendering") return;
		const timer = setTimeout(async () => {
			const next = await reviewCut({ data: { reviewId, token } });
			if (next.ok) setMedia(next.value);
		}, 3000);
		return () => clearTimeout(timer);
	}, [media, reviewId, token]);

	const scenes = page.scenes;
	const start = page.fromSec;
	const end = page.toSec ?? scenes.at(-1)?.endSec ?? start;
	const span = Math.max(0.1, end - start);
	const visible = scenes.filter((scene) => scene.endSec > start && scene.startSec < end);
	const sceneAt = (sec: number) => scenes.findLast((scene) => scene.startSec <= sec + 0.001) ?? scenes[0];
	const current = sceneAt(now);
	const byId = useMemo(() => new Map(scenes.map((scene) => [scene.id, scene])), [scenes]);

	const seek = (sec: number) => {
		const el = video.current;
		if (!el) return;
		el.currentTime = Math.max(0, sec - start);
		setNow(sec);
	};

	/** Starting a note stops the video and pins the note to that moment. */
	const stamp = () => {
		const el = video.current;
		if (el && !el.paused) el.pause();
		const at = (el?.currentTime ?? 0) + start;
		setComposer((draft) => (draft.body || draft.atSec !== undefined ? draft : { ...draft, atSec: Math.round(at * 10) / 10, sceneId: sceneAt(at)?.id }));
	};

	const pickPoint = (event: React.MouseEvent<HTMLDivElement>) => {
		if (!open) return;
		const box = event.currentTarget.getBoundingClientRect();
		const x = Math.round(((event.clientX - box.left) / box.width) * 1000) / 1000;
		const y = Math.round(((event.clientY - box.top) / box.height) * 1000) / 1000;
		const el = video.current;
		if (el && !el.paused) el.pause();
		const at = (el?.currentTime ?? 0) + start;
		setWhole(false);
		setComposer((draft) => ({ ...draft, x, y, atSec: Math.round(at * 10) / 10, sceneId: sceneAt(at)?.id }));
		document.getElementById("note-body")?.focus();
	};

	const add = () => {
		if (!composer.body.trim()) return;
		// A note written without pausing first is about the moment the player is on.
		const at = composer.atSec ?? Math.round(((video.current?.currentTime ?? 0) + start) * 10) / 10;
		const note: Draft = whole
			? { key: crypto.randomUUID(), sceneId: composer.sceneId ?? current?.id, tag: composer.tag, body: composer.body.trim() }
			: { ...composer, key: crypto.randomUUID(), atSec: at, sceneId: composer.sceneId ?? sceneAt(at)?.id, body: composer.body.trim() };
		setNotes((list) => [...list, note].sort((a, b) => (a.atSec ?? byId.get(a.sceneId ?? "")?.startSec ?? 0) - (b.atSec ?? byId.get(b.sceneId ?? "")?.startSec ?? 0)));
		setComposer({ key: "new", body: "" });
		setWhole(false);
	};

	const submit = async () => {
		if (!verdict) return setError("Choose whether it is ready to go, or needs changes.");
		setBusy(true);
		setError(null);
		const result = await sendReview({
			data: {
				reviewId,
				token,
				verdict,
				summary,
				reviewerName: name,
				comments: notes.map(({ atSec, sceneId, x, y, tag, body }) => ({ atSec, sceneId, x, y, tag: (tag as never) ?? null, body })),
			},
		});
		setBusy(false);
		if (!result.ok) return setError(result.message);
		try {
			localStorage.removeItem(SAVED(reviewId));
		} catch {
			// Storage is a convenience.
		}
		setPage(result.value);
		setNotes([]);
	};

	const shown = open ? notes : page.comments.map((comment) => ({ ...comment, key: comment.id }));
	const marker = composer.x !== undefined && composer.y !== undefined && composer.atSec !== undefined && Math.abs(composer.atSec - now) < 0.6;
	const portrait = page.aspect === "9:16" || page.aspect === "4:5";

	return (
		<Shell aside={`${page.project} · review, round ${page.round}`}>
			<main className="page review">
				<div className="head">
					<div className="words">
						<h1>{page.title}</h1>
						<div className="facts">
							{page.status === "submitted" ? <Status tone="ok">Notes sent</Status> : page.status === "open" ? <Status tone="busy">Waiting for your notes</Status> : <Status tone="idle">{page.status === "expired" ? "Link expired" : "Replaced by a newer round"}</Status>}
							<span>
								{clock(start)} to {clock(end)}
							</span>
							<span>{visible.length} scenes</span>
						</div>
					</div>
				</div>

				{page.ask && open && (
					<p className="note info review-ask">
						<strong>What to look at: </strong>
						{page.ask}
					</p>
				)}
				{page.outdated && open && <p className="note">The video has been changed since this cut was made. Notes still help; they are matched to the scenes as they were.</p>}
				{page.status === "closed" && <p className="note">A newer cut is waiting for review. Ask for the new link; notes can no longer be sent here.</p>}
				{page.status === "expired" && <p className="note">This link has expired. Ask for a new one to send notes.</p>}

				<div className={`review-desk${portrait ? " portrait" : ""}`}>
					<section className="review-stage">
						<div className="review-player">
							{media.status === "ready" ? (
								<>
									{/* biome-ignore lint/a11y/useMediaCaption: captions are burned into the cut when the brand uses them */}
									<video
										ref={video}
										src={media.url}
										poster={page.posterUrl}
										controls
										playsInline
										preload="metadata"
										onTimeUpdate={(event) => setNow(event.currentTarget.currentTime + start)}
										onSeeked={(event) => setNow(event.currentTarget.currentTime + start)}
									/>
									{open && (
										// biome-ignore lint/a11y/useKeyWithClickEvents: picking a spot is a pointer action; notes can be written without one
										<div className="review-hit" onClick={pickPoint} title="Click to point at something on the frame">
											{marker && <span className="review-point" style={{ left: `${composer.x! * 100}%`, top: `${composer.y! * 100}%` }} />}
											{shown
												.filter((note) => note.x !== undefined && note.y !== undefined && note.atSec !== undefined && Math.abs(note.atSec - now) < 0.6)
												.map((note) => (
													<span key={note.key} className="review-point old" style={{ left: `${note.x! * 100}%`, top: `${note.y! * 100}%` }} />
												))}
										</div>
									)}
								</>
							) : media.status === "rendering" ? (
								<div className="review-wait">
									<p>Cutting the draft for you to watch…</p>
									<Tween value={media.progress} label="Rendering the draft" />
								</div>
							) : (
								<div className="review-wait">
									<p>{media.error ?? "The cut could not be loaded."}</p>
								</div>
							)}
						</div>

						<div className="track review-track" aria-label="Scenes">
							{visible.map((scene) => (
								<button
									type="button"
									key={scene.id}
									className={`seg${current?.id === scene.id ? " lit" : ""}`}
									style={{ ["--len" as string]: Math.max(0.2, Math.min(scene.endSec, end) - Math.max(scene.startSec, start)) } as CSSProperties}
									title={`Scene ${scene.n}: ${scene.summary}`}
									onClick={() => seek(Math.max(scene.startSec, start))}
								>
									{scene.n} {scene.type}
								</button>
							))}
							{shown
								.filter((note) => note.atSec !== undefined)
								.map((note) => (
									<i key={note.key} className="review-tick" style={{ left: `${((note.atSec! - start) / span) * 100}%` }} title={`${clock(note.atSec)}: ${note.body}`} />
								))}
						</div>
						<div className="ruler" aria-hidden="true">
							<span style={{ left: 0 }}>{clock(start)}</span>
							<span style={{ left: "100%" }}>{clock(end)}</span>
						</div>
						{current && (
							<p className="review-now soft">
								<strong>
									Scene {current.n} · {current.type}
								</strong>{" "}
								{current.summary}
							</p>
						)}

						{page.earlier?.length ? (
							<div className="block">
								<div className="block-head">
									<div>
										<h2>Since the last round</h2>
										<p>Your notes on the previous cut, and what was done about each.</p>
									</div>
								</div>
								<div className="lines">
									{page.earlier.map((note) => (
										<div className="line" key={note.id}>
											<div className="grow">
												<div className="soft num">
													{note.atSec !== undefined ? clock(note.atSec) : byId.has(note.sceneId ?? "") ? `Scene ${byId.get(note.sceneId!)!.n}` : "General"} · {tagLabel(note.tag)}
												</div>
												<div>{note.body}</div>
												{note.resolution?.note && <div className="soft">{note.resolution.note}</div>}
											</div>
											{note.resolution ? <Status tone={note.resolution.status === "done" ? "ok" : "warn"}>{note.resolution.status === "done" ? "Done" : "Not changed"}</Status> : <Status>No answer</Status>}
										</div>
									))}
								</div>
							</div>
						) : null}
					</section>

					<aside className="review-notes">
						{open && (
							<div className="cel pad review-composer">
								<h2>Add a note</h2>
								<div className="review-at">
									{whole ? (
										<span>
											About scene {byId.get(composer.sceneId ?? current?.id ?? "")?.n ?? current?.n} as a whole
										</span>
									) : composer.atSec !== undefined ? (
										<span>
											At <strong className="num">{clock(composer.atSec)}</strong>, scene {byId.get(composer.sceneId ?? "")?.n}
											{composer.x !== undefined ? " · spot marked" : ""}
										</span>
									) : (
										<span>Pause on a moment, or click the frame to point at something.</span>
									)}
									<label className="review-whole">
										<input
											type="checkbox"
											checked={whole}
											onChange={(event) => {
												setWhole(event.target.checked);
												setComposer((draft) => ({ ...draft, sceneId: draft.sceneId ?? current?.id }));
											}}
										/>
										Whole scene
									</label>
								</div>
								<div className="review-tags" role="group" aria-label="What kind of note">
									{TAGS.map((item) => (
										<button
											type="button"
											key={item.tag}
											className={`tag${composer.tag === item.tag ? " blue" : ""}`}
											aria-pressed={composer.tag === item.tag}
											onClick={() => setComposer((draft) => ({ ...draft, tag: draft.tag === item.tag ? undefined : item.tag }))}
										>
											{item.label}
										</button>
									))}
								</div>
								<textarea
									id="note-body"
									placeholder="What should change here?"
									value={composer.body}
									onFocus={stamp}
									onChange={(event) => setComposer((draft) => ({ ...draft, body: event.target.value }))}
									onKeyDown={(event) => {
										if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) add();
									}}
								/>
								<div className="review-row">
									<button type="button" className="btn" disabled={!composer.body.trim()} onClick={add}>
										Add note
									</button>
									{(composer.atSec !== undefined || composer.body) && (
										<button type="button" className="btn quiet" onClick={() => setComposer({ key: "new", body: "" })}>
											Clear
										</button>
									)}
								</div>
							</div>
						)}

						<div className="review-list">
							<h2>{open ? `Your notes (${notes.length})` : `Notes (${shown.length})`}</h2>
							{shown.length === 0 ? (
								<p className="soft review-empty">{open ? "Nothing yet. Notes appear here, in the order they happen." : "No notes on particular moments."}</p>
							) : (
								<ol className="lines">
									{shown.map((note) => {
										const scene = byId.get(note.sceneId ?? "");
										return (
											<li className="line" key={note.key}>
												<div className="grow">
													<button type="button" className="text num" onClick={() => seek(note.atSec ?? scene?.startSec ?? start)}>
														{note.atSec !== undefined ? clock(note.atSec) : scene ? `Scene ${scene.n}` : "General"}
													</button>
													<span className="soft"> · {tagLabel(note.tag)}{scene && note.atSec !== undefined ? ` · scene ${scene.n}` : ""}</span>
													<div>{note.body}</div>
												</div>
												{open && (
													<button type="button" className="btn quiet small" aria-label="Remove this note" onClick={() => setNotes((list) => list.filter((item) => item.key !== note.key))}>
														Remove
													</button>
												)}
											</li>
										);
									})}
								</ol>
							)}
						</div>

						{open ? (
							<div className="cel pad review-send">
								<h2>Send your notes</h2>
								<div className="review-verdict" role="radiogroup" aria-label="Verdict">
									<label>
										<input type="radio" name="verdict" checked={verdict === "approved"} onChange={() => setVerdict("approved")} />
										Ready to go{notes.length ? " (with these small notes)" : ""}
									</label>
									<label>
										<input type="radio" name="verdict" checked={verdict === "changes"} onChange={() => setVerdict("changes")} />
										Needs changes
									</label>
								</div>
								<Field label="Anything else">
									<textarea value={summary} placeholder="Overall thoughts (optional)" onChange={(event) => setSummary(event.target.value)} />
								</Field>
								<Field label="Your name" hint="So the team knows who the notes are from (optional).">
									<input value={name} onChange={(event) => setName(event.target.value)} />
								</Field>
								{error && <p className="note bad">{error}</p>}
								<button type="button" className="btn big" disabled={busy} onClick={() => void submit()}>
									{busy ? "Sending…" : "Send notes"}
								</button>
							</div>
						) : page.status === "submitted" ? (
							<div className="cel pad">
								<h2>{page.verdict === "approved" ? "Marked ready to go" : "Changes asked for"}</h2>
								{page.summary && <p style={{ marginTop: 8 }}>{page.summary}</p>}
								<p className="soft" style={{ marginTop: 8, textAlign: "left", padding: 0 }}>
									Thank you{page.reviewerName ? `, ${page.reviewerName}` : ""}. Your notes have gone to the team making the video; when there is a new cut you will get a new link.
								</p>
							</div>
						) : null}
					</aside>
				</div>
			</main>
		</Shell>
	);
}
