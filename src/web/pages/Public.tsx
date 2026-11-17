import { useEffect, useState } from "react";
import { type Me, authApi, authClient } from "../api.ts";
import { Slate, Track } from "../ui.tsx";

/** Starts Google sign-in. An in-flight OAuth request (an MCP client connecting) is carried along automatically. */
export function signIn(next?: string) {
	void authClient.signIn.social({ provider: "google", callbackURL: next ?? "/" });
}

export function Landing({ signInPage }: { signInPage?: boolean }) {
	// When an MCP client sent the person here, say so.
	const connecting = signInPage && new URLSearchParams(location.search).has("client_id");
	return (
		<>
			<div className="hero">
				<h1>
					Storyboard in, <em>finished video</em> out.
				</h1>
				<p className="lede">
					{connecting
						? "An app is asking to make videos with your Retween account. Sign in to review the request."
						: "Retween is a video studio your agent operates. It keeps your brand, voices the script, finds or generates the pictures, times every scene to the recorded audio and renders it at any size."}
				</p>
				<div className="enter">
					{/* An upload link from an agent (/projects/<id>) should land back on that project after sign-in. */}
					<button type="button" className="btn big" onClick={() => signIn(location.pathname.startsWith("/projects/") ? location.pathname : undefined)}>
						Continue with Google <span aria-hidden="true">→</span>
					</button>
					<p className="label" style={{ marginTop: 14 }}>
						New accounts are approved by an administrator
					</p>
				</div>
			</div>
			<div className="steps">
				{[
					["01", "Brief", "A project remembers the brand: palette, fonts, voice, tone, cast, standing instructions."],
					["02", "Storyboard", "Scenes say what is shown and said. No durations: the audio decides those."],
					["03", "Prepare", "Narration, stills, stock and clips land first. Then every cue is timed to the voice."],
					["04", "Render", "One timeline, laid out again for 16:9, 9:16, 1:1 and 4:5, up to 4K."],
				].map(([n, title, text]) => (
					<div key={n}>
						<span className="label">{n}</span>
						<h3>{title}</h3>
						<p>{text}</p>
					</div>
				))}
			</div>
			<Track />
		</>
	);
}

export function Pending({ me }: { me: Me }) {
	return (
		<Slate label={me.banned ? "Account suspended" : "Waiting for approval"}>
			<h2>{me.banned ? "This account is suspended." : "You are on the list."}</h2>
			<p className="muted">
				{me.banned
					? "Contact an administrator if you think this is a mistake."
					: `${me.email} has been registered. An administrator needs to approve the account before it can make videos. Come back to this page afterwards; nothing else is needed from you.`}
			</p>
			<div className="choices">
				<button type="button" className="btn ghost" onClick={() => authClient.signOut().then(() => location.assign("/"))}>
					Sign out
				</button>
			</div>
		</Slate>
	);
}

/** OAuth consent: shown when an MCP client asks for access. */
export function Consent() {
	const query = new URLSearchParams(location.search);
	const clientId = query.get("client_id") ?? "";
	const [client, setClient] = useState<{ client_name?: string; client_uri?: string } | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");

	useEffect(() => {
		authApi<{ client_name?: string; client_uri?: string }>(`/oauth2/public-client?client_id=${encodeURIComponent(clientId)}`)
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

	const name = client?.client_name || "An application";
	let host = "";
	try {
		host = new URL(query.get("redirect_uri") ?? "").host;
	} catch {
		// no redirect shown
	}
	return (
		<Slate label="Access request">
			<h2>
				<em>{name}</em> wants to use Retween as you.
			</h2>
			<p className="muted">
				{host ? `It will return to ${host}. ` : ""}Only allow this if you started it yourself.
			</p>
			<ul>
				<li>Read and change your projects, brand kits, assets and videos</li>
				<li>Generate media and render videos, spending your monthly budget</li>
				<li>See your name and email address</li>
			</ul>
			{error && (
				<p className="notice" style={{ marginTop: 18 }}>
					{error}
				</p>
			)}
			<div className="choices">
				<button type="button" className="btn" disabled={busy} onClick={() => decide(true)}>
					Allow
				</button>
				<button type="button" className="btn ghost" disabled={busy} onClick={() => decide(false)}>
					Deny
				</button>
			</div>
		</Slate>
	);
}

/** Device approval: where `retween login` sends the person. */
export function Device({ me }: { me: Me | null }) {
	const initial = new URLSearchParams(location.search).get("user_code") ?? "";
	const [code, setCode] = useState(initial.toUpperCase());
	const [state, setState] = useState<"enter" | "confirm" | "approved" | "denied">("enter");
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const clean = code.replace(/[^A-Za-z0-9]/g, "").toUpperCase();

	const check = async (value: string) => {
		setBusy(true);
		setError("");
		try {
			await authApi(`/device?user_code=${encodeURIComponent(value)}`);
			setState("confirm");
		} catch {
			setError("That code is not valid or has expired. Run `retween login` again for a new one.");
		}
		setBusy(false);
	};

	// biome-ignore lint/correctness/useExhaustiveDependencies: runs once for a code that arrived in the link
	useEffect(() => {
		if (me && initial) void check(initial.replace(/[^A-Za-z0-9]/g, "").toUpperCase());
	}, []);

	const decide = async (approve: boolean) => {
		setBusy(true);
		try {
			await authApi(`/device/${approve ? "approve" : "deny"}`, { method: "POST", body: { userCode: clean } });
			setState(approve ? "approved" : "denied");
		} catch (reason) {
			setError((reason as Error).message);
		}
		setBusy(false);
	};

	if (!me) {
		return (
			<Slate label="Command-line sign-in">
				<h2>Sign in to connect the CLI.</h2>
				<p className="muted">You will come straight back here to confirm the code shown in your terminal.</p>
				<div className="choices">
					<button type="button" className="btn" onClick={() => signIn(location.pathname + location.search)}>
						Continue with Google →
					</button>
				</div>
			</Slate>
		);
	}
	if (state === "approved" || state === "denied") {
		return (
			<Slate label="Command-line sign-in">
				<h2>{state === "approved" ? "Connected." : "Request denied."}</h2>
				<p className="muted">{state === "approved" ? "Return to your terminal: the CLI is signed in. You can close this tab." : "Nothing was connected."}</p>
			</Slate>
		);
	}
	return (
		<Slate label="Command-line sign-in">
			<h2>{state === "confirm" ? "Is this the code in your terminal?" : "Enter the code from your terminal."}</h2>
			<input className="code" value={code} maxLength={12} onChange={(e) => (setCode(e.target.value), setState("enter"))} aria-label="Device code" autoFocus />
			{error && (
				<p className="notice" style={{ marginTop: 18 }}>
					{error}
				</p>
			)}
			<p className="muted" style={{ marginTop: 18 }}>
				{state === "confirm"
					? `Approving signs the Retween CLI in as ${me.email}. Only approve a code you requested yourself.`
					: "It looks like ABCD-EFGH."}
			</p>
			<div className="choices">
				{state === "confirm" ? (
					<>
						<button type="button" className="btn" disabled={busy} onClick={() => decide(true)}>
							Approve
						</button>
						<button type="button" className="btn ghost" disabled={busy} onClick={() => decide(false)}>
							Deny
						</button>
					</>
				) : (
					<button type="button" className="btn" disabled={busy || clean.length < 6} onClick={() => check(clean)}>
						Continue
					</button>
				)}
			</div>
		</Slate>
	);
}
