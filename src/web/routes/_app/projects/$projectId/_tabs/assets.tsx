import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { clock, op, plural, sizeOf, uploadAsset, when } from "../../../../../api.ts";
import { ASSET_KINDS, type AssetKind, type AssetRow } from "../../../../../types.ts";
import { Confirm, CopyId, Dialog, Empty, Field, StatusOf, Tween, useAct, usePoll } from "../../../../../ui.tsx";

/** The most files the grid loads at once. */
const LIST_LIMIT = 200;

interface Search {
	kind?: AssetKind;
	q?: string;
	/** Also show narration and pictures generated for individual scenes. */
	auto?: boolean;
	/** The file that is open. */
	asset?: string;
}

export const Route = createFileRoute("/_app/projects/$projectId/_tabs/assets")({
	validateSearch: (search: Record<string, unknown>): Search => ({
		kind: ASSET_KINDS.find((kind) => kind === search.kind),
		q: typeof search.q === "string" && search.q ? search.q : typeof search.q === "number" ? String(search.q) : undefined,
		auto: search.auto === true ? true : undefined,
		asset: typeof search.asset === "string" ? search.asset : undefined,
	}),
	loaderDeps: ({ search }) => ({ kind: search.kind, q: search.q, auto: search.auto }),
	loader: ({ params, deps }) =>
		op<{ assets: AssetRow[] }>("asset.list", { projectId: params.projectId, kind: deps.kind, search: deps.q, includeAuto: deps.auto ?? false, withUrls: true, limit: LIST_LIMIT }),
	component: Files,
});

const KIND_NAMES: Record<AssetKind, string> = { image: "Images", video: "Video", audio: "Audio", font: "Fonts", animation: "Animations" };
const SOURCE_NAMES: Record<string, string> = { upload: "Uploaded", generated: "Generated", stock: "Stock", import: "Imported", url: "Imported" };
const sourceOf = (asset: AssetRow) => SOURCE_NAMES[asset.source] ?? asset.source;

function Files() {
	const { assets } = Route.useLoaderData();
	const { projectId } = Route.useParams();
	const search = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });
	const [query, setQuery] = useState(search.q ?? "");
	const open = assets.find((asset) => asset.id === search.asset);
	const selection = useSelection(assets);
	usePoll(assets.some((asset) => asset.status === "pending" || asset.footage?.status === "processing"), 4000);

	// Search as you type, without filling the browser history with every keystroke.
	useEffect(() => {
		if (query === (search.q ?? "")) return;
		const timer = setTimeout(() => void navigate({ search: (prev) => ({ ...prev, q: query || undefined }), replace: true }), 250);
		return () => clearTimeout(timer);
	}, [query, search.q, navigate]);

	const filtered = Boolean(search.kind || search.q || search.auto);
	const picking = selection.selected.size > 0;
	return (
		<>
			<Uploader projectId={projectId} />

			<div className="toolbar">
				<div className="chips">
					<Link from={Route.fullPath} search={(prev) => ({ ...prev, kind: undefined })} aria-current={search.kind ? undefined : "true"}>
						All
					</Link>
					{ASSET_KINDS.map((kind) => (
						<Link key={kind} from={Route.fullPath} search={(prev) => ({ ...prev, kind })} aria-current={search.kind === kind ? "true" : undefined}>
							{KIND_NAMES[kind]}
						</Link>
					))}
				</div>
				<label className="check soft">
					<input type="checkbox" checked={search.auto ?? false} onChange={(event) => void navigate({ search: (prev) => ({ ...prev, auto: event.target.checked || undefined }) })} />
					Include media made for scenes
				</label>
				<input type="search" className="search" placeholder="Search by name" value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Search files by name" />
			</div>

			{assets.length === 0 ? (
				filtered ? (
					<Empty
						title="No files match"
						actions={
							<Link className="btn quiet" from={Route.fullPath} search={{}}>
								Clear filters
							</Link>
						}
					>
						Nothing in this project fits the filters above.
					</Empty>
				) : (
					<Empty title="No files yet">Drop in a logo, product shots, footage or a voiceover above. Whatever your agent generates or imports appears here too.</Empty>
				)
			) : (
				<>
					<SelectionBar projectId={projectId} assets={assets} selection={selection} />
					<div className={`tiles${picking ? " picking" : ""}`}>
						{assets.map((asset, index) => {
							const on = selection.selected.has(asset.id);
							return (
								<div key={asset.id} className={`tile${on ? " on" : ""}`}>
									<Link
										from={Route.fullPath}
										search={(prev) => ({ ...prev, asset: asset.id })}
										resetScroll={false}
										onClick={(event) => {
											// While choosing files, or with Shift / Cmd / Ctrl held, a click selects instead of opening.
											if (!picking && !event.shiftKey && !event.metaKey && !event.ctrlKey) return;
											event.preventDefault();
											selection.pick(index, event);
										}}
									>
										<div className="thumb">
											<Thumb asset={asset} />
										</div>
										<div className="cap">
											<div className="title clip">{asset.name}</div>
											<div className="facts">
												<span>{sourceOf(asset)}</span>
												{asset.width && asset.height ? (
													<span>
														{asset.width}×{asset.height}
													</span>
												) : null}
												{asset.durationSec ? <span>{clock(asset.durationSec)}</span> : null}
											</div>
										</div>
									</Link>
									<label className="pick" title="Select (Shift-click to select a range)">
										<input type="checkbox" checked={on} readOnly onClick={(event) => selection.pick(index, event)} aria-label={`Select ${asset.name}`} />
									</label>
								</div>
							);
						})}
					</div>
					{assets.length >= LIST_LIMIT && <p className="soft" style={{ marginTop: 14 }}>Showing the newest {LIST_LIMIT} files. Filter or search to find older ones.</p>}
				</>
			)}

			{open && <FileDialog key={open.id} asset={open} onClose={() => void navigate({ search: (prev) => ({ ...prev, asset: undefined }), resetScroll: false })} />}
		</>
	);
}


type Selection = ReturnType<typeof useSelection>;

/**
 * Which files are chosen, the way a file manager does it: click toggles one,
 * Shift-click selects everything between it and the last one clicked, and
 * Cmd/Ctrl-A, Escape and Delete work while the grid has the page.
 */
function useSelection(assets: AssetRow[]) {
	const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
	const anchor = useRef<number | null>(null);
	const ids = assets.map((asset) => asset.id);
	const [confirming, setConfirming] = useState(false);

	// Forget files that left the list (deleted, or filtered out).
	const key = ids.join(",");
	// biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for the list of ids
	useEffect(() => {
		const present = new Set(ids);
		setSelected((prev) => {
			const next = new Set([...prev].filter((id) => present.has(id)));
			return next.size === prev.size ? prev : next;
		});
		anchor.current = null;
	}, [key]);

	const pick = (index: number, event: { shiftKey: boolean }) => {
		const id = ids[index];
		if (!id) return;
		const from = anchor.current !== null && ids[anchor.current] ? anchor.current : null;
		setSelected((prev) => {
			const next = new Set(prev);
			if (event.shiftKey && from !== null) {
				// The whole stretch follows the file the range starts from: all selected, or all cleared.
				const select = prev.has(ids[from]!);
				for (const each of ids.slice(Math.min(from, index), Math.max(from, index) + 1)) select ? next.add(each) : next.delete(each);
			} else if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
		if (!event.shiftKey || from === null) anchor.current = index;
		// Shift-click also selects page text; drop that.
		if (event.shiftKey) window.getSelection()?.removeAllRanges();
	};
	const all = () => setSelected(new Set(ids));
	const clear = () => {
		setSelected(new Set());
		anchor.current = null;
	};

	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			const target = event.target as HTMLElement | null;
			if (target?.closest("input:not([type=checkbox]), textarea, select, [contenteditable]") || document.querySelector("dialog[open]")) return;
			if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") {
				event.preventDefault();
				setSelected(new Set(ids));
			} else if (event.key === "Escape" && selected.size) {
				clear();
			} else if ((event.key === "Delete" || event.key === "Backspace") && selected.size) {
				event.preventDefault();
				setConfirming(true);
			}
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	});

	return { selected, pick, all, clear, confirming, setConfirming };
}

function SelectionBar({ projectId, assets, selection }: { projectId: string; assets: AssetRow[]; selection: Selection }) {
	const { busy, act } = useAct();
	const [tagging, setTagging] = useState<"add" | "remove" | null>(null);
	const { selected } = selection;
	const chosen = assets.filter((asset) => selected.has(asset.id));
	const count = chosen.length;
	const box = useRef<HTMLInputElement>(null);
	useEffect(() => {
		if (box.current) box.current.indeterminate = count > 0 && count < assets.length;
	}, [count, assets.length]);
	const assetIds = chosen.map((asset) => asset.id);
	const tagsInUse = [...new Set(chosen.flatMap((asset) => asset.tags))].sort();

	return (
		<div className={`picker-bar${count ? " active" : ""}`}>
			<label className="check">
				<input
					ref={box}
					type="checkbox"
					checked={count > 0 && count === assets.length}
					onChange={() => (count === assets.length ? selection.clear() : selection.all())}
					aria-label={count === assets.length ? "Clear selection" : "Select all files"}
				/>
				{count ? `${plural(count, "file")} selected` : `${plural(assets.length, "file")}`}
			</label>
			{count > 0 ? (
				<>
					{count < assets.length && (
						<button type="button" className="text" onClick={selection.all}>
							Select all {assets.length}
						</button>
					)}
					<span className="grow" />
					<button type="button" className="btn quiet small" onClick={() => setTagging("add")} disabled={busy}>
						Add tags
					</button>
					<button type="button" className="btn quiet small" onClick={() => setTagging("remove")} disabled={busy || tagsInUse.length === 0}>
						Remove tags
					</button>
					<button type="button" className="btn danger small" onClick={() => selection.setConfirming(true)} disabled={busy}>
						Delete
					</button>
					<button type="button" className="btn quiet small" onClick={selection.clear}>
						Done
					</button>
				</>
			) : (
				<span className="soft hint-keys">Shift-click to select a range · ⌘A for all</span>
			)}

			{tagging && (
				<TagDialog
					mode={tagging}
					count={count}
					tagsInUse={tagsInUse}
					busy={busy}
					onClose={() => setTagging(null)}
					onSubmit={async (tags) => {
						const input = tagging === "add" ? { add: tags } : { remove: tags };
						const done = tagging === "add" ? `Tagged ${plural(count, "file")}` : `Removed tags from ${plural(count, "file")}`;
						if (await act(() => op("asset.tag", { projectId, assetIds, ...input }), done)) setTagging(null);
					}}
				/>
			)}
			<Confirm
				open={selection.confirming && count > 0}
				onClose={() => selection.setConfirming(false)}
				title={count === 1 ? "Delete this file?" : `Delete ${count} files?`}
				action={count === 1 ? "Delete file" : `Delete ${count} files`}
				busy={busy}
				onConfirm={async () => {
					if (await act(() => op("asset.delete_many", { projectId, assetIds }), count === 1 ? "Deleted file" : `Deleted ${count} files`)) {
						selection.setConfirming(false);
						selection.clear();
					}
				}}
			>
				{count <= 3 ? chosen.map((asset) => `“${asset.name}”`).join(", ") : `${chosen.slice(0, 2).map((asset) => `“${asset.name}”`).join(", ")} and ${count - 2} more`}{" "}
				will be deleted. Scenes or brand settings that use {count === 1 ? "it" : "them"} fall back to their defaults. This cannot be undone.
			</Confirm>
		</div>
	);
}

function TagDialog({
	mode,
	count,
	tagsInUse,
	busy,
	onClose,
	onSubmit,
}: {
	mode: "add" | "remove";
	count: number;
	tagsInUse: string[];
	busy: boolean;
	onClose: () => void;
	onSubmit: (tags: string[]) => void;
}) {
	const [text, setText] = useState("");
	const [chosen, setChosen] = useState<ReadonlySet<string>>(() => new Set());
	const typed = text.split(",").map((tag) => tag.trim()).filter(Boolean);
	const tags = mode === "add" ? typed : [...chosen];
	return (
		<Confirm.Form
			title={mode === "add" ? `Add tags to ${plural(count, "file")}` : `Remove tags from ${plural(count, "file")}`}
			action={mode === "add" ? "Add tags" : "Remove tags"}
			busy={busy || tags.length === 0}
			onClose={onClose}
			onSubmit={() => tags.length && onSubmit(tags)}
		>
			{mode === "add" ? (
				<Field label="Tags" hint="Separated by commas, for example: logo, reference">
					<input value={text} onChange={(event) => setText(event.target.value)} maxLength={200} autoFocus />
				</Field>
			) : (
				<div className="fields">
					<span className="soft">Choose the tags to take off the selected files.</span>
					<div className="chips">
						{tagsInUse.map((tag) => (
							<button
								key={tag}
								type="button"
								aria-pressed={chosen.has(tag)}
								onClick={() =>
									setChosen((prev) => {
										const next = new Set(prev);
										next.has(tag) ? next.delete(tag) : next.add(tag);
										return next;
									})
								}
							>
								{tag}
							</button>
						))}
					</div>
				</div>
			)}
		</Confirm.Form>
	);
}

function Thumb({ asset }: { asset: AssetRow }) {
	if (asset.status !== "ready" || !asset.url) return <StatusOf status={asset.status} />;
	if (asset.kind === "image") return <img src={asset.url} alt="" loading="lazy" />;
	if (asset.kind === "video") return <video src={`${asset.url}#t=0.1`} preload="metadata" muted playsInline />;
	return <span className="glyph">{asset.kind === "audio" ? "♪" : asset.kind === "font" ? "Aa" : asset.kind === "animation" ? "Lottie" : "File"}</span>;
}

function FileDialog({ asset, onClose }: { asset: AssetRow; onClose: () => void }) {
	const { busy, act } = useAct();
	const [name, setName] = useState(asset.name);
	const [description, setDescription] = useState(asset.description ?? "");
	const [tags, setTags] = useState(asset.tags.join(", "));
	const [deleting, setDeleting] = useState(false);
	const tagList = tags.split(",").map((tag) => tag.trim()).filter(Boolean);
	const changed = name.trim() !== asset.name || description !== (asset.description ?? "") || tagList.join(",") !== asset.tags.join(",");
	return (
		<Dialog open onClose={onClose} title={asset.name} wide>
			<div className="asset-sheet">
				<div>
					<div className="preview">
						{asset.status !== "ready" || !asset.url ? (
							<StatusOf status={asset.status} />
						) : asset.kind === "image" ? (
							<img src={asset.url} alt={asset.description ?? asset.name} />
						) : asset.kind === "video" ? (
							// biome-ignore lint/a11y/useMediaCaption: a person's own footage has no captions
							<video src={asset.url} controls playsInline />
						) : asset.kind === "audio" ? (
							// biome-ignore lint/a11y/useMediaCaption: a person's own audio has no captions
							<audio src={asset.url} controls />
						) : (
							<span className="soft">No preview for this kind of file</span>
						)}
					</div>
					{asset.error && (
						<p className="note bad" style={{ marginTop: 12 }}>
							{asset.error}
						</p>
					)}
					<dl className="details" style={{ marginTop: 16 }}>
						<dt>Kind</dt>
						<dd>
							{asset.kind}
							{asset.contentType ? ` (${asset.contentType})` : ""}
						</dd>
						<dt>Came from</dt>
						<dd>{sourceOf(asset)}</dd>
						{asset.width && asset.height ? (
							<>
								<dt>Dimensions</dt>
								<dd className="num">
									{asset.width} × {asset.height}
								</dd>
							</>
						) : null}
						{asset.durationSec ? (
							<>
								<dt>Length</dt>
								<dd className="num">{clock(asset.durationSec)}</dd>
							</>
						) : null}
						{asset.bytes ? (
							<>
								<dt>Size</dt>
								<dd className="num">{sizeOf(asset.bytes)}</dd>
							</>
						) : null}
						<dt>Added</dt>
						<dd>{when(asset.createdAt)}</dd>
						{asset.footage && (
							<>
								<dt>Recording</dt>
								<dd>
									{asset.footage.status === "processing" ? `Processing${asset.footage.stage ? `: ${asset.footage.stage}` : ""}` : asset.footage.status}
									{asset.footage.transcriptWords ? `, ${asset.footage.transcriptWords} words transcribed` : ""}
									{asset.footage.error ? `. ${asset.footage.error}` : ""}
								</dd>
							</>
						)}
						{asset.prompt && (
							<>
								<dt>Prompt</dt>
								<dd>{asset.prompt}</dd>
							</>
						)}
						{asset.license?.license && (
							<>
								<dt>Licence</dt>
								<dd>
									{asset.license.license}
									{asset.license.author ? `, ${asset.license.author}` : ""}
								</dd>
							</>
						)}
						<dt>File id</dt>
						<dd>
							<CopyId id={asset.id} />
						</dd>
					</dl>
				</div>
				<form
					className="fields"
					style={{ alignContent: "start" }}
					onSubmit={(event) => {
						event.preventDefault();
						void act(() => op("asset.update", { assetId: asset.id, name: name.trim(), description, tags: tagList }), "Saved changes");
					}}
				>
					<Field label="Name">
						<input value={name} onChange={(event) => setName(event.target.value)} maxLength={200} required />
					</Field>
					<Field label="Description" hint="Say what it shows. Your agent picks files by this.">
						<textarea value={description} onChange={(event) => setDescription(event.target.value)} maxLength={2000} />
					</Field>
					<Field label="Tags" hint="Separated by commas, for example: logo, reference">
						<input value={tags} onChange={(event) => setTags(event.target.value)} />
					</Field>
					<div className="sheet-foot" style={{ justifyContent: "flex-start", marginTop: 4 }}>
						<button type="submit" className="btn" disabled={busy || !changed || !name.trim()}>
							Save changes
						</button>
						{asset.url && (
							<a className="btn quiet" href={asset.url} target="_blank" rel="noreferrer">
								Open file
							</a>
						)}
						<button type="button" className="btn danger" onClick={() => setDeleting(true)}>
							Delete file
						</button>
					</div>
				</form>
			</div>
			<Confirm
				open={deleting}
				onClose={() => setDeleting(false)}
				title="Delete this file?"
				action="Delete file"
				busy={busy}
				onConfirm={async () => {
					if (await act(() => op("asset.delete", { assetId: asset.id }), "Deleted file")) onClose();
				}}
			>
				“{asset.name}” will be deleted. Scenes or brand settings that use it fall back to their defaults. This cannot be undone.
			</Confirm>
		</Dialog>
	);
}

const ACCEPT = "image/*,video/*,audio/*,font/*,.ttf,.otf,.woff,.woff2,.json";
const ACCEPTED_KINDS = ["image/", "video/", "audio/", "font/"];
/** Fonts and Lottie animations (JSON) often arrive without a usable MIME type. */
const BY_EXTENSION = /\.(ttf|otf|woff2?|json)$/i;

interface Upload {
	key: string;
	name: string;
	progress: number;
	error?: string;
	done?: boolean;
}

/** A drop zone for the person's own files, with progress for each one. */
function Uploader({ projectId }: { projectId: string }) {
	const { act } = useAct();
	const [uploads, setUploads] = useState<Upload[]>([]);
	const [tags, setTags] = useState("");
	const [over, setOver] = useState(false);
	const picker = useRef<HTMLInputElement>(null);
	const patch = (key: string, change: Partial<Upload>) => setUploads((list) => list.map((upload) => (upload.key === key ? { ...upload, ...change } : upload)));

	async function add(files: File[]) {
		const batch = files.map((file) => ({ file, key: `${file.name}:${file.size}:${Math.random()}` }));
		setUploads((list) => [...list.filter((upload) => !upload.done), ...batch.map(({ file, key }) => ({ key, name: file.name, progress: 0 }))]);
		// One at a time: large video files would otherwise compete for the same connection.
		for (const { file, key } of batch) {
			if (!ACCEPTED_KINDS.some((prefix) => file.type.startsWith(prefix)) && !BY_EXTENSION.test(file.name)) {
				patch(key, { error: "Not an image, video, audio, font or Lottie file" });
				continue;
			}
			try {
				await uploadAsset(projectId, file, { tags, onProgress: (progress) => patch(key, { progress }) });
				patch(key, { progress: 1, done: true });
				await act(async () => undefined);
			} catch (error) {
				patch(key, { error: (error as Error).message });
			}
		}
	}

	return (
		<>
			<div
				className={`drop${over ? " over" : ""}`}
				onDragOver={(event) => {
					event.preventDefault();
					setOver(true);
				}}
				onDragLeave={() => setOver(false)}
				onDrop={(event) => {
					event.preventDefault();
					setOver(false);
					void add([...event.dataTransfer.files]);
				}}
			>
				<div className="grow">
					<h3>Drop your own files here</h3>
					<p className="soft">Logos, product shots, footage, a voiceover, music, fonts. Your agent sees them in the project brief.</p>
				</div>
				<input className="tags" placeholder="Tags, e.g. logo" value={tags} onChange={(event) => setTags(event.target.value)} aria-label="Tags for these files" maxLength={200} />
				<button type="button" className="btn" onClick={() => picker.current?.click()}>
					Choose files
				</button>
				<input
					ref={picker}
					type="file"
					multiple
					accept={ACCEPT}
					hidden
					onChange={(event) => {
						void add([...(event.target.files ?? [])]);
						event.target.value = "";
					}}
				/>
			</div>
			{uploads.length > 0 && (
				<div className="lines" style={{ marginTop: 12 }}>
					{uploads.map((upload) => (
						<div key={upload.key} className="line">
							<div className="grow">
								<div className="title clip">{upload.name}</div>
								{upload.error && <div style={{ color: "var(--red)" }}>{upload.error}</div>}
							</div>
							{!upload.error && (
								<div className="progress" style={{ width: 220 }}>
									<Tween value={upload.progress} label={`Uploading ${upload.name}`} />
									<span className="pct">{upload.done ? "Added" : `${Math.round(upload.progress * 100)}%`}</span>
								</div>
							)}
						</div>
					))}
				</div>
			)}
		</>
	);
}
