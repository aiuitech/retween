import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { authClient } from "../../../api.ts";
import { forgetMe, signOut } from "../../../session.ts";
import { Avatar, Confirm, Field, useAct, useToast } from "../../../ui.tsx";

export const Route = createFileRoute("/_app/account/")({ component: Profile });

function Profile() {
	const { me } = Route.useRouteContext();
	const { busy, act } = useAct();
	const toast = useToast();
	const [name, setName] = useState(me.name);
	const [closing, setClosing] = useState(false);
	const [closeBusy, setCloseBusy] = useState(false);

	const close = async () => {
		setCloseBusy(true);
		const result = await authClient.deleteUser();
		if (result.error) {
			setCloseBusy(false);
			setClosing(false);
			// Deleting needs a recent sign-in, since there is no password to ask for.
			toast(
				/fresh|session/i.test(`${result.error.code} ${result.error.message}`)
					? "For safety this needs a recent sign-in. Sign out, sign in again, then delete the account."
					: (result.error.message ?? "The account could not be deleted. Try again."),
				true,
			);
			return;
		}
		location.assign("/");
	};

	return (
		<>
			<section className="block">
				<div className="block-head">
					<div>
						<h2>Profile</h2>
						<p>Your name appears on the things you make. Sign-in is through Google, so there is no password to manage here.</p>
					</div>
				</div>
				<form
					className="cel pad fields"
					onSubmit={(event) => {
						event.preventDefault();
						void act(async () => {
							const result = await authClient.updateUser({ name: name.trim() });
							if (result.error) throw new Error(result.error.message ?? "The name could not be saved.");
							forgetMe();
						}, "Saved changes");
					}}
				>
					<div style={{ display: "flex", gap: 18, alignItems: "center" }}>
						<Avatar name={me.name || me.email} image={me.image} large />
						<div style={{ minWidth: 0 }}>
							<div className="clip" style={{ fontWeight: 600, fontSize: "1.1rem" }}>
								{me.name}
							</div>
							<div className="soft">{me.isAdmin ? "Administrator" : "Member"}. The picture comes from your Google account.</div>
						</div>
					</div>
					<Field label="Name">
						<input value={name} onChange={(event) => setName(event.target.value)} maxLength={80} required autoComplete="name" />
					</Field>
					<Field label="Email" hint="This is the Google account you sign in with. It cannot be changed here.">
						<input value={me.email} readOnly disabled />
					</Field>
					<div>
						<button type="submit" className="btn" disabled={busy || !name.trim() || name.trim() === me.name}>
							Save changes
						</button>
					</div>
				</form>
			</section>

			<section className="block">
				<div className="block-head">
					<h2>Sign out</h2>
				</div>
				<div className="cel pad" style={{ display: "flex", gap: 20, alignItems: "center", flexWrap: "wrap" }}>
					<p className="soft" style={{ flex: "1 1 300px" }}>
						Signs this browser out. Agents, the command line and API keys stay connected; manage those under Sessions and Connect.
					</p>
					<button type="button" className="btn quiet" onClick={() => void signOut()}>
						Sign out
					</button>
				</div>
			</section>

			<section className="block">
				<div className="block-head">
					<h2>Delete account</h2>
				</div>
				<div className="cel pad danger-zone" style={{ display: "flex", gap: 20, alignItems: "center", flexWrap: "wrap" }}>
					<p className="soft" style={{ flex: "1 1 300px" }}>
						Deletes your account with every project, file, video and export in it, and disconnects every agent and API key. This cannot be undone.
					</p>
					<button type="button" className="btn danger" onClick={() => setClosing(true)}>
						Delete account
					</button>
				</div>
			</section>

			<Confirm open={closing} onClose={() => setClosing(false)} title="Delete your account?" action="Delete account" phrase={me.email} busy={closeBusy} onConfirm={() => void close()}>
				Everything you have made in Retween will be deleted for good: projects, brand kits, files, videos and exports. Connected agents and API keys stop working straight away.
			</Confirm>
		</>
	);
}
