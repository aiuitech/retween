import { createFileRoute, redirect } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { authApi, authClient } from "../api.ts";
import { Slate } from "../public.tsx";

/** OAuth consent: shown when an MCP client asks for access. */
export const Route = createFileRoute("/consent")({
	validateSearch: (search: Record<string, unknown>) => search,
	beforeLoad: ({ context, location }) => {
		if (!context.me) throw redirect({ to: "/sign-in", search: { redirect: location.href } });
		if (context.me.banned || context.me.billing === "required") throw redirect({ to: "/billing" });
	},
	component: Consent,
});

function Consent() {
	const search = Route.useSearch();
	const clientId = String(search.client_id ?? "");
	const [client, setClient] = useState<{ client_name?: string } | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");

	useEffect(() => {
		authApi<{ client_name?: string }>(`/oauth2/public-client?client_id=${encodeURIComponent(clientId)}`)
			.then(setClient)
			.catch(() => setClient({}));
	}, [clientId]);

	const decide = async (accept: boolean) => {
		setBusy(true);
		setError("");
		const result = await authClient.oauth2.consent({ accept });
		if (result.error) {
			setError(result.error.message ?? "That did not work. Start again from the app that sent you here.");
			setBusy(false);
			return;
		}
		const target = (result.data as { url?: string; redirect_uri?: string } | null)?.url ?? (result.data as { redirect_uri?: string } | null)?.redirect_uri;
		if (target) location.assign(target);
	};

	let host = "";
	try {
		host = new URL(String(search.redirect_uri ?? "")).host;
	} catch {
		// no redirect shown
	}
	return (
		<Slate kind="Access request" title={`${client?.client_name || "An application"} wants to use Retween as you.`}>
			<p>{host ? `It will return to ${host}. ` : ""}Only allow this if you started it yourself.</p>
			<ul>
				<li>Read and change your projects, brand kits, assets and videos</li>
				<li>Generate media and render videos, spending your monthly budget</li>
				<li>See your name and email address</li>
			</ul>
			{error && (
				<p className="note bad" style={{ marginTop: 18 }}>
					{error}
				</p>
			)}
			<div className="choices">
				<button type="button" className="btn" disabled={busy} onClick={() => decide(true)}>
					Allow
				</button>
				<button type="button" className="btn quiet" disabled={busy} onClick={() => decide(false)}>
					Deny
				</button>
			</div>
		</Slate>
	);
}
