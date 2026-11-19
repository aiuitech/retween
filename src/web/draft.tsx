/**
 * Watching the video as it stands, before exporting: a quick low-resolution
 * draft cut (video.draft) played on the video page. The last draft is
 * remembered per video in this browser, so coming back to the page shows it
 * again until the video changes.
 */
import { useEffect, useRef, useState } from "react";
import { clock, op } from "./api.ts";
import type { VideoDetail } from "./types.ts";
import { Empty, Tween, useToast } from "./ui.tsx";

/** Longest draft the preview renderer cuts (MAX_DRAFT_SECONDS in the video.draft operation). */
const MAX_DRAFT_SECONDS = 180;

interface DraftReply {
	draftId: string;
	status: "rendering" | "done" | "failed";
	progress?: number;
	url?: string;
	error?: string;
	warnings?: string[];
	draft?: true;
}

/** What is kept between visits: enough to fetch a fresh link and to tell whether the video changed since. */
interface Kept {
	draftId: string;
	/** The video's updatedAt when the draft was cut. */
	cutOf: string;
	/** Cut before every piece of media existed: estimated timing, no voice, placeholder pictures. */
	placeholder?: boolean;
	/** First and last scene of a partial cut. */
	range?: [string, string];
}

export interface DraftState {
	kept: Kept | null;
	/** "loading" while a remembered draft is being looked up. */
	status: "idle" | "loading" | "rendering" | "done" | "failed";
	/** Cut on this visit, so it may start playing by itself. */
	fresh: boolean;
	progress?: number;
	url?: string;
	error?: string;
	warnings: string[];
	/** The video changed after this draft was cut. */
	stale: boolean;
	starting: boolean;
	/** Shown when the whole video is too long for one draft. */
	needsRange: boolean;
	from: string;
	to: string;
	setFrom: (sceneId: string) => void;
	setTo: (sceneId: string) => void;
	/** Seconds the chosen stretch lasts, when the video has been timed. */
	rangeSeconds?: number;
	cut: () => Promise<void>;
}

const storeKey = (videoId: string) => `retween:draft:${videoId}`;

function recall(videoId: string): Kept | null {
	try {
		const raw = localStorage.getItem(storeKey(videoId));
		return raw ? (JSON.parse(raw) as Kept) : null;
	} catch {
		return null;
	}
}

function keep(videoId: string, kept: Kept | null) {
	try {
		if (kept) localStorage.setItem(storeKey(videoId), JSON.stringify(kept));
		else localStorage.removeItem(storeKey(videoId));
	} catch {
		// private window or storage blocked: the draft just is not remembered
	}
}

/** The longest run of scenes from `from` that fits in one draft. */
function fitFrom(video: VideoDetail, from: string): string {
	const timed = video.timeline?.scenes ?? [];
	const start = timed.findIndex((scene) => scene.id === from);
	if (start < 0) return video.storyboard.scenes.at(-1)?.id ?? from;
	let last = timed[start]!.id;
	for (const scene of timed.slice(start)) {
		if (scene.startSec + scene.durationSec - timed[start]!.startSec > MAX_DRAFT_SECONDS) break;
		last = scene.id;
	}
	return last;
}

export function useDraft(video: VideoDetail): DraftState {
	const toast = useToast();
	const scenes = video.storyboard.scenes;
	const [kept, setKept] = useState<Kept | null>(null);
	const [reply, setReply] = useState<DraftReply | null>(null);
	const [starting, setStarting] = useState(false);
	const [fresh, setFresh] = useState(false);
	const [tooLong, setTooLong] = useState(false);
	const tooLongTimed = (video.timeline?.durationSec ?? 0) > MAX_DRAFT_SECONDS;
	const needsRange = tooLongTimed || tooLong;
	const first = scenes[0]?.id ?? "";
	const [from, setFromState] = useState(first);
	const [to, setTo] = useState(() => (tooLongTimed ? fitFrom(video, first) : (scenes.at(-1)?.id ?? "")));
	const watching = useRef(0);

	// Picking a new start moves the end along so the stretch still fits.
	const setFrom = (sceneId: string) => {
		setFromState(sceneId);
		const order = scenes.map((scene) => scene.id);
		if (order.indexOf(to) < order.indexOf(sceneId) || video.timeline) setTo(video.timeline ? fitFrom(video, sceneId) : sceneId);
	};

	/** Follows a draft until it is done or failed. A newer cut stops the older loop. */
	const follow = async (draftId: string) => {
		const run = ++watching.current;
		for (;;) {
			let next: DraftReply;
			try {
				next = await op<DraftReply>("video.draft", { videoId: video.id, draftId, waitSeconds: 20 });
			} catch (error) {
				if (run !== watching.current) return;
				setReply({ draftId, status: "failed", error: error instanceof Error ? error.message : "Could not check on the draft." });
				return;
			}
			if (run !== watching.current) return;
			setReply(next);
			if (next.status !== "rendering") return;
		}
	};

	// Coming back to the page: pick up the remembered draft (and a fresh link to it).
	// biome-ignore lint/correctness/useExhaustiveDependencies: once per video
	useEffect(() => {
		const remembered = recall(video.id);
		setKept(remembered);
		setReply(null);
		if (remembered) void follow(remembered.draftId);
		return () => {
			watching.current++;
		};
	}, [video.id]);

	const cut = async () => {
		const order = scenes.map((scene) => scene.id);
		const partial = needsRange && (from !== order[0] || to !== order.at(-1));
		const range = needsRange ? ([from, to] as [string, string]) : undefined;
		if (range && order.indexOf(range[1]) < order.indexOf(range[0])) {
			toast("The last scene comes before the first. Pick them again.", true);
			return;
		}
		setStarting(true);
		try {
			const started = await op<DraftReply>("video.draft", {
				videoId: video.id,
				...(range ? { sceneIds: order.slice(order.indexOf(range[0]), order.indexOf(range[1]) + 1) } : {}),
				waitSeconds: 0,
			});
			// Stop following any older draft so it cannot overwrite this one.
			watching.current++;
			const next: Kept = { draftId: started.draftId, cutOf: video.updatedAt, placeholder: started.draft, range: partial ? range : undefined };
			keep(video.id, next);
			setKept(next);
			setReply(started);
			setFresh(true);
			setTooLong(false);
			if (started.status === "rendering") void follow(started.draftId);
		} catch (error) {
			const message = error instanceof Error ? error.message : "The draft could not be started. Try again.";
			if (/draft is at most/i.test(message)) {
				setTooLong(true);
				toast("The video is longer than one draft can be. Pick the scenes to watch.", true);
			} else toast(message, true);
		} finally {
			setStarting(false);
		}
	};

	const timed = video.timeline?.scenes;
	const start = timed?.find((scene) => scene.id === from);
	const end = timed?.find((scene) => scene.id === to);
	return {
		kept,
		status: reply?.status ?? (kept ? "loading" : "idle"),
		fresh,
		progress: reply?.progress,
		url: reply?.url,
		error: reply?.error,
		warnings: (reply?.warnings ?? []).filter((warning) => !(kept?.placeholder && /has not been generated yet/.test(warning))),
		stale: Boolean(kept && kept.cutOf !== video.updatedAt),
		starting,
		needsRange,
		from,
		to,
		setFrom,
		setTo,
		rangeSeconds: start && end ? end.startSec + end.durationSec - start.startSec : undefined,
		cut,
	};
}

const sceneName = (video: VideoDetail, sceneId: string) => {
	const index = video.storyboard.scenes.findIndex((scene) => scene.id === sceneId);
	const scene = video.storyboard.scenes[index];
	return scene ? `${index + 1}. ${scene.label || scene.type}` : sceneId;
};

/** The player block on the video page. */
export function DraftBlock({ video, draft, canCut, blocked }: { video: VideoDetail; draft: DraftState; canCut: boolean; blocked: boolean }) {
	const scenes = video.storyboard.scenes;
	const busy = draft.starting || draft.status === "rendering" || draft.status === "loading";
	const tooLong = draft.rangeSeconds !== undefined && draft.rangeSeconds > MAX_DRAFT_SECONDS;
	const button = (label: string, quiet: boolean) => (
		<button type="button" className={`btn${quiet ? " quiet small" : ""}`} disabled={blocked || busy || tooLong} onClick={() => void draft.cut()}>
			{draft.starting ? "Starting…" : label}
		</button>
	);
	return (
		<div className="block" id="draft">
			<div className="block-head">
				<div>
					<h2>Preview</h2>
					<p>A quick low-resolution cut of the video as it stands, to watch before you export. It takes a few seconds and is not for publishing.</p>
				</div>
				{canCut && draft.kept && button("Cut a new draft", true)}
			</div>

			{draft.needsRange && canCut && (
				<div className="draft-range">
					<label>
						<span>From</span>
						<select value={draft.from} onChange={(event) => draft.setFrom(event.target.value)} disabled={busy}>
							{scenes.map((scene) => (
								<option key={scene.id} value={scene.id}>
									{sceneName(video, scene.id)}
								</option>
							))}
						</select>
					</label>
					<label>
						<span>to</span>
						<select value={draft.to} onChange={(event) => draft.setTo(event.target.value)} disabled={busy}>
							{scenes.map((scene) => (
								<option key={scene.id} value={scene.id}>
									{sceneName(video, scene.id)}
								</option>
							))}
						</select>
					</label>
					<span className={tooLong ? "bad" : "soft"}>
						{draft.rangeSeconds !== undefined ? `${clock(draft.rangeSeconds)}${tooLong ? `, longer than the ${MAX_DRAFT_SECONDS / 60} minutes a draft can be` : ""}` : null}
						{draft.rangeSeconds === undefined && `A draft is at most ${MAX_DRAFT_SECONDS / 60} minutes.`}
					</span>
				</div>
			)}

			{draft.kept && draft.stale && draft.status !== "rendering" && draft.status !== "loading" && (
				<p className="note">The video changed after this draft was cut, so it may not show the latest edits. {canCut ? "Cut a new draft to see them." : ""}</p>
			)}
			{draft.kept?.placeholder && draft.status !== "failed" && (
				<p className="note">Cut before the video was prepared: timings are estimated, there is no voice yet and missing pictures show the brand backdrop.</p>
			)}

			{draft.status === "idle" ? (
				<Empty title="No draft yet" actions={canCut ? button("Watch draft", false) : undefined}>
					{blocked ? "The video is being prepared. Watch a draft once it is done." : canCut ? "Cut one to watch the video as it stands, voice and music included." : "Someone who can edit this project can cut one."}
				</Empty>
			) : (
				<div className="player">
					{draft.status === "done" && draft.url ? (
						// biome-ignore lint/a11y/useMediaCaption: captions are burned into the video
						<video key={draft.url} src={draft.url} controls playsInline autoPlay={draft.fresh} />
					) : (
						<div className="pending">
							{draft.status === "failed" ? (
								<p>{draft.error ?? "The draft did not work."}</p>
							) : draft.status === "loading" ? (
								<p>Loading the last draft</p>
							) : (
								<>
									<Tween value={draft.progress} label="Cutting the draft" />
									<p style={{ marginTop: 14 }}>{draft.progress ? `Cutting the draft, ${Math.round(draft.progress * 100)}% done` : "Cutting the draft"}</p>
								</>
							)}
						</div>
					)}
				</div>
			)}

			{draft.kept?.range && draft.status === "done" && (
				<p className="soft" style={{ marginTop: 8 }}>
					Scenes {sceneName(video, draft.kept.range[0])} to {sceneName(video, draft.kept.range[1])}.
				</p>
			)}
			{draft.warnings.length > 0 && (
				<details className="soft" style={{ marginTop: 8 }}>
					<summary>
						{draft.warnings.length} warning{draft.warnings.length === 1 ? "" : "s"} from the renderer
					</summary>
					<ul>
						{draft.warnings.map((warning) => (
							<li key={warning}>{warning}</li>
						))}
					</ul>
				</details>
			)}
		</div>
	);
}
