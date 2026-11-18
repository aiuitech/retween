import { Link, Outlet, createFileRoute, getRouteApi } from "@tanstack/react-router";
import { CopyId, Crumbs } from "../../../../../ui.tsx";

const project = getRouteApi("/_app/projects/$projectId");

/** The project's own pages share a heading and a row of tabs. */
export const Route = createFileRoute("/_app/projects/$projectId/_tabs")({ component: ProjectPages });

function ProjectPages() {
	const { project: current } = project.useLoaderData();
	const params = { projectId: current.id };
	const here = { "aria-current": "page" } as const;
	return (
		<main className="page">
			<Crumbs>
				<li>
					<Link to="/projects">Projects</Link>
				</li>
				<li aria-current="page">{current.name}</li>
			</Crumbs>
			<div className="head">
				<div className="words">
					<h1>{current.name}</h1>
					{current.description && <p>{current.description}</p>}
				</div>
				<div className="acts">
					<CopyId id={current.id} />
				</div>
			</div>
			<nav className="tabs" aria-label="Project">
				<Link to="/projects/$projectId" params={params} activeOptions={{ exact: true }} activeProps={here}>
					Videos<span className="count">{current.videos}</span>
				</Link>
				<Link to="/projects/$projectId/assets" params={params} activeProps={here}>
					Files<span className="count">{current.assets}</span>
				</Link>
				<Link to="/projects/$projectId/brief" params={params} activeProps={here}>
					Brief
				</Link>
				<Link to="/projects/$projectId/settings" params={params} activeProps={here}>
					Settings
				</Link>
			</nav>
			<Outlet />
		</main>
	);
}
