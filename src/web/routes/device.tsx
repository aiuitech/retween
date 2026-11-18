import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { authApi } from "../api.ts";
import { Slate } from "../public.tsx";
import { signIn } from "../session.ts";

/** Device approval: where `retween login` sends the person. */
export const Route = createFileRoute("/device")({
	validateSearch: (search: Record<string, unknown>) => search,
	component: Device,
});

const tidy = (code: string) => code.replace(/[^A-Za-z0-9]/g, "").toUpperCase();

function Device() {
	const context = Route.useRouteContext();
	const me = context.me && context.me.approved && !context.me.banned ? context.me : null;
	const search = Route.useSearch();
	const initial = String(search.user_code ?? "");
	const [code, setCode] = useState(initial.toUpperCase());
	const [state, setState] = useState<"enter" | "confirm" | "approved" | "denied">("enter");
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const clean = tidy(code);

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
		if (me && initial) void check(tidy(initial));
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
			<Slate kind="Command-line sign-in" title="Sign in to connect the CLI.">
				<p>You will come straight back here to confirm the code shown in your terminal.</p>
				<div className="choices">
					<button type="button" className="btn" onClick={() => signIn(location.pathname + location.search)}>
						Continue with Google
					</button>
				</div>
			</Slate>
		);
	}
	if (state === "approved" || state === "denied") {
		return (
			<Slate kind="Command-line sign-in" title={state === "approved" ? "Connected." : "Request denied."}>
				<p>{state === "approved" ? "Return to your terminal: the CLI is signed in. You can close this tab." : "Nothing was connected."}</p>
			</Slate>
		);
	}
	return (
		<Slate kind="Command-line sign-in" title={state === "confirm" ? "Is this the code in your terminal?" : "Enter the code from your terminal."}>
			<input
				className="code-entry"
				value={code}
				maxLength={12}
				onChange={(event) => {
					setCode(event.target.value);
					setState("enter");
				}}
				aria-label="Device code"
				autoFocus
			/>
			{error && (
				<p className="note bad" style={{ marginTop: 18 }}>
					{error}
				</p>
			)}
			<p>{state === "confirm" ? `Approving signs the Retween CLI in as ${me.email}. Only approve a code you requested yourself.` : "It looks like ABCD-EFGH."}</p>
			<div className="choices">
				{state === "confirm" ? (
					<>
						<button type="button" className="btn" disabled={busy} onClick={() => decide(true)}>
							Approve
						</button>
						<button type="button" className="btn quiet" disabled={busy} onClick={() => decide(false)}>
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
