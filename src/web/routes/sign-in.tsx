import { createFileRoute, redirect } from "@tanstack/react-router";
import { Landing } from "../landing.tsx";
import landingStyles from "../landing.css?url";
import { getPricing } from "../rpc.ts";
import { safePath } from "../session.ts";

/**
 * Where signed-out visitors are sent, and where an MCP client's OAuth request
 * lands (with its own signed parameters, which are left exactly as they came).
 */
export const Route = createFileRoute("/sign-in")({
	validateSearch: (search: Record<string, unknown>): { redirect?: string; client_id?: string } & Record<string, unknown> => search,
	beforeLoad: ({ context, search }) => {
		if (context.me && !search.client_id) throw redirect({ href: safePath(search.redirect) ?? "/projects" });
	},
	head: () => ({ links: [{ rel: "stylesheet", href: landingStyles }] }),
	loader: () => getPricing(),
	component: SignIn,
});

function SignIn() {
	const search = Route.useSearch();
	return <Landing pricing={Route.useLoaderData()} connecting={Boolean(search.client_id)} next={safePath(search.redirect)} />;
}
