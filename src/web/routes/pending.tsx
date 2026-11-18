import { createFileRoute, redirect } from "@tanstack/react-router";
import { Slate } from "../public.tsx";
import { signOut } from "../session.ts";

export const Route = createFileRoute("/pending")({
	beforeLoad: ({ context }) => {
		if (!context.me) throw redirect({ to: "/sign-in" });
		if (context.me.approved && !context.me.banned) throw redirect({ to: "/projects" });
		return { me: context.me };
	},
	component: Pending,
});

function Pending() {
	const { me } = Route.useRouteContext();
	return (
		<Slate kind={me.banned ? "Account suspended" : "Waiting for approval"} title={me.banned ? "This account is suspended." : "You are on the list."}>
			<p>
				{me.banned
					? "Contact an administrator if you think this is a mistake."
					: `${me.email} has been registered. An administrator needs to approve the account before it can make videos. Come back to this page afterwards; nothing else is needed from you.`}
			</p>
			<div className="choices">
				<button type="button" className="btn quiet" onClick={() => void signOut()}>
					Sign out
				</button>
			</div>
		</Slate>
	);
}
