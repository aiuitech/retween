/** Dialogs for creating, renaming and deleting the things a person manages here. */
import { notFound, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ApiError, op, when } from "./api.ts";
import { ASPECTS, type ProjectRow, RESOLUTIONS, type RenderRow, type VideoRow, type YoutubeUpload } from "./types.ts";
import { Confirm, Dialog, Field, StatusOf, useAct } from "./ui.tsx";

/** In a loader: an id that does not exist (or belongs to someone else) is a missing page, not a crash. */
export const orNotFound = (error: unknown): never => {
	if (error instanceof ApiError && error.status === 404) throw notFound();
	throw error;
};

interface DialogProps {
	open: boolean;
	onClose: () => void;
}

/** Creates a project, or edits the one passed in. */
export function ProjectDialog({ open, onClose, project }: DialogProps & { project?: ProjectRow }) {
	const navigate = useNavigate();
	const { busy, act } = useAct();
	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	useEffect(() => {
		if (!open) return;
		setName(project?.name ?? "");
		setDescription(project?.description ?? "");
	}, [open, project]);
	return (
		<Dialog open={open} onClose={onClose} title={project ? "Edit project" : "New project"}>
			{!project && <p>A project holds one brand: its kit, its files and its videos. Your agent fills in the brand kit as you describe it.</p>}
			<form
				className="fields"
				onSubmit={async (event) => {
					event.preventDefault();
					let created: ProjectRow | undefined;
					const saved = await act(async () => {
						if (project) await op("project.update", { projectId: project.id, name: name.trim(), description });
						else created = (await op<{ project: ProjectRow }>("project.create", { name: name.trim(), description: description.trim() || undefined })).project;
					}, project ? "Saved changes" : "Created project");
					if (!saved) return;
					onClose();
					if (created) void navigate({ to: "/projects/$projectId", params: { projectId: created.id } });
				}}
			>
				<Field label="Name">
					<input value={name} onChange={(event) => setName(event.target.value)} maxLength={120} required autoFocus />
				</Field>
				<Field label="What it is for" hint="Optional. A line your agent reads before making anything.">
					<textarea value={description} onChange={(event) => setDescription(event.target.value)} maxLength={2000} />
				</Field>
				<div className="sheet-foot">
					<button type="button" className="btn quiet" onClick={onClose}>
						Cancel
					</button>
					<button type="submit" className="btn" disabled={busy || !name.trim()}>
						{project ? "Save changes" : "Create project"}
					</button>
				</div>
			</form>
		</Dialog>
	);
}

export function DeleteProject({ open, onClose, project, onDeleted }: DialogProps & { project: ProjectRow; onDeleted?: () => unknown }) {
	const { busy, act } = useAct();
	return (
		<Confirm
			open={open}
			onClose={onClose}
			title="Delete this project?"
			action="Delete project"
			phrase={project.name}
			busy={busy}
			onConfirm={async () => {
				// Leave the project's pages before reloading, or they would reload a project that is gone.
				if (await act(async () => {
					await op("project.delete", { projectId: project.id, confirm: true });
					await onDeleted?.();
				}, "Deleted project")) onClose();
			}}
		>
			{project.name} will be deleted with its brand kit, {project.assets} {project.assets === 1 ? "file" : "files"} and {project.videos} {project.videos === 1 ? "video" : "videos"}, including every export. This cannot be undone.
		</Confirm>
	);
}

/** Creates a video, or edits the title, brief and shape of the one passed in. */
export function VideoDialog({ open, onClose, projectId, video }: DialogProps & { projectId: string; video?: VideoRow }) {
	const navigate = useNavigate();
	const { busy, act } = useAct();
	const [title, setTitle] = useState("");
	const [brief, setBrief] = useState("");
	const [aspect, setAspect] = useState("");
	useEffect(() => {
		if (!open) return;
		setTitle(video?.title ?? "");
		setBrief(video?.brief ?? "");
		setAspect(video?.aspect ?? "");
	}, [open, video]);
	return (
		<Dialog open={open} onClose={onClose} title={video ? "Edit video" : "New video"}>
			{!video && <p>This makes an empty video. Tell your agent what it should say and show, and it writes the storyboard.</p>}
			<form
				className="fields"
				onSubmit={async (event) => {
					event.preventDefault();
					let created: VideoRow | undefined;
					const saved = await act(async () => {
						const fields = { title: title.trim(), brief: video ? brief : brief.trim() || undefined, aspect: aspect || undefined };
						if (video) await op("video.update", { videoId: video.id, ...fields });
						else created = (await op<{ video: VideoRow }>("video.create", { projectId, ...fields })).video;
					}, video ? "Saved changes" : "Created video");
					if (!saved) return;
					onClose();
					if (created) void navigate({ to: "/projects/$projectId/videos/$videoId", params: { projectId, videoId: created.id } });
				}}
			>
				<Field label="Title">
					<input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={200} required autoFocus />
				</Field>
				<Field label="Brief" hint="Optional. The goal, the audience and the one thing to get across.">
					<textarea value={brief} onChange={(event) => setBrief(event.target.value)} maxLength={4000} />
				</Field>
				<Field label="Shape" hint="Pictures are generated for this shape. Other shapes crop from it when exporting.">
					<select value={aspect} onChange={(event) => setAspect(event.target.value)}>
						{!video && <option value="">The brand's usual shape</option>}
						{ASPECTS.map((value) => (
							<option key={value} value={value}>
								{ASPECT_NAMES[value]}
							</option>
						))}
					</select>
				</Field>
				<div className="sheet-foot">
					<button type="button" className="btn quiet" onClick={onClose}>
						Cancel
					</button>
					<button type="submit" className="btn" disabled={busy || !title.trim()}>
						{video ? "Save changes" : "Create video"}
					</button>
				</div>
			</form>
		</Dialog>
	);
}

export const ASPECT_NAMES: Record<string, string> = {
	"16:9": "16:9 wide",
	"9:16": "9:16 vertical",
	"1:1": "1:1 square",
	"4:5": "4:5 portrait",
};

export function DeleteVideo({ open, onClose, video, onDeleted }: DialogProps & { video: VideoRow; onDeleted?: () => unknown }) {
	const { busy, act } = useAct();
	return (
		<Confirm
			open={open}
			onClose={onClose}
			title="Delete this video?"
			action="Delete video"
			busy={busy}
			onConfirm={async () => {
				if (await act(async () => {
					await op("video.delete", { videoId: video.id });
					await onDeleted?.();
				}, "Deleted video")) onClose();
			}}
		>
			“{video.title}” will be deleted with its storyboard, its exports and the narration and pictures generated for it. Files you uploaded stay in the project. This cannot be undone.
		</Confirm>
	);
}

export function DeleteRender({ open, onClose, render, onDeleted }: DialogProps & { render: RenderRow; onDeleted?: () => unknown }) {
	const { busy, act } = useAct();
	return (
		<Confirm
			open={open}
			onClose={onClose}
			title="Delete this export?"
			action="Delete export"
			busy={busy}
			onConfirm={async () => {
				if (await act(async () => {
					await op("render.delete", { renderId: render.id });
					await onDeleted?.();
				}, "Deleted export")) onClose();
			}}
		>
			The {render.aspect} {render.resolution} file will be deleted and its links will stop working. The video itself is kept, so it can be exported again.
		</Confirm>
	);
}

/** Starts one export per ticked shape, at one size. */
export function ExportDialog({ open, onClose, video }: DialogProps & { video: VideoRow }) {
	const { busy, act } = useAct();
	const [shapes, setShapes] = useState<string[]>([]);
	const [resolution, setResolution] = useState("1080p");
	useEffect(() => {
		if (open) setShapes([video.aspect]);
	}, [open, video.aspect]);
	return (
		<Dialog open={open} onClose={onClose} title="Export video">
			<p>The same timeline is laid out again for each shape. Rendering takes about as long as the video plays, and render time is charged to your budget.</p>
			<form
				className="fields"
				onSubmit={async (event) => {
					event.preventDefault();
					const started = await act(
						() => op("video.render", { videoId: video.id, exports: shapes.map((aspect) => ({ aspect, resolution })), waitSeconds: 0 }),
						shapes.length === 1 ? "Started export" : `Started ${shapes.length} exports`,
					);
					if (started) onClose();
				}}
			>
				<fieldset style={{ border: 0, padding: 0, margin: 0 }}>
					<legend className="name" style={{ fontWeight: 500, marginBottom: 8, padding: 0 }}>
						Shapes
					</legend>
					<div style={{ display: "grid", gap: 8 }}>
						{ASPECTS.map((value) => (
							<label key={value} className="check">
								<input
									type="checkbox"
									checked={shapes.includes(value)}
									onChange={(event) => setShapes(event.target.checked ? [...shapes, value] : shapes.filter((shape) => shape !== value))}
								/>
								{ASPECT_NAMES[value]}
								{value === video.aspect && <span className="softer">the video's own shape</span>}
							</label>
						))}
					</div>
				</fieldset>
				<Field label="Size" hint="The short side, in pixels. Your cost controls may lower it.">
					<select value={resolution} onChange={(event) => setResolution(event.target.value)}>
						{RESOLUTIONS.map((value) => (
							<option key={value} value={value}>
								{value}
								{value === "2160p" ? " (4K)" : ""}
							</option>
						))}
					</select>
				</Field>
				<div className="sheet-foot">
					<button type="button" className="btn quiet" onClick={onClose}>
						Cancel
					</button>
					<button type="submit" className="btn" disabled={busy || shapes.length === 0}>
						{shapes.length > 1 ? `Start ${shapes.length} exports` : "Start export"}
					</button>
				</div>
			</form>
		</Dialog>
	);
}

/** One publication of an export to YouTube. */
export function UploadLine({ upload }: { upload: YoutubeUpload }) {
	return (
		<div className="line">
			<div className="grow">
				<div className="title clip">{upload.title}</div>
				<div className="facts">
					<span>{upload.channel.title}</span>
					<span>{upload.privacy}</span>
					<span>{when(upload.createdAt)}</span>
					{upload.error && <span style={{ color: "var(--red)" }}>{upload.error}</span>}
				</div>
			</div>
			<StatusOf status={upload.status} />
			<div className="acts">
				{upload.url && (
					<a className="btn quiet small" href={upload.url} target="_blank" rel="noreferrer">
						Watch on YouTube
					</a>
				)}
				{upload.studioUrl && (
					<a className="btn quiet small" href={upload.studioUrl} target="_blank" rel="noreferrer">
						Open in Studio
					</a>
				)}
			</div>
		</div>
	);
}
