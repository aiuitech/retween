import { HeadContent, Link, Outlet, Scripts, createRootRoute } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { loadMe } from "../session.ts";
import styles from "../styles.css?url";
import { Empty, Toaster } from "../ui.tsx";

const ICON =
	"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%23171b21'/%3E%3Cpath d='M7 16h18' stroke='%23fff' stroke-width='1.6'/%3E%3Cpath d='M13 11.5v9M16 11.5v9M19 11.5v9' stroke='%2362aee8' stroke-width='1.6'/%3E%3Cpath d='M7 11.5 11.5 16 7 20.5 2.500 16z' fill='%23fff'/%3E%3Cpath d='M25 11.5 29.500 16 25 20.5 20.500 16z' fill='%23ff6a3d'/%3E%3C/svg%3E";

export const Route = createRootRoute({
	beforeLoad: async () => ({ me: await loadMe() }),
	head: () => ({
		meta: [
			{ charSet: "utf-8" },
			{ name: "viewport", content: "width=device-width, initial-scale=1" },
			{ name: "description", content: "Retween is an open-source video studio your agent operates over MCP or the command line. Pay what each video cost to make plus 40%, or host it yourself at cost." },
			{ title: "Retween" },
		],
		links: [
			{ rel: "icon", href: ICON },
			{ rel: "preconnect", href: "https://fonts.googleapis.com" },
			{ rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
			{
				rel: "stylesheet",
				href: "https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=Mona+Sans:wdth,wght@75..125,400..800&display=swap",
			},
			{ rel: "stylesheet", href: styles },
		],
	}),
	component: () => (
		<Document>
			<Toaster>
				<Outlet />
			</Toaster>
		</Document>
	),
	notFoundComponent: () => (
		<main className="page narrow">
			<Empty
				title="There is no page here"
				actions={
					<Link className="btn" to="/">
						Go to the start
					</Link>
				}
			>
				Check the address, or start again from the first page.
			</Empty>
		</main>
	),
	errorComponent: ({ error, reset }) => (
		<main className="page narrow">
			<Empty
				title="This page could not be loaded"
				actions={
					<button type="button" className="btn" onClick={reset}>
						Try again
					</button>
				}
			>
				{error instanceof Error ? error.message : "Something went wrong."}
			</Empty>
		</main>
	),
});

function Document({ children }: { children: ReactNode }) {
	return (
		<html lang="en">
			<head>
				<HeadContent />
			</head>
			<body>
				{children}
				<Scripts />
			</body>
		</html>
	);
}
