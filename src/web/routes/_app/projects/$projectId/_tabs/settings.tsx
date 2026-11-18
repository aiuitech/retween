import { createFileRoute, getRouteApi, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { op, plural, when } from "../../../../../api.ts";
import { DeleteProject } from "../../../../../forms.tsx";
import { CopyId, Field, useAct } from "../../../../../ui.tsx";

const project = getRouteApi("/_app/projects/$projectId");

export const Route = createFileRoute("/_app/projects/$projectId/_tabs/settings")({ component: Settings });

function Settings() {
	const { project: current } = project.useLoaderData();
	const navigate = useNavigate();
	const { busy, act } = useAct();
	const [name, setName] = useState(current.name);
	const [description, setDescription] = useState(current.description ?? "");
	const [deleting, setDeleting] = useState(false);
	const changed = name.trim() !== current.name || description !== (current.description ?? "");
	return (
		<div className="page narrow" style={{ padding: 0, margin: 0 }}>
			<h2>Settings</h2>
			<form
				className="cel pad fields"
				style={{ marginTop: 12 }}
				onSubmit={(event) => {
					event.preventDefault();
					void act(() => op("project.update", { projectId: current.id, name: name.trim(), description }), "Saved changes");
				}}
			>
				<Field label="Name">
					<input value={name} onChange={(event) => setName(event.target.value)} maxLength={120} required />
				</Field>
				<Field label="What it is for" hint="A line your agent reads before making anything in this project.">
					<textarea value={description} onChange={(event) => setDescription(event.target.value)} maxLength={2000} />
				</Field>
				<div>
					<button type="submit" className="btn" disabled={busy || !changed || !name.trim()}>
						Save changes
					</button>
				</div>
			</form>

			<div className="block">
				<h2>About</h2>
				<div className="cel pad" style={{ marginTop: 12 }}>
					<dl className="details">
						<dt>Project id</dt>
						<dd>
							<CopyId id={current.id} />
						</dd>
						<dt>Created</dt>
						<dd>{when(current.createdAt)}</dd>
						<dt>Holds</dt>
						<dd>
							{plural(current.videos, "video")} and {plural(current.assets, "file")}
						</dd>
					</dl>
				</div>
			</div>

			<div className="block">
				<h2>Delete project</h2>
				<div className="cel pad danger-zone" style={{ marginTop: 12, display: "flex", gap: 20, alignItems: "center", flexWrap: "wrap" }}>
					<p className="soft" style={{ flex: "1 1 320px" }}>
						Deletes the brand kit, every file and every video in this project, including exports. This cannot be undone.
					</p>
					<button type="button" className="btn danger" onClick={() => setDeleting(true)}>
						Delete project
					</button>
				</div>
			</div>
			<DeleteProject open={deleting} onClose={() => setDeleting(false)} project={current} onDeleted={() => navigate({ to: "/projects" })} />
		</div>
	);
}
