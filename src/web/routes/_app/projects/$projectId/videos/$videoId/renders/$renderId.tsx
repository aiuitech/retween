import { Link, createFileRoute, getRouteApi, notFound, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { clock, op, sizeOf, whenExactly } from "../../../../../../../api.ts";
import { DeleteRender, UploadLine, orNotFound } from "../../../../../../../forms.tsx";
import { HostingBlock, useHostingDialogs } from "../../../../../../../hosting.tsx";
import type { HostedVideo, RenderRow, YoutubeUpload } from "../../../../../../../types.ts";
import { CopyId, Crumbs, Missing, StatusOf, Tween, isRunning, useAct, usePoll, useToast } from "../../../../../../../ui.tsx";

const project = getRouteApi("/_app/projects/$projectId");
const video = getRouteApi("/_app/projects/$projectId/videos/$videoId");

export const Route = createFileRoute("/_app/projects/$projectId/videos/$videoId/renders/$renderId")({
	loader: async ({ params }) => {
		const [{ render }, uploads, hosting] = await Promise.all([
			op<{ render: RenderRow }>("render.get", { renderId: params.renderId }).catch(orNotFound),
			op<{ uploads: YoutubeUpload[] }>("youtube.list", { videoId: params.videoId }).catch(() => ({ uploads: [] })),
			op<{ hosted: HostedVideo[] }>("hosting.list", { videoId: params.videoId }).catch(() => ({ hosted: [] })),
		]);
		if (render.videoId !== params.videoId) throw notFound();
		return {
			render,
			uploads: uploads.uploads.filter((upload) => upload.renderId === render.id),
			hosted: hosting.hosted.filter((hosted) => hosted.renderId === render.id),
		};
	},
	notFoundComponent: () => <Missing what="export">It may have been deleted. The video it was made from is still in its project.</Missing>,
	component: RenderPage,
});

function RenderPage() {
	const { project: parent } = project.useLoaderData();
	const { video: source } = video.useLoaderData();
	const { render, uploads, hosted } = Route.useLoaderData();
	const navigate = useNavigate();
	const toast = useToast();
	const { busy, act } = useAct();
	const [deleting, setDeleting] = useState(false);
	const hosting = useHostingDialogs();
	const live = hosted.find((copy) => copy.status !== "failed");
	const params = { projectId: parent.id, videoId: source.id };
	const running = isRunning(render.status);
	usePoll(running || uploads.some((upload) => isRunning(upload.status)) || hosted.some((copy) => isRunning(copy.status)), 2500);
	const name = `${render.aspect} at ${render.resolution}`;

	return (
		<main className="page">
			<Crumbs>
				<li>
					<Link to="/projects">Projects</Link>
				</li>
				<li>
					<Link to="/projects/$projectId" params={params}>
						{parent.name}
					</Link>
				</li>
				<li>
					<Link to="/projects/$projectId/videos/$videoId" params={params}>
						{source.title}
					</Link>
				</li>
				<li aria-current="page">{name}</li>
			</Crumbs>
			<div className="head">
				<div className="words">
					<h1 className="num">{name}</h1>
					<div className="facts">
						<StatusOf status={render.status} />
						<span>Export of {source.title}</span>
					</div>
				</div>
				<div className="acts">
					{render.downloadUrl && (
						<a className="btn" href={render.downloadUrl}>
							Download
						</a>
					)}
					{render.status === "done" &&
						(live ? (
							<button type="button" className="btn quiet" onClick={() => hosting.setShareId(live.id)}>
								Share or embed
							</button>
						) : (
							<button type="button" className="btn quiet" onClick={() => hosting.setHostFor(render.id)}>
								Host on the web
							</button>
						))}
					{render.url && (
						<button
							type="button"
							className="btn quiet"
							onClick={() => {
								void navigator.clipboard.writeText(render.url!);
								toast("Copied link. It works for a day.");
							}}
						>
							Copy link
						</button>
					)}
					{running && (
						<button type="button" className="btn quiet" disabled={busy} onClick={() => void act(() => op("render.cancel", { renderId: render.id }), "Cancelled export")}>
							Cancel export
						</button>
					)}
					<button type="button" className="btn danger" onClick={() => setDeleting(true)}>
						Delete export
					</button>
				</div>
			</div>

			{render.error && (
				<p className="note bad" style={{ marginTop: 22 }}>
					The export failed: {render.error} Export the video again from its page; if it keeps failing, ask your agent to run a check on the video.
				</p>
			)}

			<div className="with-aside">
				<div>
					<div className="player" style={render.width && render.height ? { aspectRatio: render.url ? undefined : `${render.width} / ${render.height}`, maxHeight: "70vh" } : undefined}>
						{render.url ? (
							// biome-ignore lint/a11y/useMediaCaption: captions are burned into the video
							<video src={render.url} poster={render.posterUrl} controls playsInline />
						) : (
							<div className="pending">
								{running ? (
									<>
										<Tween value={render.status === "rendering" ? render.progress / 100 : undefined} label="Rendering" />
										<p style={{ marginTop: 14 }}>
											{render.status === "rendering" ? `Rendering, ${render.progress}% done` : render.status === "uploading" ? "Saving the file" : "Waiting for a renderer"}
										</p>
									</>
								) : (
									<p>{render.status === "cancelled" ? "This export was cancelled before it finished." : "There is no file for this export."}</p>
								)}
							</div>
						)}
					</div>
					{render.warnings?.length ? (
						<div className="note" style={{ marginTop: 16 }}>
							<strong>Worth a look before publishing.</strong> The renderer worked around {render.warnings.length === 1 ? "a problem" : "some problems"}:
							<ul style={{ margin: "6px 0 0", paddingLeft: 20 }}>
								{render.warnings.map((warning) => (
									<li key={warning}>{warning}</li>
								))}
							</ul>
						</div>
					) : null}
				</div>
				<aside className="cel pad">
					<dl className="details">
						<dt>Shape</dt>
						<dd className="num">{render.aspect}</dd>
						<dt>Frame</dt>
						<dd className="num">
							{render.width} × {render.height}
						</dd>
						<dt>Frame rate</dt>
						<dd className="num">{render.fps} fps</dd>
						{render.durationSec ? (
							<>
								<dt>Length</dt>
								<dd className="num">{clock(render.durationSec)}</dd>
							</>
						) : null}
						{render.bytes ? (
							<>
								<dt>File size</dt>
								<dd className="num">{sizeOf(render.bytes)}</dd>
							</>
						) : null}
						<dt>Started</dt>
						<dd className="num">{whenExactly(render.createdAt)}</dd>
						{render.finishedAt && (
							<>
								<dt>Finished</dt>
								<dd className="num">{whenExactly(render.finishedAt)}</dd>
							</>
						)}
						<dt>Export id</dt>
						<dd>
							<CopyId id={render.id} />
						</dd>
					</dl>
				</aside>
			</div>

			<div className="block">
				<div className="block-head">
					<div>
						<h2>On YouTube</h2>
						<p>
							{uploads.length
								? "Where this file has been published."
								: "Not published. Ask your agent to publish this export; uploads stay private unless you say otherwise."}
						</p>
					</div>
					{uploads.length === 0 && (
						<Link className="btn quiet" to="/connect" hash="youtube">
							Manage channels
						</Link>
					)}
				</div>
				{uploads.length > 0 && (
					<div className="lines">
						{uploads.map((upload) => (
							<UploadLine key={upload.id} upload={upload} />
						))}
					</div>
				)}
			</div>

			<HostingBlock renders={[render]} hosted={hosted} videoTitle={source.title} dialogs={hosting} />

			<DeleteRender open={deleting} onClose={() => setDeleting(false)} render={render} onDeleted={() => navigate({ to: "/projects/$projectId/videos/$videoId", params })} />
		</main>
	);
}
