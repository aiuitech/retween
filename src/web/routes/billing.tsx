import { createFileRoute, redirect } from "@tanstack/react-router";
import { usd } from "../api.ts";
import { Slate } from "../public.tsx";
import { signOut } from "../session.ts";

/**
 * The pay gate: a new account adds a payment method here before it can make
 * anything. Also where suspended accounts land.
 */
export const Route = createFileRoute("/billing")({
	validateSearch: (search: Record<string, unknown>): { state?: "processing" } => ({
		state: search.state === "processing" ? "processing" : undefined,
	}),
	beforeLoad: ({ context }) => {
		if (!context.me) throw redirect({ to: "/sign-in", search: { redirect: "/billing" } });
		// Guests (people working in projects shared with them) come here to add one of their own.
		if (context.me.billing !== "required" && context.me.billing !== "guest" && !context.me.banned) throw redirect({ to: "/projects" });
		return { me: context.me };
	},
	head: () => ({ meta: [{ title: "Set up billing · Retween" }] }),
	component: Billing,
});

function Billing() {
	const { me } = Route.useRouteContext();
	const { state } = Route.useSearch();
	if (me.banned) {
		return (
			<Slate kind="Account suspended" title="This account is suspended.">
				<p>Contact an administrator if you think this is a mistake.</p>
				<div className="choices">
					<button type="button" className="btn quiet" onClick={() => void signOut()}>
						Sign out
					</button>
				</div>
			</Slate>
		);
	}
	return (
		<Slate kind="One step left" title={state === "processing" ? "Your payment method is being confirmed." : "Add a payment method to start."}>
			{state === "processing" ? (
				<p>Some payment methods take a moment to confirm. This page lets you in as soon as Stripe does; reload it in a minute, or add a card instead.</p>
			) : (
				<p>
					Retween bills {me.email} once a month, on the 2nd, for what the previous month used: voice, generated media, rendering and storage. Nothing is
					charged now, and there is no subscription. Every account has a spend cap ({usd(me.budget.monthlyBudgetUsd)} a month to start), so a bill can never
					run past it, and you can set a lower one yourself.
				</p>
			)}
			<div className="choices">
				{/* A plain link: the server creates the Stripe Checkout page and redirects to it. */}
				<a className="btn" href="/api/billing/setup">
					{state === "processing" ? "Add a different payment method" : "Add a payment method"}
				</a>
				{me.billing === "guest" ? (
					<a className="btn quiet" href="/projects">
						Back to shared projects
					</a>
				) : (
					<button type="button" className="btn quiet" onClick={() => void signOut()}>
						Sign out
					</button>
				)}
			</div>
			{me.billing === "guest" && (
				<p className="soft" style={{ marginTop: 14 }}>
					Working in projects shared with you is free. A payment method lets you create projects of your own and generate, render and publish: what you start is
					billed to you.
				</p>
			)}
			<p className="soft" style={{ marginTop: 14 }}>
				Payments are handled by Stripe. Retween never sees your card number.
			</p>
		</Slate>
	);
}
