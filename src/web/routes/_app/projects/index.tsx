import { Link, createFileRoute, getRouteApi } from "@tanstack/react-router";
import { useState } from "react";
import { op, plural, when } from "../../../api.ts";
import { DeleteProject, ProjectDialog } from "../../../forms.tsx";
import type { ProjectRow } from "../../../types.ts";
import { Empty, Menu } from "../../../ui.tsx";

const app = getRouteApi("/_app");

export const Route = createFileRoute("/_app/projects/")({
	loader: () => op<{ projects: ProjectRow[] }>("project.list"),
	head: () => ({ meta: [{ title: "Projects · Retween" }] }),
	component: Projects,
});

const ROLE_NAMES = { owner: "Owner", editor: "Editor", viewer: "Viewer" } as const;

function Projects() {
	const { projects } = Route.useLoaderData();
	const { me } = app.useRouteContext();
	const [creating, setCreating] = useState(false);
	const [editing, setEditing] = useState<ProjectRow | null>(null);
	const [deleting, setDeleting] = useState<ProjectRow | null>(null);
	const own = projects.filter((project) => project.role === "owner" && !project.owner);
	const shared = projects.filter((project) => project.role !== "owner" || project.owner);
	const guest = me.billing === "guest";
	return (
		<main className="page">
			<div className="head">
				<div className="words">
					<h1>Projects</h1>
					<p>One project per brand. Each keeps a brand kit, the files you hand over and the videos your agent makes from them.</p>
				</div>
				<div className="acts">
					{guest ? (
						<Link className="btn" to="/billing">
							New project
						</Link>
					) : (
						<button type="button" className="btn" onClick={() => setCreating(true)}>
							New project
						</button>
					)}
				</div>
			</div>

			{(own.length > 0 || shared.length === 0) && (
				<div className="block">
					{shared.length > 0 && <h2 style={{ marginBottom: 12 }}>Yours</h2>}
					{own.length === 0 ? (
						<Empty
							title="No projects yet"
							actions={
								<>
									{guest ? (
										<Link className="btn" to="/billing">
											New project
										</Link>
									) : (
										<button type="button" className="btn" onClick={() => setCreating(true)}>
											New project
										</button>
									)}
									<Link className="btn quiet" to="/connect">
										Connect an agent
									</Link>
								</>
							}
						>
							Create one here, or connect an agent and ask it to set up a project and make a video.
						</Empty>
					) : (
						<ProjectLines projects={own} onEdit={setEditing} onDelete={setDeleting} />
					)}
				</div>
			)}

			{shared.length > 0 && (
				<div className="block">
					<h2 style={{ marginBottom: 12 }}>Shared with you</h2>
					<ProjectLines projects={shared} onEdit={setEditing} onDelete={setDeleting} />
				</div>
			)}

			<ProjectDialog open={creating} onClose={() => setCreating(false)} />
			<ProjectDialog open={editing !== null} onClose={() => setEditing(null)} project={editing ?? undefined} />
			{deleting && <DeleteProject open onClose={() => setDeleting(null)} project={deleting} />}
		</main>
	);
}

function ProjectLines({ projects, onEdit, onDelete }: { projects: ProjectRow[]; onEdit: (project: ProjectRow) => void; onDelete: (project: ProjectRow) => void }) {
	return (
		<div className="lines">
			{projects.map((project) => (
				<div className="line go" key={project.id}>
					<div className="grow">
						<Link className="cover title" to="/projects/$projectId" params={{ projectId: project.id }}>
							{project.name}
						</Link>
						{project.description && <div className="soft clip">{project.description}</div>}
						{project.owner && <div className="soft clip">Shared by {project.owner.name || project.owner.email}</div>}
					</div>
					<div className="facts">
						{project.owner && <span className="tag">{ROLE_NAMES[project.role]}</span>}
						<span>{plural(project.videos, "video")}</span>
						<span>{plural(project.assets, "file")}</span>
						<span>Updated {when(project.updatedAt)}</span>
					</div>
					<div className="acts">
						<Menu label={`Actions for ${project.name}`}>
							{project.role !== "viewer" && (
								<button type="button" onClick={() => onEdit(project)}>
									Edit name and description
								</button>
							)}
							<Link to="/projects/$projectId/sharing" params={{ projectId: project.id }}>
								Sharing
							</Link>
							<Link to="/projects/$projectId/settings" params={{ projectId: project.id }}>
								Settings
							</Link>
							{project.role === "owner" && (
								<>
									<hr />
									<button type="button" className="danger" onClick={() => onDelete(project)}>
										Delete project
									</button>
								</>
							)}
						</Menu>
					</div>
				</div>
			))}
		</div>
	);
}
