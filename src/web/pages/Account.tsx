import { type ReactNode, useEffect, useState } from "react";
import { type Me, authApi, authClient, op, usd, when } from "../api.ts";
import { Section, Snippet, useLoad } from "../ui.tsx";

interface ApiKey {
	id: string;
	name: string | null;
	start: string | null;
	createdAt: string;
	lastRequest: string | null;
}
interface SessionRow {
	id: string;
	token: string;
	userAgent?: string | null;
	createdAt: string;
	expiresAt: string;
}
interface YoutubeChannelRow {
	id: string;
	title: string;
	handle?: string;
	url: string;
	thumbnailUrl?: string;
	needsReconnect?: boolean;
	connectedAt: string;
}
interface ConsentRow {
	id: string;
	clientId: string;
	scopes?: string[];
	createdAt: string;
}

const origin = location.origin;

export function Profile({ me, onChange }: { me: Me; onChange: () => void }) {
	const [name, setName] = useState(me.name);
	const [saved, setSaved] = useState(false);
	const sessions = useLoad(async () => ((await authClient.listSessions()).data ?? []) as unknown as SessionRow[]);
	const current = authClient.useSession().data?.session.token;
	const spent = me.budget.monthlyBudgetUsd ? Math.min(1, me.budget.spentThisMonthUsd / me.budget.monthlyBudgetUsd) : 0;

	return (
		<>
			<Section index="A" title="Profile" note="Your name appears on things you make. Sign-in is through Google, so there is no password to manage here.">
				<form
					className="rows"
					onSubmit={async (event) => {
						event.preventDefault();
						await authClient.updateUser({ name });
						setSaved(true);
						onChange();
						setTimeout(() => setSaved(false), 1600);
					}}
				>
					<div className="row">
						<span className="label" style={{ width: 90 }}>
							Name
						</span>
						<div className="grow">
							<input value={name} onChange={(e) => setName(e.target.value)} aria-label="Name" maxLength={80} />
						</div>
						<button className="btn small" type="submit" disabled={!name.trim() || name === me.name}>
							{saved ? "Saved" : "Save"}
						</button>
					</div>
					<div className="row">
						<span className="label" style={{ width: 90 }}>
							Email
						</span>
						<div className="grow">{me.email}</div>
						<span className={`pill ${me.isAdmin ? "solid" : ""}`}>{me.isAdmin ? "Administrator" : "Member"}</span>
					</div>
				</form>
			</Section>

			<Section index="B" title="Budget" note="Generation and rendering draw on a monthly allowance set by an administrator. It resets on the first of the month.">
				<div className="figures">
					<div>
						<span className="label">Spent this month</span>
						<b>{usd(me.budget.spentThisMonthUsd)}</b>
					</div>
					<div>
						<span className="label">Remaining</span>
						<b>{usd(me.budget.remainingUsd)}</b>
					</div>
					<div>
						<span className="label">Monthly allowance</span>
						<b>{usd(me.budget.monthlyBudgetUsd)}</b>
					</div>
				</div>
				<div className="meter" role="img" aria-label={`${Math.round(spent * 100)}% of budget used`}>
					<i className={spent > 0.85 ? "hot" : ""} style={{ width: `${spent * 100}%` }} />
				</div>
				{me.budget.ownLimitUsd !== undefined && (
					<p className="faint mono">Your own limit of {usd(me.budget.ownLimitUsd)} applies (set under cost controls).</p>
				)}
				<p className="faint mono">Charges are what each vendor bills for your requests, including rendering time and storage.</p>
			</Section>

			<CostControlsSection onChange={onChange} />

			<Section index="D" title="Sessions" note="Browsers and command-line logins that are signed in as you.">
				<div className="rows">
					{(sessions.data ?? []).map((session) => (
						<div className="row" key={session.id}>
							<div className="grow">
								<div className="title">{describeAgent(session.userAgent)}</div>
								<div className="faint mono">since {when(session.createdAt)}</div>
							</div>
							{session.token === current ? (
								<span className="pill ok">This browser</span>
							) : (
								<button type="button" className="btn small ghost" onClick={() => authClient.revokeSession({ token: session.token }).then(sessions.reload)}>
									Sign out
								</button>
							)}
						</div>
					))}
				</div>
				<p style={{ marginTop: 18 }}>
					<button type="button" className="btn ghost" onClick={() => authClient.signOut().then(() => location.assign("/"))}>
						Sign out of this browser
					</button>
				</p>
			</Section>
		</>
	);
}

interface Controls {
	clips: boolean;
	clipMaxResolution: string;
	clipMaxSeconds: number;
	images: boolean;
	imageMaxQuality: string;
	vectors: boolean;
	vectorPro: boolean;
	cutouts: boolean;
	music: boolean;
	soundEffects: boolean;
	narrationModel: string | null;
	renderMaxResolution: string;
	monthlyLimitUsd: number | null;
}
interface ControlsResult {
	controls: Controls;
	options: {
		voiceModels: { id: string; label: string }[];
		imageQualities: string[];
		clipResolutions: string[];
		renderResolutions: string[];
	};
}

function CostControlsSection({ onChange }: { onChange: () => void }) {
	const loaded = useLoad(() => op<ControlsResult>("account.controls"));
	const [controls, setControls] = useState<Controls | null>(null);
	const [status, setStatus] = useState<string | null>(null);
	const [limit, setLimit] = useState("");
	useEffect(() => {
		if (!loaded.data) return;
		setControls(loaded.data.controls);
		setLimit(loaded.data.controls.monthlyLimitUsd === null ? "" : String(loaded.data.controls.monthlyLimitUsd));
	}, [loaded.data]);
	if (!controls || !loaded.data) return null;
	const { options } = loaded.data;

	const save = async (change: Partial<Controls>) => {
		setControls({ ...controls, ...change });
		setStatus("Saving…");
		try {
			const result = await op<ControlsResult>("account.controls_update", change);
			setControls(result.controls);
			setStatus("Saved");
			if ("monthlyLimitUsd" in change) onChange();
		} catch (error) {
			setControls(controls);
			setStatus(error instanceof Error ? error.message : "Could not save");
		}
		setTimeout(() => setStatus(null), 1800);
	};

	const toggle = (key: keyof Controls, title: string, note: string, extra?: ReactNode) => (
		<div className="row control">
			<input type="checkbox" id={`control-${key}`} checked={Boolean(controls[key])} onChange={(event) => save({ [key]: event.target.checked })} />
			<label className="grow" htmlFor={`control-${key}`}>
				<div className="title">{title}</div>
				<div className="faint">{note}</div>
			</label>
			{extra}
		</div>
	);
	const choose = (key: keyof Controls, values: { value: string; label: string }[], disabled = false) => (
		<select className="compact" value={String(controls[key] ?? "")} disabled={disabled} aria-label={key} onChange={(event) => save({ [key]: event.target.value || null })}>
			{values.map((option) => (
				<option key={option.value} value={option.value}>
					{option.label}
				</option>
			))}
		</select>
	);
	const plain = (values: string[], suffix = "") => values.map((value) => ({ value, label: `${suffix}${value}` }));

	return (
		<Section
			index="C"
			title="Cost controls"
			note="Choose what your videos may spend money on. Switched-off media is replaced by a cheaper stand-in when a video is prepared. Changes apply to new work only: nothing already made is regenerated."
		>
			<div className="rows">
				{toggle(
					"clips",
					"Generated video clips",
					"By far the most expensive media. Off: clip scenes use a still instead.",
					choose("clipMaxResolution", plain(options.clipResolutions, "up to "), !controls.clips),
				)}
				{toggle(
					"images",
					"Generated images",
					"Off: scenes fall back to the brand backdrop. Lower quality costs less.",
					choose("imageMaxQuality", plain(options.imageQualities, "up to "), !controls.images),
				)}
				{toggle("vectors", "Vector illustrations", "Flat illustrations that draw themselves on.")}
				{controls.vectors && toggle("vectorPro", "Pro vector model", "Sharper detail at about four times the price.")}
				{toggle("cutouts", "Cut-outs", "Lifts a subject off its background for depth effects.")}
				{toggle("music", "Generated music", "Off: videos have no music bed unless you upload one.")}
				{toggle("soundEffects", "Generated sound effects", "Whooshes, chimes and ambience named in the storyboard.")}
				<div className="row control">
					<span className="spacer" />
					<div className="grow">
						<div className="title">Narration voice model</div>
						<div className="faint">Flash and Turbo cost half as much per character.</div>
					</div>
					{choose("narrationModel", [{ value: "", label: "Follow the brand kit" }, ...options.voiceModels.map((model) => ({ value: model.id, label: model.label }))])}
				</div>
				<div className="row control">
					<span className="spacer" />
					<div className="grow">
						<div className="title">Largest export</div>
						<div className="faint">Bigger exports take longer to render, and render time is charged.</div>
					</div>
					{choose("renderMaxResolution", plain(options.renderResolutions, "up to "))}
				</div>
				<form
					className="row control"
					onSubmit={(event) => {
						event.preventDefault();
						const value = limit.trim() === "" ? null : Number(limit);
						if (value === null || (Number.isFinite(value) && value >= 0)) void save({ monthlyLimitUsd: value });
					}}
				>
					<span className="spacer" />
					<div className="grow">
						<div className="title">Own monthly limit</div>
						<div className="faint">Stop paid work at this amount, even if your allowance is higher. Leave empty for none.</div>
					</div>
					<input className="compact" inputMode="decimal" placeholder="No limit" value={limit} onChange={(event) => setLimit(event.target.value)} aria-label="Own monthly limit in US dollars" />
					<button className="btn small" type="submit" disabled={limit === (controls.monthlyLimitUsd === null ? "" : String(controls.monthlyLimitUsd))}>
						Set
					</button>
				</form>
			</div>
			<p className="faint mono" role="status" style={{ minHeight: "1.4em", marginTop: 10 }}>
				{status}
			</p>
		</Section>
	);
}

function describeAgent(agent?: string | null): string {
	if (!agent) return "Command line or API";
	if (/retween-cli/i.test(agent)) return "Retween CLI";
	const browser = /Edg\//.test(agent) ? "Edge" : /Chrome\//.test(agent) ? "Chrome" : /Firefox\//.test(agent) ? "Firefox" : /Safari\//.test(agent) ? "Safari" : "Browser";
	const system = /Mac OS X/.test(agent) ? "macOS" : /Windows/.test(agent) ? "Windows" : /Android/.test(agent) ? "Android" : /iPhone|iPad/.test(agent) ? "iOS" : /Linux/.test(agent) ? "Linux" : "";
	return system ? `${browser} on ${system}` : browser;
}

export function Connect() {
	const keys = useLoad(async () => {
		const result = (await authClient.apiKey.list()).data as unknown;
		return (Array.isArray(result) ? result : ((result as { apiKeys?: ApiKey[] } | null)?.apiKeys ?? [])) as ApiKey[];
	});
	const consents = useLoad(() => authApi<ConsentRow[]>("/oauth2/get-consents").catch(() => []));
	const [keyName, setKeyName] = useState("");
	const [fresh, setFresh] = useState<string | null>(null);

	return (
		<>
			<Section index="A" title="MCP" note="Add Retween to an agent as a remote MCP server. It signs in through your browser the first time; there is nothing to paste.">
				<p className="label">Server URL</p>
				<Snippet>{`${origin}/mcp`}</Snippet>
				<p className="label">Claude Code</p>
				<Snippet>{`claude mcp add --transport http retween ${origin}/mcp`}</Snippet>
				<p className="label">Claude, ChatGPT, Cursor and others</p>
				<p className="muted" style={{ margin: "8px 0 22px" }}>
					Add a custom connector (remote MCP server) and paste the server URL. For clients that cannot open a browser, send an API key as a bearer token instead:
				</p>
				<Snippet>{`{\n  "mcpServers": {\n    "retween": {\n      "type": "http",\n      "url": "${origin}/mcp",\n      "headers": { "Authorization": "Bearer rtw_…" }\n    }\n  }\n}`}</Snippet>
			</Section>

			<Section index="B" title="Command line" note="The CLI runs the same operations as the MCP tools, and can upload local files.">
				<p className="label">Install (Node 20 or later)</p>
				<Snippet>{`npm install -g ${origin}/cli/retween.tgz`}</Snippet>
				<p className="label">Sign in and look around</p>
				<Snippet>{"retween login\nretween project list\nretween --help"}</Snippet>
			</Section>

			<Section index="C" title="API keys" note="For scripts, CI and agents that cannot use the browser sign-in. A key acts as you; treat it like a password.">
				{fresh && (
					<div className="notice ok">
						Copy this key now. It is not shown again.
						<div className="secret">{fresh}</div>
					</div>
				)}
				<form
					className="row"
					style={{ borderTop: "1px solid var(--ink)" }}
					onSubmit={async (event) => {
						event.preventDefault();
						const created = await authClient.apiKey.create({ name: keyName.trim() });
						setFresh((created.data as { key?: string } | null)?.key ?? null);
						setKeyName("");
						keys.reload();
					}}
				>
					<div className="grow">
						<input placeholder="Name this key, e.g. laptop or ci" value={keyName} onChange={(e) => setKeyName(e.target.value)} maxLength={32} aria-label="Key name" />
					</div>
					<button className="btn small" type="submit" disabled={!keyName.trim()}>
						Create key
					</button>
				</form>
				{keys.data?.length === 0 && <div className="empty">No keys yet.</div>}
				{(keys.data ?? []).map((key) => (
					<div className="row" key={key.id}>
						<div className="grow">
							<div className="title">{key.name ?? "Unnamed key"}</div>
							<div className="faint mono">
								{key.start ?? "rtw_"}… · created {when(key.createdAt)}
								{key.lastRequest ? ` · last used ${when(key.lastRequest)}` : " · never used"}
							</div>
						</div>
						<button type="button" className="btn small ghost danger" onClick={() => authClient.apiKey.delete({ keyId: key.id }).then(keys.reload)}>
							Revoke
						</button>
					</div>
				))}
			</Section>

			<YoutubeSection />

			<Section index="E" title="Connected apps" note="Apps you allowed to use Retween as you. Removing one makes it ask again next time.">
				<div className="rows">
					{(consents.data ?? []).length === 0 && <div className="empty">No apps are connected.</div>}
					{(consents.data ?? []).map((consent) => (
						<ConsentItem key={consent.id} consent={consent} onRemoved={consents.reload} />
					))}
				</div>
			</Section>
		</>
	);
}

function YoutubeSection() {
	const channels = useLoad(() => op<{ channels: YoutubeChannelRow[] }>("youtube.channels").then((result) => result.channels));
	const query = new URLSearchParams(location.search);
	const outcome = query.get("youtube");
	// Arrived from a connect link before signing in: carry on to Google now that there is a session.
	useEffect(() => {
		if (outcome === "sign-in") location.replace("/api/youtube/connect");
	}, [outcome]);
	return (
		<Section
			index="D"
			title="YouTube"
			note="Channels your agent can publish finished renders to. Uploads are private unless you ask for unlisted, public or a scheduled time."
		>
			{outcome === "connected" && <div className="notice ok">Connected {query.get("channel") ?? "the channel"}.</div>}
			{outcome === "error" && <div className="notice">{query.get("reason") ?? "The channel was not connected."}</div>}
			<div className="rows">
				{channels.data?.length === 0 && <div className="empty">No channels connected.</div>}
				{(channels.data ?? []).map((channel) => (
					<div className="row" key={channel.id}>
						<div className="grow">
							<div className="title">
								<a href={channel.url} target="_blank" rel="noreferrer">
									{channel.title}
								</a>
							</div>
							<div className="faint mono">
								{channel.handle ? `${channel.handle} · ` : ""}connected {when(channel.connectedAt)}
							</div>
						</div>
						{channel.needsReconnect && (
							<a className="btn small" href="/api/youtube/connect">
								Reconnect
							</a>
						)}
						<button
							type="button"
							className="btn small ghost danger"
							onClick={() => op("youtube.disconnect", { channel: channel.id }).then(channels.reload)}
						>
							Disconnect
						</button>
					</div>
				))}
			</div>
			<p style={{ marginTop: 18 }}>
				<a className="btn" href="/api/youtube/connect">
					Connect a channel
				</a>
			</p>
		</Section>
	);
}

function ConsentItem({ consent, onRemoved }: { consent: ConsentRow; onRemoved: () => void }) {
	const client = useLoad(() => authApi<{ client_name?: string }>(`/oauth2/public-client?client_id=${encodeURIComponent(consent.clientId)}`).catch(() => ({ client_name: undefined })));
	return (
		<div className="row">
			<div className="grow">
				<div className="title">{client.data?.client_name ?? "Application"}</div>
				<div className="faint mono">allowed {when(consent.createdAt)}</div>
			</div>
			<button type="button" className="btn small ghost danger" onClick={() => authApi("/oauth2/delete-consent", { method: "POST", body: { id: consent.id } }).then(onRemoved)}>
				Remove
			</button>
		</div>
	);
}
