import { createFileRoute, redirect } from "@tanstack/react-router";
import { Landing } from "../landing.tsx";
import landingStyles from "../landing.css?url";

export const Route = createFileRoute("/")({
	beforeLoad: ({ context }) => {
		if (context.me) throw redirect({ to: "/projects" });
	},
	head: () => ({ links: [{ rel: "stylesheet", href: landingStyles }] }),
	component: () => <Landing />,
});
