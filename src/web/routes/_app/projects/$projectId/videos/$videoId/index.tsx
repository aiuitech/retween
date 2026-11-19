import { Link, createFileRoute, getRouteApi, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { clock, op, plural, sizeOf, usd, when } from "../../../../../../api.ts";
import { DraftBlock, useDraft } from "../../../../../../draft.tsx";
import { DeleteRender, DeleteVideo, ExportDialog, UploadLine, VideoDialog } from "../../../../../../forms.tsx";
import { HostingBlock, useHostingDialogs } from "../../../../../../hosting.tsx";
import type { HostedVideo, RenderRow, ReviewRow, ThumbnailInfo, VideoDetail, YoutubeUpload } from "../../../../../../types.ts";
import { Storyboard } from "../../../../../../storyboard.tsx";
import { CopyId, Crumbs, Empty, Menu, Status, StatusOf, Tween, isRunning, useAct, usePoll } from "../../../../../../ui.tsx";

const project = getRouteApi("/_app/projects/$projectId");
const video = getRouteApi("/_app/projects/$projectId/videos/$videoId");

export const Route = createFileRoute("/_app/projects/$projectId/videos/$videoId/")({
	loader: async ({ params }) => {
		const [renders, uploads, reviews, thumbnail, hosting] = await Promise.all([
			op<{ renders: RenderRow[] }>("render.list", { videoId: params.videoId }),
			op<{ uploads: YoutubeUpload[] }>("youtube.list", { videoId: params.videoId }).catch(() => ({ uploads: [] })),
			op<{ reviews: ReviewRow[] }>("review.list", { videoId: params.videoId }).catch(() => ({ reviews: [] })),
			op<ThumbnailInfo>("thumbnail.get", { videoId: params.videoId }).catch(() => ({ thumbnail: null, poster: null })),
			op<{ hosted: HostedVideo[] }>("hosting.list", { videoId: params.videoId }).catch(() => ({ hosted: [] })),
		]);
		return { renders: renders.renders, uploads: uploads.uploads, reviews: reviews.reviews, thumbnail, hosted: hosting.hosted };
	},
	component: VideoPage,
});

function VideoPage() {
	const { project: parent } = project.useLoaderData();
	const { video: current } = video.useLoaderData();
	const { renders, uploads, reviews, thumbnail, hosted } = Route.useLoaderData();
	const hosting = useHostingDialogs();
	const navigate = useNavigate();
	const { busy, act } = useAct();
	const [dialog, setDialog] = useState<"edit" | "delete" | "export" | null>(null);
	const [removing, setRemoving] = useState<RenderRow | null>(null);
	const params = { projectId: parent.id, videoId: current.id };
	const preparing = current.status === "preparing";
	usePoll(preparing || [...renders, ...uploads, ...hosted].some((item) => isRunning(item.status)));

	const draft = useDraft(current);
	const canCut = parent.role !== "viewer";
	const watchDraft = () => {
		document.getElementById("draft")?.scrollIntoView({ behavior: "smooth", block: "start" });
		// Only cut when there is nothing current to watch; otherwise just show it.
		if (!draft.needsRange && (!draft.kept || draft.stale || draft.status === "failed")) void draft.cut();
	};

	const { pipeline } = current;
	const scenes = current.storyboard.scenes;
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
				<li aria-current="page">{current.title}</li>
			</Crumbs>
			<div className="head">
				<div className="words">
					<h1>{current.title}</h1>
					<div className="facts">
						<StatusOf status={current.status} />
						<span>{current.aspect}</span>
						<span>{plural(scenes.length, "scene")}</span>
						{current.timeline && <span>{clock(current.timeline.durationSec)}</span>}
						{current.spend.chargeUsd > 0 && <span className="num">{usd(current.spend.chargeUsd)} spent</span>}
						<span>Updated {when(current.updatedAt)}</span>
					</div>
					{current.brief && <p>{current.brief}</p>}
				</div>
				<div className="acts">
					{canCut && (
						<button
							type="button"
							className="btn quiet"
							disabled={preparing || scenes.length === 0 || draft.starting || draft.status === "rendering" || draft.status === "loading"}
							onClick={watchDraft}
						>
							Watch draft
						</button>
					)}
					<button type="button" className="btn" disabled={preparing || scenes.length === 0} onClick={() => setDialog("export")}>
						Export video
					</button>
					<Menu label="More actions for this video">
						<button type="button" onClick={() => setDialog("edit")}>
							Edit title and brief
						</button>
						<hr />
						<button type="button" className="danger" onClick={() => setDialog("delete")}>
							Delete video
						</button>
					</Menu>
				</div>
			</div>

			{preparing && (
				<div className="note info" style={{ marginTop: 22 }}>
					<div className="progress">
						<span>{pipeline.message ?? "Generating narration and pictures"}</span>
						<Tween value={pipeline.total ? (pipeline.completed ?? 0) / pipeline.total : undefined} label="Preparing the video" />
						{pipeline.total ? (
							<span className="num">
								{pipeline.completed ?? 0} of {pipeline.total}
							</span>
						) : null}
					</div>
				</div>
			)}
			{current.status === "failed" && pipeline.error && (
				<p className="note bad" style={{ marginTop: 22 }}>
					Preparing stopped: {pipeline.error} Ask your agent to fix the scene and prepare again; scenes that already worked are not redone.
				</p>
			)}
			{!preparing && scenes.length > 0 && (current.status === "draft" || current.timeline?.stale) && (
				<p className="note" style={{ marginTop: 22 }}>
					{current.timeline
						? "The storyboard or brand changed after this video was last prepared, so the timings below are partly estimates. Prepare it again to hear and see the changes."
						: "This video has not been prepared yet. Preparing it records the narration, makes the pictures and times every scene."}
				</p>
			)}

			{scenes.length > 0 && <DraftBlock video={current} draft={draft} canCut={canCut} blocked={preparing} />}

			<div className="block">
				<div className="block-head">
					<div>
						<h2>Storyboard</h2>
						<p>Written by your agent, and yours to change here too. Each scene lasts as long as its narration takes to say.</p>
					</div>
					<CopyId id={current.id} />
				</div>
				<Storyboard video={current} />
			</div>

			<div className="block">
				<div className="block-head">
					<div>
						<h2>Exports</h2>
						<p>Finished files, one per shape and size. Links to a file last a day; open the export again for a fresh one.</p>
					</div>
				</div>
				{renders.length === 0 ? (
					<Empty
						title="Not exported yet"
						actions={
							scenes.length > 0 && !preparing ? (
								<button type="button" className="btn" onClick={() => setDialog("export")}>
									Export video
								</button>
							) : undefined
						}
					>
						{current.status === "ready" ? "The video is prepared. Export it in any shape, up to 4K." : "Once the video is prepared, it can be exported in any shape, up to 4K."}
					</Empty>
				) : (
					<div className="lines">
						{renders.map((render) => (
							<div className="line go" key={render.id}>
								<div className="grow">
									<Link className="cover title num" to="/projects/$projectId/videos/$videoId/renders/$renderId" params={{ ...params, renderId: render.id }}>
										{render.aspect} at {render.resolution}
									</Link>
									<div className="facts">
										<span>{when(render.createdAt)}</span>
										{render.durationSec ? <span>{clock(render.durationSec)}</span> : null}
										{render.bytes ? <span>{sizeOf(render.bytes)}</span> : null}
										{render.warnings?.length ? <Status tone="warn">{plural(render.warnings.length, "warning")}</Status> : null}
										{render.error && <span style={{ color: "var(--red)" }}>{render.error}</span>}
										{hosted.some((copy) => copy.renderId === render.id && copy.status === "ready") && <Status tone="ok">On the web</Status>}
									</div>
								</div>
								{render.status === "rendering" ? (
									<div className="progress" style={{ width: 200 }}>
										<Tween value={render.progress / 100} label={`Rendering ${render.aspect} ${render.resolution}`} />
										<span className="pct">{render.progress}%</span>
									</div>
								) : (
									<StatusOf status={render.status} />
								)}
								<div className="acts">
									{render.downloadUrl && (
										<a className="btn quiet small" href={render.downloadUrl}>
											Download
										</a>
									)}
									<Menu label={`Actions for the ${render.aspect} ${render.resolution} export`}>
										{render.status === "done" &&
											(() => {
												const live = hosted.find((copy) => copy.renderId === render.id && copy.status !== "failed");
												return live ? (
													<button type="button" onClick={() => hosting.setShareId(live.id)}>
														Share or embed
													</button>
												) : (
													<button type="button" onClick={() => hosting.setHostFor(render.id)}>
														Host on the web
													</button>
												);
											})()}
										{isRunning(render.status) && (
											<button type="button" disabled={busy} onClick={() => void act(() => op("render.cancel", { renderId: render.id }), "Cancelled export")}>
												Cancel export
											</button>
										)}
										<button type="button" className="danger" onClick={() => setRemoving(render)}>
											Delete export
										</button>
									</Menu>
								</div>
							</div>
						))}
					</div>
				)}
			</div>

			{(renders.some((render) => render.status === "done") || hosted.length > 0) && <HostingBlock renders={renders} hosted={hosted} videoTitle={current.title} dialogs={hosting} />}

			<div className="block">
				<div className="block-head">
					<div>
						<h2>Thumbnail and reviews</h2>
						<p>The thumbnail goes up with the video and is its poster. Reviews are rounds of notes from the person (or anyone with the link) on a cut, which your agent reads and answers.</p>
					</div>
				</div>
				<div className="with-aside thumb-reviews">
					{reviews.length === 0 ? (
						<Empty title="No reviews yet">When the video is ready to look at, your agent sends a link where you watch it and leave notes on moments or scenes.</Empty>
					) : (
						<div className="lines">
							{reviews.map((review) => (
								<div className="line go" key={review.reviewId}>
									<div className="grow">
										<a className="cover title" href={review.reviewUrl ?? `/review/${review.reviewId}`}>
											Round {review.round}
										</a>
										<div className="facts">
											<span>{plural(review.comments, "note")}</span>
											{review.reviewer && <span>from {review.reviewer}</span>}
											{review.submittedAt && <span>{when(review.submittedAt)}</span>}
											{review.summary && <span>{review.summary.length > 80 ? `${review.summary.slice(0, 78)}…` : review.summary}</span>}
										</div>
									</div>
									{review.status === "submitted" ? (
										<Status tone={review.verdict === "approved" ? "ok" : "warn"}>{review.verdict === "approved" ? "Approved" : "Changes asked"}</Status>
									) : review.status === "open" ? (
										<Status tone="busy">Waiting for notes</Status>
									) : (
										<Status>{review.status === "expired" ? "Expired" : "Replaced"}</Status>
									)}
								</div>
							))}
						</div>
					)}
					<div className="cel thumb-card">
						{thumbnail.thumbnail?.url ? (
							<img src={thumbnail.thumbnail.url} alt={thumbnail.thumbnail.description ? `Thumbnail: ${thumbnail.thumbnail.description}` : "The video's thumbnail"} />
						) : thumbnail.poster ? (
							<img src={thumbnail.poster.url} alt="The opening of the latest export, used as the poster" />
						) : (
							<div className="thumb-none">No thumbnail yet</div>
						)}
						<p className="soft">
							{thumbnail.thumbnail ? "Designed with thumbnail.design." : thumbnail.poster ? "No thumbnail yet: the opening of the latest export stands in. Ask your agent to design one." : "Ask your agent to design one (thumbnail.design)."}
						</p>
					</div>
				</div>
			</div>

			{current.spend.byKind.length > 0 && (
				<div className="block">
					<div className="block-head">
						<div>
							<h2>Spending</h2>
							<p>
								What this video has cost so far, as billed: everything generated for it (including versions it replaced) and its exports. Previews, drafts and
								storage are charged to the account.
							</p>
						</div>
						<Link className="btn quiet small" to="/account/spending">
							All spending
						</Link>
					</div>
					<div className="lines">
						{current.spend.byKind.map((line) => (
							<div className="line" key={line.kind}>
								<div className="grow">
									<div className="title">{line.label}</div>
								</div>
								<span className="num">{usd(line.chargeUsd)}</span>
							</div>
						))}
						<div className="line">
							<div className="grow">
								<strong>Total</strong>
							</div>
							<strong className="num">{usd(current.spend.chargeUsd)}</strong>
						</div>
					</div>
				</div>
			)}

			{uploads.length > 0 && (
				<div className="block">
					<div className="block-head">
						<h2>On YouTube</h2>
					</div>
					<div className="lines">
						{uploads.map((upload) => (
							<UploadLine key={upload.id} upload={upload} />
						))}
					</div>
				</div>
			)}

			<VideoDialog open={dialog === "edit"} onClose={() => setDialog(null)} projectId={parent.id} video={current} />
			<ExportDialog open={dialog === "export"} onClose={() => setDialog(null)} video={current} />
			<DeleteVideo open={dialog === "delete"} onClose={() => setDialog(null)} video={current} onDeleted={() => navigate({ to: "/projects/$projectId", params })} />
			{removing && <DeleteRender open onClose={() => setRemoving(null)} render={removing} />}
		</main>
	);
}
