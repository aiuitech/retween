import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { clock, op, sizeOf, uploadAsset, when } from "../../../../../api.ts";
import { ASSET_KINDS, type AssetKind, type AssetRow } from "../../../../../types.ts";
import { Confirm, CopyId, Dialog, Empty, Field, StatusOf, Tween, useAct, usePoll } from "../../../../../ui.tsx";

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
		op<{ assets: AssetRow[] }>("asset.list", { projectId: params.projectId, kind: deps.kind, search: deps.q, includeAuto: deps.auto ?? false, withUrls: true, limit: 200 }),
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
	usePoll(assets.some((asset) => asset.status === "pending" || asset.footage?.status === "processing"), 4000);

	// Search as you type, without filling the browser history with every keystroke.
	useEffect(() => {
		if (query === (search.q ?? "")) return;
		const timer = setTimeout(() => void navigate({ search: (prev) => ({ ...prev, q: query || undefined }), replace: true }), 250);
		return () => clearTimeout(timer);
	}, [query, search.q, navigate]);

	const filtered = Boolean(search.kind || search.q || search.auto);
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
				<div className="tiles">
					{assets.map((asset) => (
						<Link key={asset.id} className="tile" from={Route.fullPath} search={(prev) => ({ ...prev, asset: asset.id })} resetScroll={false}>
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
					))}
				</div>
			)}

			{open && <FileDialog key={open.id} asset={open} onClose={() => void navigate({ search: (prev) => ({ ...prev, asset: undefined }), resetScroll: false })} />}
		</>
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
