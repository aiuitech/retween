/**
 * The storyboard on a video's page, as an exposure sheet a person can work on:
 * a track with every scene drawn as wide as it is long (zoomable, and it
 * scrolls sideways when the scenes need more room than the page has), a row
 * per scene beneath, and the same editing tools an agent has: change, add,
 * copy, reorder and remove scenes, retake their media, go back in history,
 * and prepare the video again.
 */
import { type CSSProperties, type DragEvent, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { clock, op, plural, whenExactly } from "./api.ts";
import type { AssetRow, Scene, VideoDetail } from "./types.ts";
import { Confirm, Dialog, Empty, Field, Menu, StatusOf, useAct, useClientLoad, useToast } from "./ui.tsx";

// ----------------------------------------------------------- reading a scene

/** What a scene puts on screen, in a line. */
function shown(scene: Scene): string {
	const text = scene.text ?? {};
	return (
		text.heading ??
		text.quote ??
		(text.stat ? [text.stat.value, text.stat.label].filter(Boolean).join(" ") : undefined) ??
		text.bullets?.map((bullet) => bullet.text).join(", ") ??
		text.cta?.text ??
		scene.map?.places?.map((place) => place.name).filter(Boolean).join(" to ") ??
		text.body ??
		scene.label ??
		""
	);
}

const PICTURES: Record<string, string> = {
	brand: "Brand backdrop",
	image: "Generated still",
	vector: "Illustration",
	video: "Generated clip",
	stock: "Stock",
	asset: "A file from the project",
	solid: "Solid colour",
	gradient: "Gradient",
};

/** Where a scene's picture comes from. */
function picture(scene: Scene): string {
	if (scene.footage) return scene.footage.show === "voice" ? "Your recording, as voice" : "Your recording";
	if (scene.type === "chart") return "Animated chart";
	if (scene.type === "map") return "Animated map";
	const visual = scene.visual;
	if (!visual) return "Brand backdrop";
	const about = visual.prompt ?? visual.query;
	return `${PICTURES[visual.source] ?? visual.source}${about ? `: ${about}` : ""}`;
}

const typeName = (scene: Scene) => scene.type.charAt(0).toUpperCase() + scene.type.slice(1);
const cut = (text: string, length: number) => (text.length > length ? `${text.slice(0, length).trimEnd()}…` : text);
const wordsIn = (text?: string) => (text?.trim() ? text.trim().split(/\s+/).length : 0);

/** The pace narration is estimated at before it is recorded (the service's own default). */
const WORDS_A_MINUTE = 155;

/** How long a scene that has not been timed yet will roughly last. */
function guessSeconds(scene: Scene): number {
	if (scene.timing?.seconds) return scene.timing.seconds;
	const spoken = (wordsIn(scene.narration) / WORDS_A_MINUTE) * 60;
	const padded = spoken ? spoken + ((scene.timing?.leadInMs ?? 300) + (scene.timing?.tailMs ?? 500)) / 1000 : scene.footage ? 8 : 3;
	return Math.max(scene.timing?.minSeconds ?? 0, padded);
}

/** A scene's whole definition includes fields the pages do not read; edits must carry them along. */
type Draft = Scene & Record<string, unknown>;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Sets a dotted path in a copy of an object. An empty value removes the field, and parents left empty go with it. */
function put<T>(base: T, path: string, value: unknown): T {
	const walk = (node: unknown, keys: string[]): unknown => {
		const out: Record<string, unknown> = isObject(node) ? { ...node } : {};
		const [head, ...rest] = keys;
		if (!head) return node;
		const next = rest.length ? walk(out[head], rest) : value === "" || value === null || (typeof value === "number" && Number.isNaN(value)) ? undefined : value;
		if (next === undefined) delete out[head];
		else out[head] = next;
		return Object.keys(out).length ? out : undefined;
	};
	return (walk(base, path.split(".")) ?? {}) as T;
}

/** A scene id nothing else in the storyboard uses, made from a few words. */
function freshId(words: string, taken: Iterable<string>): string {
	const used = new Set(taken);
	const base =
		words
			.toLowerCase()
			.normalize("NFKD")
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 32)
			.replace(/-+$/, "") || "scene";
	if (!used.has(base)) return base;
	for (let n = 2; ; n++) if (!used.has(`${base}-${n}`)) return `${base}-${n}`;
}

// ------------------------------------------------------------- the storyboard

type Asking =
	| { kind: "edit"; scene: Scene }
	| { kind: "new"; after?: string; index?: number }
	| { kind: "remove"; scene: Scene; n: number }
	| { kind: "retake"; scene: Scene; n: number; what: "narration" | "visuals" }
	| { kind: "history" }
	| { kind: "prepare" };

/** How wide the average scene is drawn at each zoom step, in pixels. 0 fits the whole video in view. */
const ZOOMS = [0, 76, 112, 168, 252, 380];

export function Storyboard({ video: current }: { video: VideoDetail }) {
	const { busy, act } = useAct();
	const [lit, setLit] = useState<string | null>(null);
	const [chosen, setChosen] = useState<string | null>(null);
	const [asking, setAsking] = useState<Asking | null>(null);
	const [zoom, setZoom] = useState(2);
	// While a move is being saved the scenes are shown in their new order already.
	const [order, setOrder] = useState<string[] | null>(null);
	const [dragging, setDragging] = useState<string | null>(null);
	const [over, setOver] = useState<{ id: string; after: boolean } | null>(null);
	const strip = useRef<HTMLDivElement>(null);
	const [stripWidth, setStripWidth] = useState(0);

	const byId = new Map(current.storyboard.scenes.map((scene) => [scene.id, scene]));
	const scenes = order && order.length === byId.size && order.every((id) => byId.has(id)) ? order.map((id) => byId.get(id)!) : current.storyboard.scenes;
	const ids = scenes.map((scene) => scene.id);
	const preparing = current.status === "preparing";

	// Scenes are as long as the last prepared timeline says; anything new since then is estimated from its words.
	const timed = new Map(current.timeline?.scenes.map((scene) => [scene.id, scene.durationSec]));
	const media = new Map(current.media.scenes.map((scene) => [scene.id, scene]));
	let run = 0;
	const rows = scenes.map((scene, i) => {
		const exact = timed.get(scene.id);
		const seconds = exact ?? guessSeconds(scene);
		const row = { scene, n: i + 1, seconds, exact: exact !== undefined, starts: run };
		run += seconds;
		return row;
	});
	const total = run || 1;
	const rough = rows.some((row) => !row.exact);

	useEffect(() => {
		const el = strip.current;
		if (!el) return;
		const watch = new ResizeObserver(() => setStripWidth(el.clientWidth));
		watch.observe(el);
		return () => watch.disconnect();
	}, [scenes.length === 0]);
	// Zooming changes the strip's width at once; the ruler follows in the same paint.
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-measured when the zoom or the number of scenes changes
	useLayoutEffect(() => {
		if (strip.current) setStripWidth(strip.current.clientWidth);
	}, [zoom, scenes.length]);

	if (scenes.length === 0) {
		return (
			<>
				<Empty
					title="No scenes yet"
					actions={
						<button type="button" className="btn" onClick={() => setAsking({ kind: "new" })}>
							Add a scene
						</button>
					}
				>
					Tell your agent what this video should say and show. It writes the storyboard, and the scenes appear here. Or add the first scene yourself.
				</Empty>
				{asking?.kind === "new" && <SceneDialog video={current} at={{}} onClose={() => setAsking(null)} />}
			</>
		);
	}

	// A tick every few seconds, spaced so the labels never crowd.
	const STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
	const step = stripWidth ? (STEPS.find((seconds) => (seconds / total) * stripWidth >= 68) ?? 600) : 0;
	const ticks: number[] = [];
	if (step) for (let at = step; (at / total) * stripWidth < stripWidth - 56; at += step) ticks.push(at);

	const state = (id: string) => {
		const parts = [media.get(id)?.narration, media.get(id)?.visual, media.get(id)?.cutout].filter((part) => part !== undefined);
		if (parts.some((part) => part.status === "failed")) return "failed";
		if (parts.some((part) => part.status === "pending")) return "pending";
		if (parts.some((part) => part.status === "missing")) return "missing";
		return "ready";
	};

	const move = (id: string, to: number) => {
		const from = ids.indexOf(id);
		if (from < 0 || to === from || to < 0 || to >= ids.length) return;
		const next = [...ids];
		next.splice(from, 1);
		next.splice(to, 0, id);
		setOrder(next);
		void act(() => op("scene.move", { videoId: current.id, sceneId: id, index: to }), "Moved scene").finally(() => setOrder(null));
	};

	/** Marks a scene, and brings its other half into view: the row for a segment, the segment for a row. */
	const choose = (id: string, reveal: "row" | "segment") => {
		setChosen(id);
		if (reveal === "row") return document.getElementById(`scene-${id}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
		// Only the track moves, sideways: the page stays where the person is reading.
		const reel = strip.current?.parentElement;
		const segment = document.getElementById(`seg-${id}`);
		if (reel && segment) reel.scrollTo({ left: segment.offsetLeft - (reel.clientWidth - segment.offsetWidth) / 2, behavior: "smooth" });
	};

	const grab = (id: string) => ({
		draggable: true,
		onDragStart: (event: DragEvent<HTMLElement>) => {
			event.dataTransfer.effectAllowed = "move";
			event.dataTransfer.setData("text/plain", id);
			const row = event.currentTarget.closest("tr");
			if (row) event.dataTransfer.setDragImage(row, 16, 16);
			// After this event: redrawing the element being picked up during dragstart can cancel the drag.
			setTimeout(() => setDragging(id), 0);
		},
		onDragEnd: () => {
			setDragging(null);
			setOver(null);
		},
	});
	const land = (id: string, axis: "x" | "y") => ({
		onDragOver: (event: DragEvent<HTMLElement>) => {
			if (!dragging) return;
			event.preventDefault();
			event.dataTransfer.dropEffect = "move";
			const box = event.currentTarget.getBoundingClientRect();
			const after = axis === "x" ? event.clientX > box.left + box.width / 2 : event.clientY > box.top + box.height / 2;
			if (over?.id !== id || over.after !== after) setOver({ id, after });
		},
		onDrop: (event: DragEvent<HTMLElement>) => {
			event.preventDefault();
			const moved = dragging;
			const where = over;
			setDragging(null);
			setOver(null);
			if (!moved || !where) return;
			let to = ids.indexOf(where.id) + (where.after ? 1 : 0);
			if (ids.indexOf(moved) < to) to -= 1;
			move(moved, to);
		},
	});
	const dropMark = (id: string) => (over?.id === id && dragging && dragging !== id ? (over.after ? " drop-after" : " drop-before") : "");

	const duplicate = (scene: Scene) => {
		const copy = { ...scene, id: freshId(`${scene.id}-copy`, ids), ...(scene.label ? { label: `${scene.label} (copy)` } : {}) };
		void act(() => op("scene.save", { videoId: current.id, scene: copy, afterSceneId: scene.id }), "Copied scene");
	};

	const needsPreparing = current.status !== "ready" || !current.timeline || current.timeline.stale;
	const width = ZOOMS[zoom] ?? 0;

	return (
		<div className="cel board">
			<div className="board-top">
			<div className="board-bar">
				<button type="button" className="btn quiet small" onClick={() => setAsking({ kind: "new" })}>
					Add scene
				</button>
				<button type="button" className="btn quiet small" onClick={() => setAsking({ kind: "history" })}>
					History
				</button>
				<span className="grow" />
				<fieldset className="zoom">
					<legend className="hide">Timeline zoom</legend>
					<button type="button" className="btn quiet small icon" disabled={zoom === 0} onClick={() => setZoom(zoom - 1)} aria-label="Zoom out" title="Zoom out">
						−
					</button>
					<button type="button" className="btn quiet small" aria-pressed={zoom === 0} onClick={() => setZoom(0)} title="Fit the whole video in view">
						Fit
					</button>
					<button type="button" className="btn quiet small icon" disabled={zoom === ZOOMS.length - 1} onClick={() => setZoom(zoom + 1)} aria-label="Zoom in" title="Zoom in">
						+
					</button>
				</fieldset>
				{preparing ? (
					<button type="button" className="btn quiet small" disabled={busy} onClick={() => void act(() => op("video.cancel", { videoId: current.id }), "Stopped preparing")}>
						Stop preparing
					</button>
				) : (
					<button type="button" className={`btn small${needsPreparing ? "" : " quiet"}`} onClick={() => setAsking({ kind: "prepare" })}>
						Prepare video
					</button>
				)}
			</div>

			<div className="reel">
				<div className="reel-in" ref={strip} style={{ minWidth: width ? `${scenes.length * width}px` : undefined }}>
					{/* biome-ignore lint/a11y/useSemanticElements: a strip of scene buttons, not a form */}
					<div className="track" role="group" aria-label="Scenes in order, each as wide as it is long">
						{rows.map(({ scene, n, seconds, exact }) => (
							// A div, not a button: Firefox does not start a drag from a button.
							// biome-ignore lint/a11y/useSemanticElements: see above
							<div
								role="button"
								tabIndex={0}
								key={scene.id}
								id={`seg-${scene.id}`}
								className={`seg${lit === scene.id ? " lit" : ""}${chosen === scene.id ? " on" : ""}${dragging === scene.id ? " held" : ""}${dropMark(scene.id)}`}
								style={{ ["--len" as string]: seconds } as CSSProperties}
								title={`Scene ${n}: ${shown(scene) || scene.type}. Click to find it below, double-click (or Enter) to edit, drag to move.`}
								onClick={() => choose(scene.id, "row")}
								onDoubleClick={() => setAsking({ kind: "edit", scene })}
								onKeyDown={(event) => {
									if (event.key === "Enter") setAsking({ kind: "edit", scene });
									if (event.key === " ") {
										event.preventDefault();
										choose(scene.id, "row");
									}
								}}
								onMouseEnter={() => setLit(scene.id)}
								onMouseLeave={() => setLit(null)}
								onFocus={() => setLit(scene.id)}
								onBlur={() => setLit(null)}
								{...grab(scene.id)}
								{...land(scene.id, "x")}
							>
								<span className="what">
									<b>{n}</b> <span>{scene.label ?? (shown(scene) || typeName(scene))}</span>
								</span>
								<span className="len">
									{exact ? "" : "~"}
									{seconds.toFixed(1)}s
								</span>
							</div>
						))}
					</div>
					<div className="track-keys" aria-hidden="true">
						{rows.map((row) => (
							<b key={row.scene.id} style={{ left: `${(row.starts / total) * 100}%` }} />
						))}
						<b className="end" style={{ left: "100%" }} />
					</div>
					<div className="ruler" aria-hidden="true">
						<span style={{ left: 0 }}>0:00</span>
						{ticks.map((at) => (
							<span key={at} className="tick" style={{ left: `${(at / total) * 100}%` }}>
								{clock(at)}
							</span>
						))}
						<span style={{ left: "100%" }}>
							{rough ? "about " : ""}
							{clock(total)}
						</span>
					</div>
				</div>
			</div>
			</div>

			<div className="sheet-scroll">
				<table className="xsheet">
					<thead>
						<tr>
							<th className="n">
								<span className="hide">Scene</span>
							</th>
							<th>On screen</th>
							<th>Narration</th>
							<th>Picture</th>
							<th>Time</th>
							<th>Media</th>
							<th>
								<span className="hide">Actions</span>
							</th>
						</tr>
					</thead>
					<tbody>
						{rows.map(({ scene, n, seconds, exact, starts }) => {
							const said = scene.narration ?? (scene.footage ? `“${scene.footage.from ?? ""} … ${scene.footage.to ?? ""}”` : "");
							const entry = media.get(scene.id);
							return (
								<tr
									key={scene.id}
									id={`scene-${scene.id}`}
									className={`${lit === scene.id ? "lit" : ""}${chosen === scene.id ? " on" : ""}${dragging === scene.id ? " held" : ""}${dropMark(scene.id)}`}
									onMouseEnter={() => setLit(scene.id)}
									onMouseLeave={() => setLit(null)}
									onClick={(event) => !(event.target as HTMLElement).closest("button,a,.menu-panel") && choose(scene.id, "segment")}
									onDoubleClick={(event) => !(event.target as HTMLElement).closest("button,a,.menu-panel") && setAsking({ kind: "edit", scene })}
									{...land(scene.id, "y")}
								>
									<td className="n">
										<span className="grip" title="Drag to move this scene" aria-hidden="true" {...grab(scene.id)}>
											⠿
										</span>
										{n}
									</td>
									<td className="shown">
										{shown(scene) && <strong>{cut(shown(scene), 90)}</strong>}
										<div className="softer">
											{typeName(scene)}
											{scene.label ? ` · ${cut(scene.label, 40)}` : ""}
										</div>
										{scene.chapter && <div className="softer">Chapter: {cut(scene.chapter, 40)}</div>}
									</td>
									<td className="said">{said ? cut(said, 260) : <span className="softer">No narration</span>}</td>
									<td className="soft shown">{cut(picture(scene), 110)}</td>
									<td className="t">
										{clock(starts)}
										<div className="softer" title={exact ? undefined : "Estimated from the words until the video is prepared"}>
											{exact ? "" : "~"}
											{seconds.toFixed(1)}s
										</div>
									</td>
									<td className="state">
										<StatusOf status={state(scene.id)} />
									</td>
									<td className="do">
										<div className="acts">
											<button type="button" className="btn quiet small" onClick={() => setAsking({ kind: "edit", scene })}>
												Edit
											</button>
											<Menu label={`More actions for scene ${n}`}>
												<button type="button" onClick={() => setAsking({ kind: "new", index: n - 1 })}>
													Add a scene before
												</button>
												<button type="button" onClick={() => setAsking({ kind: "new", after: scene.id })}>
													Add a scene after
												</button>
												<button type="button" disabled={busy} onClick={() => duplicate(scene)}>
													Make a copy
												</button>
												<hr />
												<button type="button" disabled={busy || n === 1} onClick={() => move(scene.id, n - 2)}>
													Move earlier
												</button>
												<button type="button" disabled={busy || n === scenes.length} onClick={() => move(scene.id, n)}>
													Move later
												</button>
												{(entry?.narration || entry?.visual) && <hr />}
												{entry?.narration && (
													<button type="button" disabled={preparing} onClick={() => setAsking({ kind: "retake", scene, n, what: "narration" })}>
														Record the narration again
													</button>
												)}
												{entry?.visual && scene.visual?.source !== "asset" && (
													<button type="button" disabled={preparing} onClick={() => setAsking({ kind: "retake", scene, n, what: "visuals" })}>
														Make a new picture
													</button>
												)}
												<hr />
												<button type="button" className="danger" onClick={() => setAsking({ kind: "remove", scene, n })}>
													Remove scene
												</button>
											</Menu>
										</div>
									</td>
								</tr>
							);
						})}
					</tbody>
				</table>
			</div>

			{asking?.kind === "edit" && <SceneDialog key={asking.scene.id} video={current} scene={asking.scene} onClose={() => setAsking(null)} />}
			{asking?.kind === "new" && <SceneDialog video={current} at={{ afterSceneId: asking.after, index: asking.index }} onClose={() => setAsking(null)} />}
			{asking?.kind === "history" && <HistoryDialog video={current} onClose={() => setAsking(null)} />}
			{asking?.kind === "prepare" && <PrepareDialog video={current} onClose={() => setAsking(null)} />}
			{asking?.kind === "remove" && (
				<Confirm
					open
					onClose={() => setAsking(null)}
					title={`Remove scene ${asking.n}?`}
					action="Remove scene"
					busy={busy}
					onConfirm={async () => {
						if (await act(() => op("scene.remove", { videoId: current.id, sceneId: asking.scene.id }), "Removed scene")) setAsking(null);
					}}
				>
					“{cut(shown(asking.scene) || asking.scene.narration || asking.scene.id, 80)}” leaves the storyboard. You can bring it back from History.
				</Confirm>
			)}
			{asking?.kind === "retake" && (
				<Confirm.Form
					title={asking.what === "narration" ? `Record scene ${asking.n}'s narration again?` : `Make a new picture for scene ${asking.n}?`}
					onClose={() => setAsking(null)}
					action={asking.what === "narration" ? "Record again" : "Make a new one"}
					busy={busy}
					onSubmit={async () => {
						const done = await act(
							() => op("video.prepare", { videoId: current.id, regenerate: { [asking.what]: true, sceneIds: [asking.scene.id] }, waitSeconds: 0 }),
							"Started preparing",
						);
						if (done) setAsking(null);
					}}
				>
					<p className="soft">
						{asking.what === "narration"
							? "The voice reads the same words again, for a different take. "
							: "The picture is made again from the same description, or stock is searched again. "}
						This prepares the video, so any other changes waiting are generated too, and it is charged to your budget.
					</p>
				</Confirm.Form>
			)}
		</div>
	);
}

// ------------------------------------------------------------ editing a scene

const TYPES: [Scene["type"], string][] = [
	["title", "Title: a big headline"],
	["media", "Media: a full-frame picture"],
	["bullets", "Bullets: a timed list"],
	["quote", "Quote: a pull quote"],
	["stat", "Stat: one big number"],
	["split", "Split: picture beside text"],
	["chart", "Chart: an animated chart"],
	["map", "Map: an animated map"],
	["outro", "Outro: logo and a next step"],
];
const SOURCES: [string, string][] = [
	["brand", "The brand backdrop"],
	["image", "Generate a still"],
	["vector", "Generate an illustration"],
	["video", "Generate a clip"],
	["stock", "Find free stock"],
	["asset", "A file from the project"],
	["solid", "A solid colour"],
];
const TRANSITIONS = ["cut", "fade", "slide-left", "slide-up", "wipe", "zoom"];

interface Preview {
	url: string;
	layout: { severity: string; message: string; fix?: string }[];
	warnings: string[];
}

/** Changes one scene, or (without `scene`) adds a new one at `at`. */
function SceneDialog({ video, scene, at, onClose }: { video: VideoDetail; scene?: Scene; at?: { afterSceneId?: string; index?: number }; onClose: () => void }) {
	const { busy, act } = useAct();
	const toast = useToast();
	const ids = video.storyboard.scenes.map((item) => item.id);
	const [original] = useState<Draft>(() => (scene ?? { id: "", type: "media" }) as Draft);
	const [draft, setDraft] = useState<Draft>(original);
	// Bullets are typed as lines; they become the scene's list when it is saved.
	const [bullets, setBullets] = useState(() => (original.text?.bullets ?? []).map((bullet) => bullet.text).join("\n"));
	const [mode, setMode] = useState<"form" | "json">("form");
	const [json, setJson] = useState("");
	const [problem, setProblem] = useState<string | null>(null);
	const [preview, setPreview] = useState<Preview | null>(null);
	const [previewing, setPreviewing] = useState(false);

	const set = (path: string, value: unknown) => setDraft((now) => put(now, path, value));
	const text = draft.text ?? {};
	const visual = draft.visual;
	const source = visual?.source ?? "brand";
	const drawn = draft.type === "chart" || draft.type === "map";
	const speaker = draft.footage && draft.footage.show !== "voice";

	/** The scene as it would be saved, or a sentence saying what is wrong with it. */
	const build = (): Draft | string => {
		let next: Draft;
		if (mode === "json") {
			try {
				next = JSON.parse(json) as Draft;
			} catch (error) {
				return `This is not valid JSON: ${error instanceof Error ? error.message : "check the brackets and commas"}`;
			}
			if (!isObject(next)) return "A scene is one JSON object.";
			if (scene && next.id !== scene.id) return `A scene keeps its id (“${scene.id}”): it is how its narration and picture are kept.`;
		} else {
			const lines = bullets.split("\n").map((line) => line.trim()).filter(Boolean);
			const old = original.text?.bullets ?? [];
			// A reworded line keeps its cue and icon when the list is the same length; otherwise lines are matched by their words.
			const list = lines.map((line, i) => ({ ...(old.length === lines.length ? old[i] : old.find((bullet) => bullet.text === line)), text: line }));
			next = put(draft, "text.bullets", list.length ? list : undefined);
			if (next.text?.stat && !next.text.stat.value?.trim()) next = put(next, "text.stat", undefined);
			if (next.text?.cta && !next.text.cta.text?.trim()) next = put(next, "text.cta", undefined);
			const picture = next.visual;
			if (picture) {
				if (["image", "vector", "video"].includes(picture.source) && !picture.prompt?.trim()) return "Describe the picture to generate, or choose another kind of picture.";
				if (picture.source === "stock" && !picture.query?.trim()) return "Say what stock to search for, or choose another kind of picture.";
				if (picture.source === "asset" && !picture.assetId) return "Choose which file to show, or choose another kind of picture.";
			}
			if (next.type === "chart" && !next.chart) return "A chart scene needs its data. Add a chart under JSON, or pick another type.";
			if (next.type === "map" && !next.map) return "A map scene needs its places. Add a map under JSON, or pick another type.";
		}
		if (!next.id) next = { ...next, id: freshId(next.label ?? next.text?.heading ?? next.narration?.split(/\s+/).slice(0, 4).join(" ") ?? "scene", ids) };
		return next;
	};

	const dirty = mode === "json" ? json !== JSON.stringify(original, null, 2) : JSON.stringify(draft) !== JSON.stringify(original) || bullets !== (original.text?.bullets ?? []).map((bullet) => bullet.text).join("\n");

	const flip = (to: "form" | "json") => {
		if (to === mode) return;
		const built = build();
		if (typeof built === "string") return setProblem(built);
		setProblem(null);
		if (to === "json") setJson(JSON.stringify(built, null, 2));
		else {
			setDraft(built);
			setBullets((built.text?.bullets ?? []).map((bullet) => bullet.text).join("\n"));
		}
		setMode(to);
	};

	const save = async () => {
		const built = build();
		if (typeof built === "string") return setProblem(built);
		setProblem(null);
		const remade = built.narration !== original.narration || JSON.stringify(built.visual) !== JSON.stringify(original.visual) || JSON.stringify(built.voice) !== JSON.stringify(original.voice);
		const saved = await act(
			() => op("scene.save", { videoId: video.id, scene: built, ...(scene ? {} : { afterSceneId: at?.afterSceneId, index: at?.index }) }),
			scene ? (remade ? "Saved. Prepare the video to hear and see the change." : "Saved scene") : "Added scene",
		);
		if (saved) onClose();
	};

	const look = async () => {
		const built = build();
		if (typeof built === "string") return setProblem(built);
		setProblem(null);
		setPreviewing(true);
		try {
			setPreview(await op<Preview>("video.preview", { videoId: video.id, scene: built }));
		} catch (error) {
			toast(error instanceof Error ? error.message : "The preview did not work. Try again.", true);
		} finally {
			setPreviewing(false);
		}
	};

	const n = scene ? ids.indexOf(scene.id) + 1 : 0;
	const spoken = wordsIn(draft.narration);
	return (
		<Dialog open onClose={onClose} wide title={scene ? `Scene ${n}` : "New scene"} guard={() => !dirty || window.confirm("Leave without saving your changes to this scene?")}>
			<form
				className="scene-form"
				onSubmit={(event) => {
					event.preventDefault();
					void save();
				}}
			>
				<div className="chips" role="tablist" aria-label="How to edit">
					<button type="button" role="tab" aria-selected={mode === "form"} aria-pressed={mode === "form"} onClick={() => flip("form")}>
						Fields
					</button>
					<button type="button" role="tab" aria-selected={mode === "json"} aria-pressed={mode === "json"} onClick={() => flip("json")}>
						JSON
					</button>
				</div>

				<div className="scene-edit">
					{mode === "json" ? (
						<div className="fields">
							<Field label="The whole scene" hint="Everything a scene can hold, as your agent writes it: chart data, map places, sound effects, layout, custom layers.">
								<textarea className="code json" value={json} onChange={(event) => setJson(event.target.value)} spellCheck={false} rows={22} />
							</Field>
						</div>
					) : (
						<div className="fields">
							<div className="pair">
								<Field label="Type">
									<select value={draft.type} onChange={(event) => set("type", event.target.value)}>
										{TYPES.map(([value, name]) => (
											<option key={value} value={value}>
												{name}
											</option>
										))}
									</select>
								</Field>
								<Field label="Working title" hint="Never shown. Names the scene on the timeline.">
									<input value={draft.label ?? ""} onChange={(event) => set("label", event.target.value)} maxLength={300} />
								</Field>
							</div>

							{draft.footage ? (
								<div className="pair">
									<Field label="Recording starts at" hint="The first few words spoken, or seconds in.">
										<input value={String(draft.footage.from ?? "")} onChange={(event) => set("footage.from", spot(event.target.value))} maxLength={300} />
									</Field>
									<Field label="Recording ends at" hint="The last few words spoken, or seconds in.">
										<input value={String(draft.footage.to ?? "")} onChange={(event) => set("footage.to", spot(event.target.value))} maxLength={300} />
									</Field>
								</div>
							) : (
								<Field
									label="Narration"
									hint={spoken ? `${plural(spoken, "word")}, about ${Math.round((spoken / WORDS_A_MINUTE) * 60)} seconds to say. The scene lasts as long as this takes.` : "What the voice says. Leave empty for a silent scene."}
								>
									<textarea value={draft.narration ?? ""} onChange={(event) => set("narration", event.target.value)} maxLength={3000} rows={5} autoFocus={!scene} />
								</Field>
							)}

							<fieldset className="group">
								<legend>On screen</legend>
								<div className="pair">
									<Field label="Heading">
										<input value={text.heading ?? ""} onChange={(event) => set("text.heading", event.target.value)} maxLength={300} />
									</Field>
									<Field label="Small label above it">
										<input value={text.kicker ?? ""} onChange={(event) => set("text.kicker", event.target.value)} maxLength={300} />
									</Field>
								</div>
								<Field label="Subheading">
									<input value={text.subheading ?? ""} onChange={(event) => set("text.subheading", event.target.value)} maxLength={300} />
								</Field>
								{(draft.type === "bullets" || bullets) && (
									<Field label="Bullets" hint="One a line, up to eight. Each appears as the narration reaches it.">
										<textarea value={bullets} onChange={(event) => setBullets(event.target.value)} rows={4} />
									</Field>
								)}
								{(draft.type === "quote" || text.quote !== undefined || text.attribution !== undefined) && (
									<>
										<Field label="Quote">
											<textarea value={text.quote ?? ""} onChange={(event) => set("text.quote", event.target.value)} maxLength={600} rows={3} />
										</Field>
										<Field label="Who said it">
											<input value={text.attribution ?? ""} onChange={(event) => set("text.attribution", event.target.value)} maxLength={300} />
										</Field>
									</>
								)}
								{(draft.type === "stat" || text.stat) && (
									<div className="pair">
										<Field label="Figure" hint="As shown, such as 42% or 3.2M.">
											<input value={text.stat?.value ?? ""} onChange={(event) => set("text.stat.value", event.target.value)} maxLength={300} />
										</Field>
										<Field label="What it counts">
											<input value={text.stat?.label ?? ""} onChange={(event) => set("text.stat.label", event.target.value)} maxLength={300} />
										</Field>
									</div>
								)}
								{(draft.type === "outro" || text.cta) && (
									<div className="pair">
										<Field label="Call to action">
											<input value={text.cta?.text ?? ""} onChange={(event) => set("text.cta.text", event.target.value)} maxLength={300} />
										</Field>
										<Field label="Its address">
											<input value={text.cta?.url ?? ""} onChange={(event) => set("text.cta.url", event.target.value)} maxLength={300} placeholder="example.com" />
										</Field>
									</div>
								)}
								<Field label="Body text">
									<textarea value={text.body ?? ""} onChange={(event) => set("text.body", event.target.value)} maxLength={1200} rows={2} />
								</Field>
							</fieldset>

							<fieldset className="group">
								<legend>Picture</legend>
								{drawn ? (
									<p className="soft">
										A {draft.type} draws itself from its {draft.type === "chart" ? "data" : "places"}. Change them under JSON.
									</p>
								) : speaker ? (
									<p className="soft">This scene shows your recording.</p>
								) : (
									<>
										<Field label="Where it comes from">
											<select value={source} onChange={(event) => setDraft((now) => (event.target.value === "brand" ? put(now, "visual", undefined) : put(now, "visual.source", event.target.value)))}>
												{SOURCES.map(([value, name]) => (
													<option key={value} value={value}>
														{name}
													</option>
												))}
												{source === "gradient" && <option value="gradient">A gradient (set its colours under JSON)</option>}
											</select>
										</Field>
										{(source === "image" || source === "vector" || source === "video") && (
											<Field
												label="What to make"
												hint={source === "video" ? "Describe the subject and the motion. Clips cost far more than anything else here." : "Describe the subject and framing. The project's style is added for you."}
											>
												<textarea value={visual?.prompt ?? ""} onChange={(event) => set("visual.prompt", event.target.value)} maxLength={4000} rows={4} />
											</Field>
										)}
										{source === "stock" && (
											<div className="pair">
												<Field label="Search for">
													<input value={visual?.query ?? ""} onChange={(event) => set("visual.query", event.target.value)} maxLength={300} />
												</Field>
												<Field label="Kind">
													<select value={visual?.media ?? "image"} onChange={(event) => set("visual.media", event.target.value)}>
														<option value="image">Photo</option>
														<option value="video">Footage</option>
													</select>
												</Field>
											</div>
										)}
										{source === "asset" && <AssetField projectId={video.projectId} value={visual?.assetId} onChange={(id) => set("visual.assetId", id)} />}
										{source === "solid" && (
											<Field label="Colour" hint="A hex colour. Leave empty for the brand background.">
												<input value={visual?.color ?? ""} onChange={(event) => set("visual.color", event.target.value)} placeholder="#101820" maxLength={9} />
											</Field>
										)}
									</>
								)}
							</fieldset>

							<details className="group" open={Boolean(draft.transition || draft.timing || draft.voice?.speed || draft.chapter || draft.notes)}>
								<summary>Pacing, chapter and notes</summary>
								<div className="fields">
									<div className="pair three">
										<Field label="Enters with">
											<select
												value={draft.transition?.type ?? ""}
												onChange={(event) => setDraft((now) => (event.target.value ? put(now, "transition.type", event.target.value) : put(now, "transition", undefined)))}
											>
												<option value="">The brand's transition</option>
												{TRANSITIONS.map((value) => (
													<option key={value} value={value}>
														{value.charAt(0).toUpperCase() + value.slice(1).replace("-", " ")}
													</option>
												))}
											</select>
										</Field>
										<Field label="Pause before, seconds">
											<input
												type="number"
												min={0}
												max={5}
												step={0.1}
												value={draft.timing?.leadInMs !== undefined ? draft.timing.leadInMs / 1000 : ""}
												onChange={(event) => set("timing.leadInMs", event.target.value === "" ? undefined : Math.round(Number(event.target.value) * 1000))}
											/>
										</Field>
										<Field label="Hold after, seconds">
											<input
												type="number"
												min={0}
												max={8}
												step={0.1}
												value={draft.timing?.tailMs !== undefined ? draft.timing.tailMs / 1000 : ""}
												onChange={(event) => set("timing.tailMs", event.target.value === "" ? undefined : Math.round(Number(event.target.value) * 1000))}
											/>
										</Field>
									</div>
									<div className="pair">
										<Field label="Voice speed" hint="0.7 to 1.2. Empty for the brand's pace.">
											<input
												type="number"
												min={0.7}
												max={1.2}
												step={0.05}
												value={draft.voice?.speed ?? ""}
												onChange={(event) => set("voice.speed", event.target.value === "" ? undefined : Number(event.target.value))}
											/>
										</Field>
										<Field label="Chapter starts here" hint="Its title, listed with its time on YouTube.">
											<input value={draft.chapter ?? ""} onChange={(event) => set("chapter", event.target.value)} maxLength={300} />
										</Field>
									</div>
									<Field label="Notes" hint="For you and your agent. Never shown.">
										<textarea value={draft.notes ?? ""} onChange={(event) => set("notes", event.target.value)} maxLength={2000} rows={2} />
									</Field>
								</div>
							</details>
						</div>
					)}

					<aside className="scene-now">
						{preview ? <img className="frame" src={preview.url} alt="A frame of this scene with your changes" /> : <div className="frame none">No preview yet</div>}
						<button type="button" className="btn quiet small" disabled={previewing} onClick={() => void look()}>
							{previewing ? "Drawing the frame…" : preview ? "Preview again" : "Preview a frame"}
						</button>
						<p className="softer">Shows the scene as it is typed here, before saving. New narration and pictures appear once the video is prepared.</p>
						{preview?.layout.map((issue) => (
							<p key={issue.message} className={`note${issue.severity === "error" ? " bad" : ""}`}>
								{issue.message} {issue.fix}
							</p>
						))}
						{scene && <SceneMedia video={video} sceneId={scene.id} />}
					</aside>
				</div>

				{problem && <p className="note bad">{problem}</p>}
				<div className="sheet-foot">
					<button type="button" className="btn quiet" onClick={onClose}>
						Cancel
					</button>
					<button type="submit" className="btn" disabled={busy || (Boolean(scene) && !dirty)}>
						{scene ? "Save scene" : "Add scene"}
					</button>
				</div>
			</form>
		</Dialog>
	);
}

/** A place in a recording: seconds when it is a number, otherwise the words spoken there. */
const spot = (value: string) => (/^\d+(\.\d+)?$/.test(value.trim()) ? Number(value) : value);

/** Chooses one of the project's pictures, clips or animations. */
function AssetField({ projectId, value, onChange }: { projectId: string; value?: string; onChange: (id: string) => void }) {
	const { data, error } = useClientLoad(() => op<{ assets: AssetRow[] }>("asset.list", { projectId, limit: 200 }));
	const files = (data?.assets ?? []).filter((asset) => asset.kind === "image" || asset.kind === "video" || asset.kind === "animation");
	return (
		<Field label="File" hint={error ?? (data && files.length === 0 ? "This project has no pictures or clips yet. Add some under Files." : undefined)}>
			<select value={value ?? ""} onChange={(event) => onChange(event.target.value)} disabled={!data}>
				<option value="">{data ? "Choose a file" : "Loading the project's files…"}</option>
				{value && !files.some((asset) => asset.id === value) && <option value={value}>{value}</option>}
				{files.map((asset) => (
					<option key={asset.id} value={asset.id}>
						{asset.name} ({asset.kind})
					</option>
				))}
			</select>
		</Field>
	);
}

/** The narration take and picture a scene has now, to hear and see while editing. */
function SceneMedia({ video, sceneId }: { video: VideoDetail; sceneId: string }) {
	const entry = video.media.scenes.find((scene) => scene.id === sceneId);
	const wanted = [entry?.narration, entry?.visual].filter((part) => part?.status === "ready" && part.assetId).map((part) => part!.assetId!);
	const { data } = useClientLoad(() => Promise.all(wanted.map((assetId) => op<{ asset: AssetRow }>("asset.get", { assetId }).then((reply) => reply.asset))));
	const found = (data ?? []).filter((asset) => asset.url);
	if (!found.length) return null;
	return (
		<div className="scene-has">
			<h3>As prepared</h3>
			{found.map((asset) =>
				asset.kind === "audio" ? (
					// biome-ignore lint/a11y/useMediaCaption: the narration's words are the field beside it
					<audio key={asset.id} src={asset.url} controls preload="none" />
				) : asset.kind === "video" ? (
					// biome-ignore lint/a11y/useMediaCaption: a silent picture
					<video key={asset.id} src={asset.url} controls muted preload="metadata" />
				) : asset.kind === "image" ? (
					<img key={asset.id} src={asset.url} alt={asset.prompt ?? asset.name} loading="lazy" />
				) : null,
			)}
		</div>
	);
}

// -------------------------------------------------------------------- history

interface Checkpoint {
	checkpointId: string;
	name?: string;
	kind: "automatic" | "named";
	before?: string;
	at: string;
	scenes: number;
	difference: string;
}

/** "scene.patch intro, outro" → what a person would call it. */
function reason(before?: string): string {
	if (!before) return "A saved state";
	const [what = "", ...rest] = before.split(" ");
	const which = rest.join(" ");
	const words: Record<string, string> = {
		"storyboard.set": "Before the storyboard was rewritten",
		"scene.save": `Before scene ${which} was saved`,
		"scene.patch": `Before a change to ${which}`,
		"scene.remove": `Before scene ${which} was removed`,
		"scene.move": `Before scene ${which} was moved`,
		"video.restore": "Before going back to an earlier state",
	};
	return words[what] ?? `Before ${before}`;
}

function HistoryDialog({ video, onClose }: { video: VideoDetail; onClose: () => void }) {
	const { busy, act } = useAct();
	const { data, error, reload } = useClientLoad(() => op<{ checkpoints: Checkpoint[] }>("video.history", { videoId: video.id }));
	const [name, setName] = useState("");
	const preparing = video.status === "preparing";
	return (
		<Dialog open onClose={onClose} wide title="History">
			<p>Every change to the storyboard keeps the state before it (the last 20), and a checkpoint keeps one for good. Going back is itself kept, so it can be undone.</p>
			<form
				className="history-save"
				onSubmit={async (event) => {
					event.preventDefault();
					if (await act(() => op("video.checkpoint", { videoId: video.id, name: name.trim() }), "Saved checkpoint")) {
						setName("");
						reload();
					}
				}}
			>
				<input value={name} onChange={(event) => setName(event.target.value)} maxLength={120} placeholder="Name the storyboard as it is now" aria-label="Checkpoint name" />
				<button type="submit" className="btn quiet" disabled={busy || !name.trim()}>
					Save checkpoint
				</button>
			</form>
			{error && <p className="note bad">{error}</p>}
			{preparing && <p className="note info">The video is being prepared. Going back works once that finishes or is stopped.</p>}
			{data && data.checkpoints.length === 0 && <p className="soft">Nothing yet. States appear here as the storyboard changes.</p>}
			{data && data.checkpoints.length > 0 && (
				<div className="lines">
					{data.checkpoints.map((point) => (
						<div className="line" key={point.checkpointId}>
							<div className="grow">
								<div className="title">{point.name ?? reason(point.before)}</div>
								<div className="facts">
									{point.kind === "named" && <span className="tag blue">Checkpoint</span>}
									<span>{whenExactly(point.at)}</span>
									<span>{plural(point.scenes, "scene")}</span>
									<span>{point.difference === "same as now" ? "Same as now" : cut(point.difference.charAt(0).toUpperCase() + point.difference.slice(1), 120)}</span>
								</div>
							</div>
							<div className="acts">
								<button
									type="button"
									className="btn quiet small"
									disabled={busy || preparing || point.difference === "same as now"}
									onClick={async () => {
										if (await act(() => op("video.restore", { videoId: video.id, checkpointId: point.checkpointId }), "Went back. Prepare the video to rebuild it.")) onClose();
									}}
								>
									Go back to this
								</button>
								{point.kind === "named" && (
									<Menu label={`More actions for ${point.name ?? "this checkpoint"}`}>
										<button
											type="button"
											className="danger"
											onClick={async () => {
												if (await act(() => op("checkpoint.delete", { videoId: video.id, checkpointIds: [point.checkpointId] }), "Deleted checkpoint")) reload();
											}}
										>
											Delete checkpoint
										</button>
									</Menu>
								)}
							</div>
						</div>
					))}
				</div>
			)}
		</Dialog>
	);
}

// ------------------------------------------------------------------ preparing

interface Estimate {
	problems: string[];
	estimatedSeconds: number;
	toGenerate: {
		narration: { scenes: number; characters: number };
		images: number;
		vectors: number;
		cutouts: number;
		icons: number;
		stock: number;
		clips: { count: number; seconds: number };
		soundEffects: number;
		music: { seconds: number } | null;
	};
	mediaProblems?: string[];
}

/** Says what preparing would make before it is paid for, then starts it. */
function PrepareDialog({ video, onClose }: { video: VideoDetail; onClose: () => void }) {
	const { busy, act } = useAct();
	const { data, error } = useClientLoad(() => op<Estimate>("video.estimate", { videoId: video.id }));
	const make = data?.toGenerate;
	const list: ReactNode[] = make
		? [
				make.narration.scenes ? `Narration for ${plural(make.narration.scenes, "scene")} (${make.narration.characters.toLocaleString("en")} characters)` : "",
				make.images ? plural(make.images, "still") : "",
				make.vectors ? plural(make.vectors, "illustration") : "",
				make.clips.count ? `${plural(make.clips.count, "clip")} (${Math.round(make.clips.seconds)} seconds): clips cost far more than anything else here` : "",
				make.stock ? plural(make.stock, "stock search", "stock searches") : "",
				make.cutouts ? plural(make.cutouts, "cut-out") : "",
				make.soundEffects ? plural(make.soundEffects, "sound effect") : "",
				make.music ? `Music, about ${Math.round(make.music.seconds)} seconds` : "",
				make.icons ? `${plural(make.icons, "icon")} (free)` : "",
			].filter(Boolean)
		: [];
	const problems = [...(data?.problems ?? []), ...(data?.mediaProblems ?? [])];
	return (
		<Dialog open onClose={onClose} title="Prepare video">
			{error && <p className="note bad">{error}</p>}
			{!data && !error && <p>Working out what there is to make…</p>}
			{data && (
				<>
					<p>
						{list.length
							? "Preparing records the narration, makes the pictures and times every scene to the voice. Only what changed is made again, and it is charged to your budget:"
							: "Everything this storyboard needs already exists, so nothing is generated or charged. The timeline is rebuilt from it."}
					</p>
					{list.length > 0 && (
						<ul className="plain">
							{list.map((item) => (
								<li key={String(item)}>{item}</li>
							))}
						</ul>
					)}
					<p>The video will run about {clock(data.estimatedSeconds)}.</p>
					{problems.map((item) => (
						<p key={item} className="note bad">
							{item}
						</p>
					))}
				</>
			)}
			<div className="sheet-foot">
				<button type="button" className="btn quiet" onClick={onClose}>
					Cancel
				</button>
				<button
					type="button"
					className="btn"
					disabled={busy || !data}
					onClick={async () => {
						const started = list.length
							? await act(() => op("video.prepare", { videoId: video.id, waitSeconds: 0 }), "Started preparing")
							: await act(() => op("video.compose", { videoId: video.id }), "Rebuilt the timeline");
						if (started) onClose();
					}}
				>
					{list.length ? "Prepare video" : "Rebuild timeline"}
				</button>
			</div>
		</Dialog>
	);
}
