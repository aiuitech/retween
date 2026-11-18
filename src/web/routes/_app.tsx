import { Link, Outlet, createFileRoute } from "@tanstack/react-router";
import { usd } from "../api.ts";
import { Wordmark } from "../public.tsx";
import { requireActive, signOut } from "../session.ts";
import { Avatar, Menu } from "../ui.tsx";

/** Everything behind sign-in: the top bar, and the guard that sends everyone else away. */
export const Route = createFileRoute("/_app")({
	beforeLoad: ({ context, location }) => ({ me: requireActive(context.me, location.href) }),
	component: App,
});

function App() {
	const { me } = Route.useRouteContext();
	const here = { "aria-current": "page" } as const;
	return (
		<>
			<header className="top">
				<div className="top-in">
					<Wordmark />
					<nav aria-label="Sections">
						<Link to="/projects" activeProps={here}>
							Projects
						</Link>
						<Link to="/connect" activeProps={here}>
							Connect
						</Link>
						{me.isAdmin && (
							<Link to="/admin" activeProps={here}>
								Admin
							</Link>
						)}
					</nav>
					<Menu
						label="Your account"
						className="who"
						trigger={
							<>
								<Avatar name={me.name || me.email} image={me.image} />
								<span className="name clip">{me.name || me.email}</span>
							</>
						}
					>
						<div className="about">
							<div className="clip" style={{ fontWeight: 600 }}>
								{me.name}
							</div>
							<div className="soft clip">{me.email}</div>
							<div className="soft num" style={{ marginTop: 6 }}>
								{usd(me.budget.remainingUsd)} left this month
							</div>
						</div>
						<hr />
						<Link to="/account">Profile</Link>
						<Link to="/account/spending">Spending</Link>
						<Link to="/account/sessions">Sessions</Link>
						<hr />
						<button type="button" onClick={() => void signOut()}>
							Sign out
						</button>
					</Menu>
				</div>
			</header>
			<Outlet />
		</>
	);
}
