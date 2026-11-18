import { createFileRoute } from "@tanstack/react-router";
import { authClient, when } from "../../../api.ts";
import { signOut } from "../../../session.ts";
import { Empty, Status, useClientLoad, useToast } from "../../../ui.tsx";

export const Route = createFileRoute("/_app/account/sessions")({ component: Sessions });

interface SessionRow {
	id: string;
	token: string;
	userAgent?: string | null;
	createdAt: string;
	expiresAt: string;
}

function describe(agent?: string | null): string {
	if (!agent) return "Command line or API";
	if (/retween-cli/i.test(agent)) return "Retween CLI";
	const browser = /Edg\//.test(agent) ? "Edge" : /Chrome\//.test(agent) ? "Chrome" : /Firefox\//.test(agent) ? "Firefox" : /Safari\//.test(agent) ? "Safari" : "Browser";
	const system = /Mac OS X/.test(agent) ? "macOS" : /Windows/.test(agent) ? "Windows" : /Android/.test(agent) ? "Android" : /iPhone|iPad/.test(agent) ? "iOS" : /Linux/.test(agent) ? "Linux" : "";
	return system ? `${browser} on ${system}` : browser;
}

function Sessions() {
	const toast = useToast();
	const sessions = useClientLoad(async () => ((await authClient.listSessions()).data ?? []) as unknown as SessionRow[]);
	const current = authClient.useSession().data?.session.token;
	const others = (sessions.data ?? []).filter((session) => session.token !== current);
	return (
		<section className="block">
			<div className="block-head">
				<div>
					<h2>Sessions</h2>
					<p>Browsers and command-line logins that are signed in as you. Sign out any you do not recognise.</p>
				</div>
				{others.length > 0 && (
					<button
						type="button"
						className="btn quiet"
						onClick={async () => {
							await authClient.revokeOtherSessions();
							sessions.reload();
							toast("Signed out everywhere else");
						}}
					>
						Sign out everywhere else
					</button>
				)}
			</div>
			{sessions.error && <p className="note bad">{sessions.error}</p>}
			{sessions.data?.length === 0 && <Empty title="No sessions to show" />}
			{(sessions.data?.length ?? 0) > 0 && (
				<div className="lines">
					{sessions.data!.map((session) => (
						<div className="line" key={session.id}>
							<div className="grow">
								<div className="title">{describe(session.userAgent)}</div>
								<div className="facts">
									<span>Signed in {when(session.createdAt)}</span>
									<span>Expires {when(session.expiresAt)}</span>
								</div>
							</div>
							{session.token === current ? (
								<>
									<Status tone="ok">This browser</Status>
									<button type="button" className="btn quiet small" onClick={() => void signOut()}>
										Sign out
									</button>
								</>
							) : (
								<button
									type="button"
									className="btn quiet small"
									onClick={async () => {
										await authClient.revokeSession({ token: session.token });
										sessions.reload();
										toast("Signed out");
									}}
								>
									Sign out
								</button>
							)}
						</div>
					))}
				</div>
			)}
		</section>
	);
}
