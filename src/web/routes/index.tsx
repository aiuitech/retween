import { createFileRoute, redirect } from "@tanstack/react-router";
import { Landing } from "../landing.tsx";
import landingStyles from "../landing.css?url";
import { getPricing } from "../rpc.ts";

export const Route = createFileRoute("/")({
	beforeLoad: ({ context }) => {
		if (context.me) throw redirect({ to: "/projects" });
	},
	head: () => ({ links: [{ rel: "stylesheet", href: landingStyles }] }),
	loader: () => getPricing(),
	component: Home,
});

function Home() {
	return <Landing pricing={Route.useLoaderData()} />;
}
