import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { type Me, fetchMe } from "./api.ts";
import { Connect, Profile } from "./pages/Account.tsx";
import { Admin } from "./pages/Admin.tsx";
import { Library } from "./pages/Library.tsx";
import { Consent, Device, Landing, Pending } from "./pages/Public.tsx";
import "./styles.css";
import { Avatar, Track } from "./ui.tsx";

const TABS = [
	["/", "Library"],
	["/connect", "Connect"],
	["/account", "Account"],
	["/admin", "Admin"],
] as const;

function usePath(): [string, (to: string) => void] {
	const [path, setPath] = useState(location.pathname);
	useEffect(() => {
		const onPop = () => setPath(location.pathname);
		addEventListener("popstate", onPop);
		return () => removeEventListener("popstate", onPop);
	}, []);
	return [
		path,
		(to) => {
			history.pushState(null, "", to);
			setPath(to);
			scrollTo(0, 0);
		},
	];
}

function App() {
	const [path, go] = usePath();
	const [me, setMe] = useState<Me | null | undefined>();
	const load = () => fetchMe().then(setMe, () => setMe(null));
	useEffect(() => void load(), []);

	if (me === undefined) return <div className="shell" />;

	const active = me && me.approved && !me.banned;
	let page: React.ReactNode;
	let chrome = false;
	if (path === "/device") page = <Device me={active ? me : null} />;
	else if (!me) page = <Landing signInPage={path === "/sign-in"} />;
	else if (!active) page = <Pending me={me} />;
	else if (path === "/consent") page = <Consent />;
	else {
		chrome = true;
		page =
			path === "/connect" ? <Connect /> : path === "/account" ? <Profile me={me} onChange={load} /> : path === "/admin" && me.isAdmin ? <Admin me={me} /> : <Library />;
	}

	return (
		<div className="shell">
			<header className="masthead">
				<a
					className="wordmark"
					href="/"
					onClick={(event) => {
						event.preventDefault();
						go("/");
					}}
				>
					re<i>◆</i>tween
				</a>
				{chrome && me && (
					<>
						<nav aria-label="Sections">
							{TABS.filter(([to]) => to !== "/admin" || me.isAdmin).map(([to, label]) => (
								<button type="button" key={to} className="tab" aria-current={(path === to || (to === "/" && !TABS.some(([t]) => t === path))) ? "page" : undefined} onClick={() => go(to)}>
									{label}
								</button>
							))}
						</nav>
						<div className="who">
							<span>{me.name}</span>
							<Avatar name={me.name || me.email} image={me.image} />
						</div>
					</>
				)}
			</header>
			{chrome && <Track keys={[0.04, 0.3, 0.52, 0.78, 0.96]} on={[TABS.findIndex(([to]) => to === path) < 0 ? 0 : TABS.findIndex(([to]) => to === path)]} />}
			{page}
		</div>
	);
}

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
