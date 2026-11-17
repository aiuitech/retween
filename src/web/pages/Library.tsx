import { useState } from "react";
import { op, when } from "../api.ts";
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

/** Read-only view of what the agent has made. Editing happens through MCP or the CLI. */
export function Library() {
	const projects = useLoad(() => op<{ projects: ProjectRow[] }>("project.list"));
	const [open, setOpen] = useState<string | null>(null);
	return (
		<Section index="A" title="Library" note="Projects and the videos made in them. This page is for watching and downloading; projects are built and edited by your agent or from the CLI.">
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
						{open === project.id && <Videos projectId={project.id} />}
					</div>
				))}
			</div>
		</Section>
	);
}

function Videos({ projectId }: { projectId: string }) {
	const videos = useLoad(() => op<{ videos: VideoRow[] }>("video.list", { projectId }), [projectId]);
	const [open, setOpen] = useState<string | null>(null);
	return (
		<div style={{ paddingLeft: 28, borderLeft: "1px solid var(--ink)", margin: "0 0 18px 6px" }}>
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
