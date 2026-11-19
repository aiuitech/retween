import { createFileRoute, getRouteApi, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { op, when } from "../../../../../api.ts";
import { forgetMe } from "../../../../../session.ts";
import type { ProjectAccess } from "../../../../../types.ts";
import { Avatar, Confirm, Field, Snippet, useAct, useToast } from "../../../../../ui.tsx";

const project = getRouteApi("/_app/projects/$projectId");
const app = getRouteApi("/_app");

export const Route = createFileRoute("/_app/projects/$projectId/_tabs/sharing")({
	loader: ({ params }) => op<ProjectAccess>("project.members", { projectId: params.projectId }),
	component: Sharing,
});

const ROLES = {
	editor: { name: "Editor", about: "Changes the brand kit, storyboards and files, and makes, exports and publishes videos." },
	viewer: { name: "Viewer", about: "Sees everything and runs checks and previews, but changes nothing." },
} as const;
type Role = keyof typeof ROLES;

type Removing = { kind: "member"; userId: string; label: string } | { kind: "invite"; inviteId: string; label: string } | { kind: "leave" };

function Sharing() {
	const { project: current } = project.useLoaderData();
	const { me } = app.useRouteContext();
	const access = Route.useLoaderData();
	const navigate = useNavigate();
	const toast = useToast();
	const { busy, act } = useAct();
	const [email, setEmail] = useState("");
	const [role, setRole] = useState<Role>("editor");
	const [lastInvite, setLastInvite] = useState<{ email: string; link: string; emailed: boolean } | null>(null);
	const [removing, setRemoving] = useState<Removing | null>(null);
	const owner = access.you === "owner";

	const share = (address: string, as: Role, done?: string) =>
		act(async () => {
			const result = await op<{ status: string; emailed?: boolean; invite?: { email: string; link: string } }>("project.share", {
				projectId: current.id,
				email: address,
				role: as,
			});
			if (result.status === "invited" && result.invite) {
				setLastInvite({ email: result.invite.email, link: result.invite.link, emailed: Boolean(result.emailed) });
				if (!result.emailed) toast("The invitation email could not be sent. Copy the link and send it yourself.", true);
			}
			if (result.status === "unchanged") toast(`${address} already has that role`);
		}, done);

	return (
		<div className="page narrow" style={{ padding: 0, margin: 0 }}>
			<h2>Who has access</h2>
			<p className="soft" style={{ marginTop: 6 }}>
				Everyone here can open the project in the web app and through their own agent. Paid work (narration, pictures, exports) is billed to whoever starts it;
				storage stays with the owner.
			</p>

			{owner && (
				<form
					className="cel pad fields"
					style={{ marginTop: 12 }}
					onSubmit={async (event) => {
						event.preventDefault();
						const address = email.trim();
						if (await share(address, role, `Shared with ${address}`)) setEmail("");
					}}
				>
					<div className="share-form">
						<div className="field-email">
							<Field label="Email address" hint="The Google account they sign in with. Anyone without an account gets an invitation.">
								<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@example.com" required />
							</Field>
						</div>
						<Field label="Role">
							<select value={role} onChange={(event) => setRole(event.target.value as Role)}>
								<option value="editor">Editor</option>
								<option value="viewer">Viewer</option>
							</select>
						</Field>
						<div style={{ paddingBottom: 2 }}>
							<button type="submit" className="btn" disabled={busy || !email.trim()}>
								Share
							</button>
						</div>
					</div>
					<p className="soft" style={{ margin: 0 }}>
						{ROLES[role].about}
					</p>
					{lastInvite && (
						<div>
							<p style={{ margin: "0 0 6px" }}>
								{lastInvite.emailed ? `Invitation sent to ${lastInvite.email}. You can also pass on the link:` : `Send ${lastInvite.email} this link:`}
							</p>
							<Snippet>{lastInvite.link}</Snippet>
						</div>
					)}
				</form>
			)}

			<div className="lines" style={{ marginTop: 16 }}>
				{access.owner && (
					<div className="line">
						<Avatar name={access.owner.name || access.owner.email} image={access.owner.image} />
						<div className="grow">
							<div className="title clip">
								{access.owner.name || access.owner.email}
								{access.owner.userId === me.id && " (you)"}
							</div>
							<div className="soft clip">{access.owner.email}</div>
						</div>
						<span className="tag blue">Owner</span>
					</div>
				)}
				{access.members.map((member) => (
					<div className="line" key={member.userId}>
						<Avatar name={member.name || member.email} image={member.image} />
						<div className="grow">
							<div className="title clip">
								{member.name || member.email}
								{member.userId === me.id && " (you)"}
							</div>
							<div className="soft clip">
								{member.email} · since {when(member.since)}
							</div>
						</div>
						{owner ? (
							<div className="acts">
								<select
									aria-label={`Role for ${member.email}`}
									value={member.role}
									disabled={busy}
									onChange={(event) => void share(member.email, event.target.value as Role, "Changed role")}
								>
									<option value="editor">Editor</option>
									<option value="viewer">Viewer</option>
								</select>
								<button type="button" className="btn quiet small" onClick={() => setRemoving({ kind: "member", userId: member.userId, label: member.name || member.email })}>
									Remove
								</button>
							</div>
						) : (
							<div className="acts">
								<span className="tag">{ROLES[member.role].name}</span>
								{member.userId === me.id && (
									<button type="button" className="btn quiet small" onClick={() => setRemoving({ kind: "leave" })}>
										Leave
									</button>
								)}
							</div>
						)}
					</div>
				))}
			</div>

			{owner && access.invites && access.invites.length > 0 && (
				<div className="block">
					<h2>Invitations</h2>
					<p className="soft" style={{ marginTop: 6 }}>
						Waiting for these people to sign up. They get access as soon as they sign in with the address invited.
					</p>
					<div className="lines" style={{ marginTop: 12 }}>
						{access.invites.map((invite) => (
							<div className="line stack" key={invite.id}>
								<div className="grow">
									<div className="title clip">{invite.email}</div>
									<div className="soft">
										{ROLES[invite.role].name} ·{" "}
										{invite.expired ? "expired" : invite.sentAt ? `sent ${when(invite.sentAt)}, open until ${when(invite.expiresAt)}` : "email not sent"}
									</div>
								</div>
								<div className="acts">
									<button
										type="button"
										className="btn quiet small"
										disabled={busy}
										onClick={() => void navigator.clipboard.writeText(invite.link).then(() => toast("Copied the invitation link"))}
									>
										Copy link
									</button>
									<button type="button" className="btn quiet small" disabled={busy} onClick={() => void share(invite.email, invite.role, "Sent the invitation again")}>
										Send again
									</button>
									<button type="button" className="btn quiet small" onClick={() => setRemoving({ kind: "invite", inviteId: invite.id, label: invite.email })}>
										Withdraw
									</button>
								</div>
							</div>
						))}
					</div>
				</div>
			)}

			<Confirm
				open={removing !== null}
				onClose={() => setRemoving(null)}
				busy={busy}
				title={removing?.kind === "leave" ? "Leave this project?" : removing?.kind === "invite" ? "Withdraw the invitation?" : "Remove access?"}
				action={removing?.kind === "leave" ? "Leave project" : removing?.kind === "invite" ? "Withdraw" : "Remove"}
				onConfirm={async () => {
					if (!removing) return;
					if (removing.kind === "leave") {
						// Not through `act`: reloading this page after leaving would find the project gone.
						try {
							await op("project.unshare", { projectId: current.id, userId: me.id });
							forgetMe();
							toast("You left the project");
							void navigate({ to: "/projects" });
						} catch (error) {
							toast(error instanceof Error ? error.message : "That did not work. Try again.", true);
						}
						setRemoving(null);
						return;
					}
					const input = removing.kind === "member" ? { userId: removing.userId } : { inviteId: removing.inviteId };
					await act(() => op("project.unshare", { projectId: current.id, ...input }), "Removed");
					setRemoving(null);
				}}
			>
				{removing?.kind === "leave"
					? `You will lose access to ${current.name}. Its owner can share it with you again.`
					: removing?.kind === "invite"
						? `The link sent to ${removing.label} will stop working.`
						: removing
							? `${removing.label} will lose access to ${current.name}. What they made stays in the project.`
							: ""}
			</Confirm>
		</div>
	);
}
