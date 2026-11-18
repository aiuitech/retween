import { Link, Outlet, createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_app/account")({
	head: () => ({ meta: [{ title: "Account · Retween" }] }),
	component: Account,
});

function Account() {
	const here = { "aria-current": "page" } as const;
	return (
		<main className="page">
			<h1>Account</h1>
			<div className="split">
				<nav className="side" aria-label="Account">
					<Link to="/account" activeOptions={{ exact: true }} activeProps={here}>
						Profile
					</Link>
					<Link to="/account/spending" activeProps={here}>
						Spending
					</Link>
					<Link to="/account/sessions" activeProps={here}>
						Sessions
					</Link>
				</nav>
				<div className="main">
					<Outlet />
				</div>
			</div>
		</main>
	);
}
