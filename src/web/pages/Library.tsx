import { useEffect, useRef, useState } from "react";
import { op, uploadAsset, when } from "../api.ts";
import { Section, useLoad } from "../ui.tsx";

interface ProjectRow {
	id: string;
	name: string;
	description?: string | null;
	videos: number;
	assets: number;
	updatedAt: string;
}
interface VideoRow {
	id: string;
	title: string;
	status: string;
	aspect: string;
	scenes: number;
	durationSec?: number;
}
interface AssetRow {
	id: string;
	kind: "image" | "video" | "audio" | "font" | "other";
	name: string;
	description?: string;
	tags: string[];
	status: string;
	source: string;
	bytes?: number;
	width?: number;
	height?: number;
	durationSec?: number;
	error?: string;
	url?: string;
}
interface RenderRow {
	id: string;
	aspect: string;
	resolution: string;
	status: string;
	progress: number;
	url?: string;
	downloadUrl?: string;
	bytes?: number;
	error?: string;
	createdAt: string;
}

/** `/projects/<id>` (the link asset.upload_link hands out) opens that project. */
const linkedProject = () => location.pathname.match(/^\/projects\/([^/]+)/)?.[1] ?? null;

/** What the agent has made, plus a place to hand it your own files. Editing happens through MCP or the CLI. */
export function Library() {
	const projects = useLoad(() => op<{ projects: ProjectRow[] }>("project.list"));
	const [open, setOpen] = useState<string | null>(linkedProject);
	return (
		<Section
			index="A"
			title="Library"
			note="Projects and the videos made in them. Watch and download here, and upload your own files for your agent to use; projects are built and edited by your agent or from the CLI."
		>
			<div className="rows">
				{projects.error && <div className="notice">{projects.error}</div>}
				{projects.data?.projects.length === 0 && (
					<div className="empty">Nothing here yet. Connect an agent, then ask it to create a project and make a video.</div>
				)}
				{(projects.data?.projects ?? []).map((project) => (
					<div key={project.id}>
						<div className="row">
							<div className="grow">
								<div className="title">{project.name}</div>
								<div className="faint mono">
									{project.id} · {project.videos} video{project.videos === 1 ? "" : "s"} · {project.assets} asset{project.assets === 1 ? "" : "s"} · updated {when(project.updatedAt)}
								</div>
							</div>
							<button type="button" className="btn small ghost" onClick={() => setOpen(open === project.id ? null : project.id)}>
								{open === project.id ? "Close" : "Open"}
							</button>
						</div>
						{open === project.id && (
							<div className="nest">
								<Assets projectId={project.id} linked={linkedProject() === project.id} onChange={projects.reload} />
								<Videos projectId={project.id} />
							</div>
						)}
					</div>
				))}
			</div>
		</Section>
	);
}

const ACCEPT = "image/*,video/*,audio/*,font/*,.ttf,.otf,.woff,.woff2";
const ACCEPTED_KINDS = ["image/", "video/", "audio/", "font/"];
const FONT_FILE = /\.(ttf|otf|woff2?)$/i;

interface Upload {
	key: string;
	name: string;
	progress: number;
	error?: string;
	done?: boolean;
}

const sizeOf = (bytes?: number) => (bytes == null ? "" : bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} KB`);

/** The project's reusable assets, and a drop zone for adding your own. */
function Assets({ projectId, linked, onChange }: { projectId: string; linked: boolean; onChange: () => void }) {
	const assets = useLoad(() => op<{ assets: AssetRow[] }>("asset.list", { projectId, withUrls: true, limit: 60 }), [projectId]);
	const [uploads, setUploads] = useState<Upload[]>([]);
	const [tags, setTags] = useState("");
	const [over, setOver] = useState(false);
	const picker = useRef<HTMLInputElement>(null);
	const zone = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (linked) zone.current?.scrollIntoView({ behavior: "smooth", block: "center" });
	}, [linked]);

	const patch = (key: string, change: Partial<Upload>) => setUploads((list) => list.map((u) => (u.key === key ? { ...u, ...change } : u)));

	async function add(files: File[]) {
		const batch = files.map((file) => ({ file, key: `${file.name}:${file.size}:${Math.random()}` }));
		setUploads((list) => [...list.filter((u) => !u.done), ...batch.map(({ file, key }) => ({ key, name: file.name, progress: 0 }))]);
		// One at a time: large video files would otherwise compete for the same connection.
		for (const { file, key } of batch) {
			if (!ACCEPTED_KINDS.some((prefix) => file.type.startsWith(prefix)) && !FONT_FILE.test(file.name)) {
				patch(key, { error: "Not an image, video, audio or font file" });
				continue;
			}
			try {
				await uploadAsset(projectId, file, { tags, onProgress: (progress) => patch(key, { progress }) });
				patch(key, { progress: 1, done: true });
				assets.reload();
			} catch (error) {
				patch(key, { error: (error as Error).message });
			}
		}
		onChange();
	}

	async function remove(asset: AssetRow) {
		if (!confirm(`Delete "${asset.name}"? Scenes that use it fall back to defaults.`)) return;
		try {
			await op("asset.delete", { assetId: asset.id });
			assets.reload();
			onChange();
		} catch (error) {
			alert((error as Error).message);
		}
	}

	const list = assets.data?.assets ?? [];
	return (
		<div>
			<div className="label sub">Assets</div>
			<div
				ref={zone}
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
					<div className="title">Drop your own files here</div>
					<div className="faint">Logos, product shots, footage, a voiceover, music, fonts. Your agent sees them in the project brief.</div>
				</div>
				<input className="tags" placeholder="Tags, e.g. logo" value={tags} onChange={(e) => setTags(e.target.value)} aria-label="Tags for these files" maxLength={200} />
				<button type="button" className="btn small" onClick={() => picker.current?.click()}>
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
			{uploads.map((upload) => (
				<div key={upload.key} className="row">
					<div className="grow">
						<div className="title">{upload.name}</div>
						{upload.error ? (
							<div className="faint" style={{ color: "var(--signal)" }}>
								{upload.error}
							</div>
						) : (
							<div className="meter">
								<i style={{ width: `${Math.round(upload.progress * 100)}%` }} />
							</div>
						)}
					</div>
					<span className={`pill ${upload.error ? "signal" : upload.done ? "ok" : ""}`}>
						{upload.error ? "failed" : upload.done ? "added" : `${Math.round(upload.progress * 100)}%`}
					</span>
				</div>
			))}
			{assets.error && <div className="notice">{assets.error}</div>}
			{assets.data && list.length === 0 && <div className="empty">No assets yet.</div>}
			{list.length > 0 && (
				<div className="tiles">
					{list.map((asset) => (
						<figure key={asset.id} className="tile">
							<div className="thumb">
								{asset.status !== "ready" || !asset.url ? (
									<span className="faint mono">{asset.status}</span>
								) : asset.kind === "image" ? (
									<img src={asset.url} alt={asset.description ?? asset.name} loading="lazy" />
								) : asset.kind === "video" ? (
									<video src={`${asset.url}#t=0.1`} preload="metadata" muted playsInline controls />
								) : asset.kind === "audio" ? (
									// biome-ignore lint/a11y/useMediaCaption: user-supplied audio has no captions
									<audio src={asset.url} preload="none" controls />
								) : (
									<span className="glyph">Aa</span>
								)}
							</div>
							<figcaption>
								<div className="title" title={asset.name}>
									{asset.name}
								</div>
								<div className="faint mono">
									{asset.kind} · {asset.source}
									{asset.width && asset.height ? ` · ${asset.width}×${asset.height}` : ""}
									{asset.durationSec ? ` · ${asset.durationSec.toFixed(1)}s` : ""}
									{asset.bytes ? ` · ${sizeOf(asset.bytes)}` : ""}
								</div>
								{asset.tags.length > 0 && <div className="faint mono">{asset.tags.join(", ")}</div>}
								{asset.source === "upload" && (
									<button type="button" className="link" onClick={() => void remove(asset)}>
										Delete
									</button>
								)}
							</figcaption>
						</figure>
					))}
				</div>
			)}
		</div>
	);
}

function Videos({ projectId }: { projectId: string }) {
	const videos = useLoad(() => op<{ videos: VideoRow[] }>("video.list", { projectId }), [projectId]);
	const [open, setOpen] = useState<string | null>(null);
	return (
		<div>
			<div className="label sub">Videos</div>
			{videos.data?.videos.length === 0 && <div className="empty">No videos in this project.</div>}
			{(videos.data?.videos ?? []).map((video) => (
				<div key={video.id}>
					<div className="row">
						<div className="grow">
							<div className="title">{video.title}</div>
							<div className="faint mono">
								{video.aspect} · {video.scenes} scene{video.scenes === 1 ? "" : "s"}
								{video.durationSec ? ` · ${video.durationSec.toFixed(1)}s` : ""}
							</div>
						</div>
						<span className={`pill ${video.status === "ready" ? "ok" : video.status === "failed" ? "signal" : ""}`}>{video.status}</span>
						<button type="button" className="btn small ghost" onClick={() => setOpen(open === video.id ? null : video.id)}>
							{open === video.id ? "Hide" : "Renders"}
						</button>
					</div>
					{open === video.id && <Renders videoId={video.id} />}
				</div>
			))}
		</div>
	);
}

function Renders({ videoId }: { videoId: string }) {
	const renders = useLoad(() => op<{ renders: RenderRow[] }>("render.list", { videoId }), [videoId]);
	const [playing, setPlaying] = useState<string | null>(null);
	return (
		<div style={{ paddingLeft: 28 }}>
			{renders.data?.renders.length === 0 && <div className="empty">Not rendered yet.</div>}
			{(renders.data?.renders ?? []).map((render) => (
				<div key={render.id}>
					<div className="row">
						<div className="grow">
							<div className="title mono">
								{render.aspect} · {render.resolution}
							</div>
							<div className="faint mono">
								{when(render.createdAt)}
								{render.bytes ? ` · ${(render.bytes / 1e6).toFixed(1)} MB` : ""}
								{render.error ? ` · ${render.error}` : ""}
							</div>
						</div>
						<span className={`pill ${render.status === "done" ? "ok" : render.status === "failed" ? "signal" : ""}`}>
							{render.status === "rendering" ? `${render.progress}%` : render.status}
						</span>
						{render.url && (
							<div className="actions">
								<button type="button" className="btn small ghost" onClick={() => setPlaying(playing === render.id ? null : render.id)}>
									{playing === render.id ? "Close" : "Play"}
								</button>
								<a className="btn small" href={render.downloadUrl}>
									Download
								</a>
							</div>
						)}
					</div>
					{playing === render.id && render.url && (
						// biome-ignore lint/a11y/useMediaCaption: captions are burned into the video
						<video className="player" src={render.url} controls autoPlay />
					)}
				</div>
			))}
		</div>
	);
}
