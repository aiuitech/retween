import { createFileRoute, getRouteApi } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { op, when } from "../../../../../api.ts";
import { NOTE_KINDS, type NoteRow } from "../../../../../types.ts";
import { Confirm, Dialog, Empty, Field, Menu, Prose, useAct } from "../../../../../ui.tsx";

const project = getRouteApi("/_app/projects/$projectId");

export const Route = createFileRoute("/_app/projects/$projectId/_tabs/brief")({
	loader: async ({ params }) => {
		const [brief, notes] = await Promise.all([
			op<{ brief: string }>("project.brief", { projectId: params.projectId }),
			op<{ notes: NoteRow[] }>("note.list", { projectId: params.projectId }),
		]);
		return { brief: brief.brief, notes: notes.notes };
	},
	component: Brief,
});

const KIND_NAMES: Record<NoteRow["kind"], string> = {
	instruction: "Instruction",
	guideline: "Guideline",
	learning: "Learning",
	reference: "Reference",
	script: "Script",
	idea: "Idea",
};

function Brief() {
	const { brief, notes } = Route.useLoaderData();
	const { project: current, brandKit } = project.useLoaderData();
	const { busy, act } = useAct();
	const [editing, setEditing] = useState<NoteRow | "new" | null>(null);
	const [deleting, setDeleting] = useState<NoteRow | null>(null);
	const save = (note: NoteRow, change: Partial<NoteRow>, done: string) =>
		act(() => op("note.save", { projectId: current.id, noteId: note.id, kind: note.kind, title: note.title, body: note.body, pinned: note.pinned, ...change }), done);
	return (
		<>
			<div className="block-head">
				<div>
					<h2>Notes</h2>
					<p>Things worth remembering that do not fit the brand kit: house rules, what worked last time, source material. Pinned notes are part of the brief.</p>
				</div>
				<button type="button" className="btn quiet" onClick={() => setEditing("new")}>
					Add note
				</button>
			</div>
			{notes.length === 0 ? (
				<Empty title="No notes yet">Add one here, or tell your agent a preference and it will write it down.</Empty>
			) : (
				<div className="lines">
					{notes.map((note) => (
						<div className="line memo" key={note.id} style={{ alignItems: "flex-start" }}>
							<div className="grow">
								<div className="title">{note.title}</div>
								<div className="facts">
									<span>{KIND_NAMES[note.kind] ?? note.kind}</span>
									<span>{note.pinned ? "Pinned to the brief" : "Not in the brief"}</span>
									<span>Updated {when(note.updatedAt)}</span>
								</div>
								<div className="body">{note.body.length > 420 ? `${note.body.slice(0, 420).trimEnd()}…` : note.body}</div>
							</div>
							<div className="acts">
								<Menu label={`Actions for ${note.title}`}>
									<button type="button" onClick={() => setEditing(note)}>
										Edit note
									</button>
									<button type="button" disabled={busy} onClick={() => void save(note, { pinned: !note.pinned }, note.pinned ? "Unpinned note" : "Pinned note")}>
										{note.pinned ? "Unpin from the brief" : "Pin to the brief"}
									</button>
									<hr />
									<button type="button" className="danger" onClick={() => setDeleting(note)}>
										Delete note
									</button>
								</Menu>
							</div>
						</div>
					))}
				</div>
			)}

			<div className="block">
				<div className="block-head">
					<div>
						<h2>The brief your agent reads</h2>
						<p>
							Put together from the brand kit, pinned notes and reusable files. To change the brand kit, tell your agent what you want; it keeps this up to date.
							{brandKit.missing.length > 0 && ` Still empty: ${brandKit.missing.join(", ")}.`}
						</p>
					</div>
				</div>
				<div className="cel pad">
					<Prose text={brief} />
				</div>
			</div>

			<NoteDialog projectId={current.id} note={editing} onClose={() => setEditing(null)} />
			{deleting && (
				<Confirm
					open
					onClose={() => setDeleting(null)}
					title="Delete this note?"
					action="Delete note"
					busy={busy}
					onConfirm={async () => {
						if (await act(() => op("note.delete", { projectId: current.id, noteId: deleting.id }), "Deleted note")) setDeleting(null);
					}}
				>
					“{deleting.title}” will be removed from the project and from the brief. This cannot be undone.
				</Confirm>
			)}
		</>
	);
}

function NoteDialog({ projectId, note, onClose }: { projectId: string; note: NoteRow | "new" | null; onClose: () => void }) {
	const existing = note && note !== "new" ? note : undefined;
	const { busy, act } = useAct();
	const [kind, setKind] = useState<NoteRow["kind"]>("guideline");
	const [title, setTitle] = useState("");
	const [body, setBody] = useState("");
	const [pinned, setPinned] = useState(true);
	useEffect(() => {
		if (!note) return;
		setKind(existing?.kind ?? "guideline");
		setTitle(existing?.title ?? "");
		setBody(existing?.body ?? "");
		setPinned(existing?.pinned ?? true);
	}, [note, existing]);
	return (
		<Dialog open={note !== null} onClose={onClose} title={existing ? "Edit note" : "Add note"}>
			<form
				className="fields"
				onSubmit={async (event) => {
					event.preventDefault();
					const saved = await act(() => op("note.save", { projectId, noteId: existing?.id, kind, title: title.trim(), body: body.trim(), pinned }), existing ? "Saved changes" : "Added note");
					if (saved) onClose();
				}}
			>
				<Field label="Title">
					<input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={200} required autoFocus />
				</Field>
				<Field label="Kind">
					<select value={kind} onChange={(event) => setKind(event.target.value as NoteRow["kind"])}>
						{NOTE_KINDS.map((value) => (
							<option key={value} value={value}>
								{KIND_NAMES[value]}
							</option>
						))}
					</select>
				</Field>
				<Field label="Note">
					<textarea value={body} onChange={(event) => setBody(event.target.value)} maxLength={20000} rows={7} required />
				</Field>
				<label className="check">
					<input type="checkbox" checked={pinned} onChange={(event) => setPinned(event.target.checked)} />
					Pin to the brief, so it is read before every video
				</label>
				<div className="sheet-foot">
					<button type="button" className="btn quiet" onClick={onClose}>
						Cancel
					</button>
					<button type="submit" className="btn" disabled={busy || !title.trim() || !body.trim()}>
						{existing ? "Save changes" : "Add note"}
					</button>
				</div>
			</form>
		</Dialog>
	);
}
