import { redirect } from "@tanstack/react-router";
import { authClient } from "./api.ts";
import { type Me, getMe } from "./rpc.ts";

// Every navigation asks who is signed in. In the browser the answer is kept for a
// minute; on the server it is never kept, because the module is shared by everyone.
let kept: { at: number; me: Me | null } | undefined;

export async function loadMe(): Promise<Me | null> {
	const browser = typeof document !== "undefined";
	if (browser && kept && Date.now() - kept.at < 60_000) return kept.me;
	const me = await getMe();
	if (browser) kept = { at: Date.now(), me };
	return me;
}

/** Call after changing anything `Me` carries (name, budget, billing), before reloading the page's data. */
export const forgetMe = () => {
	kept = undefined;
};

/** Only same-site paths are followed after sign-in. */
export const safePath = (value: unknown): string | undefined => (typeof value === "string" && /^\/(?![/\\])/.test(value) ? value : undefined);

/** For the pages that need an account in good standing. */
export function requireActive(me: Me | null, href: string): Me {
	if (!me) throw redirect({ to: "/sign-in", search: { redirect: href } });
	if (me.banned || me.billing === "required") throw redirect({ to: "/billing" });
	return me;
}

/** Starts Google sign-in. An in-flight OAuth request (an MCP client connecting) is carried along automatically. */
export function signIn(next?: string) {
	void authClient.signIn.social({ provider: "google", callbackURL: next ?? "/projects" });
}

export async function signOut() {
	await authClient.signOut();
	location.assign("/");
}
