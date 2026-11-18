import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { authApi, authClient, op, when } from "../../api.ts";
import { getOrigin } from "../../rpc.ts";
import { Confirm, Empty, Snippet, Status, useAct, useClientLoad, useToast } from "../../ui.tsx";

interface ApiKey {
	id: string;
	name: string | null;
	start: string | null;
	createdAt: string;
	lastRequest: string | null;
}
interface Channel {
	id: string;
	title: string;
	handle?: string;
	url: string;
	needsReconnect?: boolean;
	connectedAt: string;
}
interface Consent {
	id: string;
	clientId: string;
	createdAt: string;
}

export const Route = createFileRoute("/_app/connect")({
	// What the YouTube connect flow reports when it sends the person back here.
	validateSearch: (search: Record<string, unknown>): { youtube?: string; channel?: string; reason?: string } => ({
		youtube: typeof search.youtube === "string" ? search.youtube : undefined,
		channel: search.channel === undefined ? undefined : String(search.channel),
		reason: typeof search.reason === "string" ? search.reason : undefined,
	}),
	loader: async () => {
		const [channels, origin] = await Promise.all([op<{ channels: Channel[] }>("youtube.channels"), getOrigin()]);
		return { channels: channels.channels, origin };
	},
	head: () => ({ meta: [{ title: "Connect · Retween" }] }),
	component: Connect,
});

function Connect() {
	const { origin } = Route.useLoaderData();
	return (
		<main className="page narrow">
			<div className="head">
				<div className="words">
					<h1>Connect</h1>
					<p>Retween is operated by an agent or from the command line. Set either up here, and manage what is allowed to act as you.</p>
				</div>
			</div>

			<section className="block" id="mcp">
				<div className="block-head">
					<div>
						<h2>Your agent, over MCP</h2>
						<p>Add Retween as a remote MCP server. It signs in through your browser the first time; there is nothing to paste.</p>
					</div>
				</div>
				<div className="cel pad">
					<h3>Server address</h3>
					<Snippet>{`${origin}/mcp`}</Snippet>
					<h3>Claude Code</h3>
					<Snippet>{`claude mcp add --transport http retween ${origin}/mcp`}</Snippet>
					<h3>Claude, ChatGPT, Cursor and others</h3>
					<p className="soft" style={{ margin: "4px 0 10px" }}>
						Add a custom connector (remote MCP server) and paste the server address. For clients that cannot open a browser, send an API key as a bearer token instead:
					</p>
					<Snippet>{`{\n  "mcpServers": {\n    "retween": {\n      "type": "http",\n      "url": "${origin}/mcp",\n      "headers": { "Authorization": "Bearer rtw_…" }\n    }\n  }\n}`}</Snippet>
				</div>
			</section>

			<section className="block" id="cli">
				<div className="block-head">
					<div>
						<h2>The command line</h2>
						<p>The CLI runs the same operations as the MCP tools, and can upload files from your computer.</p>
					</div>
				</div>
				<div className="cel pad">
					<h3>Install (Node 20 or later)</h3>
					<Snippet>{`npm install -g ${origin}/cli/retween.tgz`}</Snippet>
					<h3>Sign in and look around</h3>
					<Snippet>{"retween login\nretween project list\nretween --help"}</Snippet>
				</div>
			</section>

			<Keys />
			<Youtube />
			<Apps />
		</main>
	);
}

function Keys() {
	const toast = useToast();
	const keys = useClientLoad(async () => {
		const result = (await authClient.apiKey.list()).data as unknown;
		return (Array.isArray(result) ? result : ((result as { apiKeys?: ApiKey[] } | null)?.apiKeys ?? [])) as ApiKey[];
	});
	const [name, setName] = useState("");
	const [fresh, setFresh] = useState<string | null>(null);
	const [revoking, setRevoking] = useState<ApiKey | null>(null);
	return (
		<section className="block" id="keys">
			<div className="block-head">
				<div>
					<h2>API keys</h2>
					<p>For scripts, CI and agents that cannot sign in through a browser. A key acts as you, so treat it like a password.</p>
				</div>
			</div>
			{fresh && (
				<div className="note ok">
					Copy this key now. It is not shown again.
					<div className="secret">{fresh}</div>
				</div>
			)}
			<div className="lines">
				<form
					className="line"
					onSubmit={async (event) => {
						event.preventDefault();
						const created = await authClient.apiKey.create({ name: name.trim() });
						if (created.error) return toast(created.error.message ?? "The key could not be created.", true);
						setFresh((created.data as { key?: string } | null)?.key ?? null);
						setName("");
						keys.reload();
						toast("Created key");
					}}
				>
					<div className="grow">
						<input placeholder="Name the key after where it will live, e.g. laptop or ci" value={name} onChange={(event) => setName(event.target.value)} maxLength={32} aria-label="Name for the new key" />
					</div>
					<button className="btn" type="submit" disabled={!name.trim()}>
						Create key
					</button>
				</form>
				{keys.data?.length === 0 && <div className="line soft">No keys yet.</div>}
				{(keys.data ?? []).map((key) => (
					<div className="line" key={key.id}>
						<div className="grow">
							<div className="title">{key.name ?? "Unnamed key"}</div>
							<div className="facts">
								<code>{key.start ?? "rtw_"}…</code>
								<span>Created {when(key.createdAt)}</span>
								<span>{key.lastRequest ? `Last used ${when(key.lastRequest)}` : "Never used"}</span>
							</div>
						</div>
						<button type="button" className="btn danger small" onClick={() => setRevoking(key)}>
							Revoke
						</button>
					</div>
				))}
			</div>
			{revoking && (
				<Confirm
					open
					onClose={() => setRevoking(null)}
					title="Revoke this key?"
					action="Revoke key"
					onConfirm={async () => {
						await authClient.apiKey.delete({ keyId: revoking.id });
						setRevoking(null);
						keys.reload();
						toast("Revoked key");
					}}
				>
					Anything still using “{revoking.name ?? "this key"}” stops working straight away.
				</Confirm>
			)}
		</section>
	);
}

function Youtube() {
	const { channels } = Route.useLoaderData();
	const search = Route.useSearch();
	const { busy, act } = useAct();
	const [leaving, setLeaving] = useState<Channel | null>(null);
	// Arrived from a connect link before signing in: carry on to Google now that there is a session.
	useEffect(() => {
		if (search.youtube === "sign-in") location.replace("/api/youtube/connect");
	}, [search.youtube]);
	return (
		<section className="block" id="youtube">
			<div className="block-head">
				<div>
					<h2>YouTube</h2>
					<p>Channels your agent can publish finished exports to. Uploads are private unless you ask for unlisted, public or a scheduled time.</p>
				</div>
				<a className="btn quiet" href="/api/youtube/connect">
					Connect a channel
				</a>
			</div>
			{search.youtube === "connected" && <p className="note ok">Connected {search.channel ?? "the channel"}.</p>}
			{search.youtube === "error" && <p className="note bad">{search.reason ?? "The channel was not connected."}</p>}
			{channels.length === 0 ? (
				<Empty title="No channels connected">Connect one to let your agent publish. You choose the channel on Google's own screen.</Empty>
			) : (
				<div className="lines">
					{channels.map((channel) => (
						<div className="line" key={channel.id}>
							<div className="grow">
								<a className="title" href={channel.url} target="_blank" rel="noreferrer">
									{channel.title}
								</a>
								<div className="facts">
									{channel.handle && <span>{channel.handle}</span>}
									<span>Connected {when(channel.connectedAt)}</span>
								</div>
							</div>
							{channel.needsReconnect && <Status tone="warn">Needs reconnecting</Status>}
							<div className="acts">
								{channel.needsReconnect && (
									<a className="btn small" href="/api/youtube/connect">
										Reconnect
									</a>
								)}
								<button type="button" className="btn danger small" onClick={() => setLeaving(channel)}>
									Disconnect
								</button>
							</div>
						</div>
					))}
				</div>
			)}
			{leaving && (
				<Confirm
					open
					onClose={() => setLeaving(null)}
					title="Disconnect this channel?"
					action="Disconnect channel"
					busy={busy}
					onConfirm={async () => {
						if (await act(() => op("youtube.disconnect", { channel: leaving.id }), "Disconnected channel")) setLeaving(null);
					}}
				>
					Your agent will no longer be able to publish to {leaving.title}. Videos already on YouTube stay there.
				</Confirm>
			)}
		</section>
	);
}

function Apps() {
	const toast = useToast();
	const consents = useClientLoad(() => authApi<Consent[]>("/oauth2/get-consents").catch(() => []));
	return (
		<section className="block" id="apps">
			<div className="block-head">
				<div>
					<h2>Connected apps</h2>
					<p>Apps you allowed to use Retween as you. Removing one makes it ask again next time.</p>
				</div>
			</div>
			{consents.data?.length === 0 && <Empty title="No apps are connected">An app appears here after you allow it on the access request screen.</Empty>}
			{(consents.data?.length ?? 0) > 0 && (
				<div className="lines">
					{consents.data!.map((consent) => (
						<App
							key={consent.id}
							consent={consent}
							onRemoved={() => {
								consents.reload();
								toast("Removed app");
							}}
						/>
					))}
				</div>
			)}
		</section>
	);
}

function App({ consent, onRemoved }: { consent: Consent; onRemoved: () => void }) {
	const client = useClientLoad(() => authApi<{ client_name?: string }>(`/oauth2/public-client?client_id=${encodeURIComponent(consent.clientId)}`).catch(() => ({ client_name: undefined })));
	return (
		<div className="line">
			<div className="grow">
				<div className="title">{client.data?.client_name ?? "Application"}</div>
				<div className="facts">
					<span>Allowed {when(consent.createdAt)}</span>
				</div>
			</div>
			<button type="button" className="btn danger small" onClick={() => authApi("/oauth2/delete-consent", { method: "POST", body: { id: consent.id } }).then(onRemoved)}>
				Remove
			</button>
		</div>
	);
}
