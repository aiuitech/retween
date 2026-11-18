import { createFileRoute, redirect } from "@tanstack/react-router";
import { Landing } from "../public.tsx";

export const Route = createFileRoute("/")({
	beforeLoad: ({ context }) => {
		if (context.me) throw redirect({ to: "/projects" });
	},
	component: () => <Landing />,
});
