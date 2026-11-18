import { Link, createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { op, plural, when } from "../../../api.ts";
import { DeleteProject, ProjectDialog } from "../../../forms.tsx";
import type { ProjectRow } from "../../../types.ts";
import { Empty, Menu } from "../../../ui.tsx";

export const Route = createFileRoute("/_app/projects/")({
	loader: () => op<{ projects: ProjectRow[] }>("project.list"),
	head: () => ({ meta: [{ title: "Projects · Retween" }] }),
	component: Projects,
});

function Projects() {
	const { projects } = Route.useLoaderData();
	const [creating, setCreating] = useState(false);
	const [editing, setEditing] = useState<ProjectRow | null>(null);
	const [deleting, setDeleting] = useState<ProjectRow | null>(null);
	return (
		<main className="page">
			<div className="head">
				<div className="words">
					<h1>Projects</h1>
					<p>One project per brand. Each keeps a brand kit, the files you hand over and the videos your agent makes from them.</p>
				</div>
				<div className="acts">
					<button type="button" className="btn" onClick={() => setCreating(true)}>
						New project
					</button>
				</div>
			</div>

			<div className="block">
				{projects.length === 0 ? (
					<Empty
						title="No projects yet"
						actions={
							<>
								<button type="button" className="btn" onClick={() => setCreating(true)}>
									New project
								</button>
								<Link className="btn quiet" to="/connect">
									Connect an agent
								</Link>
							</>
						}
					>
						Create one here, or connect an agent and ask it to set up a project and make a video.
					</Empty>
				) : (
					<div className="lines">
						{projects.map((project) => (
							<div className="line go" key={project.id}>
								<div className="grow">
									<Link className="cover title" to="/projects/$projectId" params={{ projectId: project.id }}>
										{project.name}
									</Link>
									{project.description && <div className="soft clip">{project.description}</div>}
								</div>
								<div className="facts">
									<span>{plural(project.videos, "video")}</span>
									<span>{plural(project.assets, "file")}</span>
									<span>Updated {when(project.updatedAt)}</span>
								</div>
								<div className="acts">
									<Menu label={`Actions for ${project.name}`}>
										<button type="button" onClick={() => setEditing(project)}>
											Edit name and description
										</button>
										<Link to="/projects/$projectId/settings" params={{ projectId: project.id }}>
											Settings
										</Link>
										<hr />
										<button type="button" className="danger" onClick={() => setDeleting(project)}>
											Delete project
										</button>
									</Menu>
								</div>
							</div>
						))}
					</div>
				)}
			</div>

			<ProjectDialog open={creating} onClose={() => setCreating(false)} />
			<ProjectDialog open={editing !== null} onClose={() => setEditing(null)} project={editing ?? undefined} />
			{deleting && <DeleteProject open onClose={() => setDeleting(null)} project={deleting} />}
		</main>
	);
}
