import { Link, createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { clock, op, plural, usd, when } from "../../../../../api.ts";
import { DeleteVideo, VideoDialog } from "../../../../../forms.tsx";
import type { VideoRow } from "../../../../../types.ts";
import { Empty, Menu, StatusOf, isRunning, usePoll } from "../../../../../ui.tsx";

export const Route = createFileRoute("/_app/projects/$projectId/_tabs/")({
	loader: ({ params }) => op<{ videos: VideoRow[] }>("video.list", { projectId: params.projectId }),
	component: Videos,
});

function Videos() {
	const { videos } = Route.useLoaderData();
	const { projectId } = Route.useParams();
	const [creating, setCreating] = useState(false);
	const [editing, setEditing] = useState<VideoRow | null>(null);
	const [deleting, setDeleting] = useState<VideoRow | null>(null);
	usePoll(videos.some((video) => isRunning(video.status)));
	return (
		<>
			<div className="block-head">
				<h2>Videos</h2>
				<button type="button" className="btn quiet" onClick={() => setCreating(true)}>
					New video
				</button>
			</div>
			{videos.length === 0 ? (
				<Empty
					title="No videos in this project"
					actions={
						<button type="button" className="btn" onClick={() => setCreating(true)}>
							New video
						</button>
					}
				>
					Ask your agent for one (“make a 30-second launch video for this project”), or start an empty one here and have the agent fill it in.
				</Empty>
			) : (
				<div className="lines">
					{videos.map((video) => (
						<div className="line go" key={video.id}>
							<div className="grow">
								<Link className="cover title" to="/projects/$projectId/videos/$videoId" params={{ projectId, videoId: video.id }}>
									{video.title}
								</Link>
								<div className="facts">
									<span>{video.aspect}</span>
									<span>{plural(video.scenes, "scene")}</span>
									{video.durationSec ? <span>{clock(video.durationSec)}</span> : null}
									{video.chargeUsd ? <span className="num">{usd(video.chargeUsd)} spent</span> : null}
									<span>Updated {when(video.updatedAt)}</span>
								</div>
							</div>
							<StatusOf status={video.status} />
							<div className="acts">
								<Menu label={`Actions for ${video.title}`}>
									<button type="button" onClick={() => setEditing(video)}>
										Edit title and brief
									</button>
									<hr />
									<button type="button" className="danger" onClick={() => setDeleting(video)}>
										Delete video
									</button>
								</Menu>
							</div>
						</div>
					))}
				</div>
			)}
			<VideoDialog open={creating} onClose={() => setCreating(false)} projectId={projectId} />
			<VideoDialog open={editing !== null} onClose={() => setEditing(null)} projectId={projectId} video={editing ?? undefined} />
			{deleting && <DeleteVideo open onClose={() => setDeleting(null)} video={deleting} />}
		</>
	);
}
