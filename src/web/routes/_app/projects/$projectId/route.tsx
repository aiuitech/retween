import { Outlet, createFileRoute } from "@tanstack/react-router";
import { op } from "../../../../api.ts";
import { orNotFound } from "../../../../forms.tsx";
import type { ProjectRow } from "../../../../types.ts";
import { Missing } from "../../../../ui.tsx";

/** Loads the project once for every page beneath it. */
export const Route = createFileRoute("/_app/projects/$projectId")({
	loader: ({ params }) => op<{ project: ProjectRow; brandKit: { filled: string[]; missing: string[] } }>("project.get", { projectId: params.projectId }).catch(orNotFound),
	head: ({ loaderData }) => ({ meta: [{ title: `${loaderData?.project.name ?? "Project"} · Retween` }] }),
	notFoundComponent: () => <Missing what="project" />,
	component: Outlet,
});
