import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { type InvitePage, acceptInvite, loadInvite } from "../invite.ts";
import { Slate } from "../public.tsx";
import { forgetMe, signIn, signOut } from "../session.ts";

export const Route = createFileRoute("/invite/$inviteId")({
	validateSearch: (search: Record<string, unknown>) => ({ t: typeof search.t === "string" ? search.t : undefined }),
	loaderDeps: ({ search }) => ({ t: search.t }),
	loader: ({ params, deps }) => loadInvite({ data: { inviteId: params.inviteId, token: deps.t } }),
	head: () => ({ meta: [{ title: "Invitation · Retween" }, { name: "robots", content: "noindex" }] }),
	component: Invite,
});

const ROLE_WORDS = { editor: "an editor", viewer: "a viewer" } as const;

function Invite() {
	const reply = Route.useLoaderData();
	const { inviteId } = Route.useParams();
	const { t } = Route.useSearch();
	const navigate = useNavigate();
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState<string>();

	if (!reply.ok) {
		return (
			<Slate kind="Invitation" title="This link does not work.">
				<p>{reply.message}</p>
				<div className="choices">
					<Link className="btn quiet" to="/">
						Go to Retween
					</Link>
				</div>
			</Slate>
		);
	}
	const invite: InvitePage = reply.value;
	const here = `/invite/${inviteId}${t ? `?t=${encodeURIComponent(t)}` : ""}`;
	const open = (projectId: string) => {
		forgetMe();
		void navigate({ to: "/projects/$projectId", params: { projectId } });
	};

	if (invite.state === "yours" && invite.projectId) {
		const projectId = invite.projectId;
		return (
			<Slate kind="Invitation" title={`You have access to ${invite.projectName}.`}>
				<p>You accepted this invitation and are {ROLE_WORDS[invite.role]}.</p>
				<div className="choices">
					<button type="button" className="btn" onClick={() => open(projectId)}>
						Open the project
					</button>
				</div>
			</Slate>
		);
	}
	if (invite.state !== "open") {
		return (
			<Slate kind="Invitation" title={invite.state === "expired" ? "This invitation has expired." : "This invitation has been used."}>
				<p>
					{invite.state === "expired"
						? `Ask ${invite.from} to share ${invite.projectName} with you again.`
						: `It was accepted by its recipient. If that was you, sign in as ${invite.email}.`}
				</p>
				<div className="choices">
					<Link className="btn quiet" to="/projects">
						Your projects
					</Link>
				</div>
			</Slate>
		);
	}

	const mismatch = invite.signedInAs && invite.signedInAs.toLowerCase() !== invite.email;
	return (
		<Slate kind="Invitation" title={`${invite.from} invited you to ${invite.projectName}.`}>
			<p>
				You will be {ROLE_WORDS[invite.role]} of the project on Retween, a video studio that agents operate.{" "}
				{invite.role === "editor"
					? "You can change its brand kit, storyboards and files, and make and export videos; what you generate is billed to you."
					: "You can see its brand kit, storyboards, files and exports, and run checks and previews."}
			</p>
			{mismatch && (
				<p className="note bad">
					This invitation is for {invite.email}, and you are signed in as {invite.signedInAs}. Sign out and sign in with {invite.email}, or ask {invite.from} to
					invite this address.
				</p>
			)}
			{problem && <p className="note bad">{problem}</p>}
			<div className="choices">
				{!invite.signedInAs ? (
					<button type="button" className="btn" onClick={() => signIn(here)}>
						Sign in with Google as {invite.email}
					</button>
				) : mismatch ? (
					<button type="button" className="btn quiet" onClick={() => void signOut()}>
						Sign out
					</button>
				) : (
					<button
						type="button"
						className="btn"
						disabled={busy}
						onClick={async () => {
							setBusy(true);
							const result = await acceptInvite({ data: { inviteId, token: t } });
							setBusy(false);
							if (result.ok) open(result.value.projectId);
							else setProblem(result.message);
						}}
					>
						Accept and open the project
					</button>
				)}
			</div>
		</Slate>
	);
}
