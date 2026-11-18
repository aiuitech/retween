import { Outlet, createFileRoute, notFound } from "@tanstack/react-router";
import { op } from "../../../../../../api.ts";
import { orNotFound } from "../../../../../../forms.tsx";
import type { VideoDetail } from "../../../../../../types.ts";
import { Missing } from "../../../../../../ui.tsx";

/** Loads the video once for its own page and for each of its exports. */
export const Route = createFileRoute("/_app/projects/$projectId/videos/$videoId")({
	loader: async ({ params }) => {
		const { video } = await op<{ video: VideoDetail }>("video.get", { videoId: params.videoId, storyboard: true, media: "full", timing: true }).catch(orNotFound);
		// A video is only ever shown under the project it belongs to.
		if (video.projectId !== params.projectId) throw notFound();
		return { video };
	},
	head: ({ loaderData }) => ({ meta: [{ title: `${loaderData?.video.title ?? "Video"} · Retween` }] }),
	notFoundComponent: () => <Missing what="video" />,
	component: Outlet,
});
