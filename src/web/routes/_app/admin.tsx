import { Link, createFileRoute, notFound, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { op, plural, sizeOf, usd, when, whenExactly } from "../../api.ts";
import { Avatar, Confirm, Empty, Menu, Status, useAct } from "../../ui.tsx";

interface UserRow {
	id: string;
	email: string;
	name: string;
	image: string | null;
	role: "admin" | "user";
	superuser: boolean;
	billing: "exempt" | "active" | "none" | "past_due";
	banned: boolean;
	monthlyBudgetUsd: number;
	spentThisMonthUsd: number;
	creditUsd: number;
	projects: number;
	createdAt: string;
}
interface Stats {
	users: number;
	projects: number;
	videos: number;
	finishedRenders: number;
	storedBytes: number;
	spendThisMonthUsd: number;
	chargesThisMonthUsd: number;
	markup: number;
	spendByKind: { kind: string; usd: number; events: number }[];
}
interface UsageEvent {
	id: string;
	at: string;
	email: string;
	kind: string;
	provider: string;
	model: string | null;
	quantity: number;
	unit: string;
	usd: number;
	estimated: boolean;
}

const FILTERS = [
	["all", "Everyone"],
	["no_billing", "No billing"],
	["active", "Paying"],
	["past_due", "Past due"],
	["banned", "Suspended"],
] as const;
type Filter = (typeof FILTERS)[number][0];

export const Route = createFileRoute("/_app/admin")({
	validateSearch: (search: Record<string, unknown>): { show?: Filter; q?: string } => ({
		show: FILTERS.map(([key]) => key).find((key) => key === search.show && key !== "all"),
		q: typeof search.q === "string" && search.q ? search.q : undefined,
	}),
	beforeLoad: ({ context }) => {
		// Administrators only; to everyone else this page does not exist.
		if (!context.me.isAdmin) throw notFound();
	},
	loaderDeps: ({ search }) => search,
	loader: async ({ deps }) => {
		const [stats, users, usage] = await Promise.all([
			op<Stats>("admin.stats"),
			op<{ users: UserRow[]; total: number; noBilling: number; pastDue: number }>("admin.users", { status: deps.show, search: deps.q }),
			op<{ events: UsageEvent[] }>("admin.usage", { limit: 40 }),
		]);
		return { stats, users, events: usage.events };
	},
	head: () => ({ meta: [{ title: "Admin · Retween" }] }),
	component: Admin,
});

function Admin() {
	const { me } = Route.useRouteContext();
	const { stats, users, events } = Route.useLoaderData();
	const search = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });
	const { busy, act } = useAct();
	const [query, setQuery] = useState(search.q ?? "");
	const [deleting, setDeleting] = useState<UserRow | null>(null);
	const [budgeting, setBudgeting] = useState<UserRow | null>(null);
	const [crediting, setCrediting] = useState<UserRow | null>(null);

	useEffect(() => {
		if (query === (search.q ?? "")) return;
		const timer = setTimeout(() => void navigate({ search: (prev) => ({ ...prev, q: query || undefined }), replace: true }), 250);
		return () => clearTimeout(timer);
	}, [query, search.q, navigate]);

	const change = (user: UserRow, patch: object, done: string) => act(() => op("admin.user_update", { userId: user.id, ...patch }), done);

	return (
		<main className="page">
			<div className="head">
				<div className="words">
					<h1>Admin</h1>
					<p>Totals across every account for this calendar month. Cost is what vendors charged; charges are what accounts are billed (× {stats.markup}).</p>
				</div>
			</div>

			<dl className="figures" style={{ marginTop: 24 }}>
				{[
					["People", stats.users],
					["Projects", stats.projects],
					["Videos", stats.videos],
					["Exports", stats.finishedRenders],
					["Cost", usd(stats.spendThisMonthUsd)],
					["Charges", usd(stats.chargesThisMonthUsd)],
					["Stored", sizeOf(stats.storedBytes)],
				].map(([label, value]) => (
					<div key={label}>
						<dt>{label}</dt>
						<dd>{value}</dd>
					</div>
				))}
			</dl>
			{stats.spendByKind.length > 0 && (
				<div className="facts" style={{ marginTop: 12 }}>
					{stats.spendByKind.map((row) => (
						<span key={row.kind}>
							{row.kind} {usd(row.usd)} ({row.events})
						</span>
					))}
				</div>
			)}

			<section className="block">
				<div className="block-head">
					<div>
						<h2>People</h2>
						<p>
							People get in by adding a payment method, and are invoiced on the 2nd for the month before. Each account has a monthly spend cap (in billed
							dollars); credit is used before their card is charged. Suspending someone signs them out everywhere.
						</p>
					</div>
				</div>
				<div className="toolbar" style={{ marginTop: 0 }}>
					<div className="chips">
						{FILTERS.map(([key, label]) => (
							<Link key={key} from={Route.fullPath} search={(prev) => ({ ...prev, show: key === "all" ? undefined : key })} aria-current={(search.show ?? "all") === key ? "true" : undefined}>
								{label}
								{key === "no_billing" && users.noBilling ? ` (${users.noBilling})` : ""}
								{key === "past_due" && users.pastDue ? ` (${users.pastDue})` : ""}
							</Link>
						))}
					</div>
					<input type="search" className="search" placeholder="Search by name or email" value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Search people" />
				</div>
				{users.users.length === 0 ? (
					<Empty title="No one matches">Try another filter or a shorter search.</Empty>
				) : (
					<div className="lines">
						{users.users.map((user) => {
							const locked = user.id === me.id || user.superuser;
							return (
								<div className="line" key={user.id}>
									<Avatar name={user.name || user.email} image={user.image} />
									<div className="grow">
										<div className="title clip">
											{user.name || user.email} {user.id === me.id && <span className="softer">(you)</span>}
										</div>
										<div className="facts">
											<span>{user.email}</span>
											<span>Joined {when(user.createdAt)}</span>
											<span>{plural(user.projects, "project")}</span>
											<span>
												{usd(user.spentThisMonthUsd)} of {usd(user.monthlyBudgetUsd)} cap this month
											</span>
											{user.creditUsd > 0 && <span>{usd(user.creditUsd)} credit</span>}
										</div>
									</div>
									{user.banned ? (
										<Status tone="bad">Suspended</Status>
									) : user.role === "admin" ? (
										<Status tone="ok">{user.superuser ? "Superuser" : "Administrator"}</Status>
									) : user.billing === "past_due" ? (
										<Status tone="bad">Past due</Status>
									) : user.billing === "active" ? (
										<Status tone="ok">Paying</Status>
									) : (
										<Status tone="warn">No billing</Status>
									)}
									<div className="acts">
										<Menu label={`Actions for ${user.email}`}>
											<button type="button" onClick={() => setBudgeting(user)}>
												Change spend cap
											</button>
											{me.isSuperuser && (
												<button type="button" onClick={() => setCrediting(user)}>
													Give credit
												</button>
											)}
											{!locked && !user.banned && (
												<button type="button" onClick={() => void change(user, { role: user.role === "admin" ? "user" : "admin" }, user.role === "admin" ? "Removed administrator" : "Made administrator")}>
													{user.role === "admin" ? "Remove administrator" : "Make administrator"}
												</button>
											)}
											{!locked && (
												<>
													<button type="button" onClick={() => void change(user, { banned: !user.banned }, user.banned ? "Restored account" : "Suspended account")}>
														{user.banned ? "Restore account" : "Suspend account"}
													</button>
													<hr />
													<button type="button" className="danger" onClick={() => setDeleting(user)}>
														Delete account
													</button>
												</>
											)}
										</Menu>
									</div>
								</div>
							);
						})}
					</div>
				)}
			</section>

			<section className="block">
				<div className="block-head">
					<div>
						<h2>Recent charges</h2>
						<p>The latest generation and render charges across all accounts.</p>
					</div>
				</div>
				{events.length === 0 ? (
					<Empty title="Nothing has been generated yet" />
				) : (
					<div className="lines">
						{events.map((event) => (
							<div className="line" key={event.id}>
								<span className="tag" style={{ width: 86, textAlign: "center" }}>
									{event.kind}
								</span>
								<div className="grow">
									<div className="title clip">{event.email}</div>
									<div className="facts">
										<span>{whenExactly(event.at)}</span>
										<span>
											{event.quantity} {event.unit}
										</span>
										<span>{event.model ?? event.provider}</span>
									</div>
								</div>
								<span className="num">
									{event.estimated ? "about " : ""}${event.usd.toFixed(4)}
								</span>
							</div>
						))}
					</div>
				)}
			</section>

			{budgeting && <Allowance user={budgeting} onClose={() => setBudgeting(null)} />}
			{crediting && <Credit user={crediting} onClose={() => setCrediting(null)} />}
			{deleting && (
				<Confirm
					open
					onClose={() => setDeleting(null)}
					title="Delete this account?"
					action="Delete account"
					phrase={deleting.email}
					busy={busy}
					onConfirm={async () => {
						if (await act(() => op("admin.user_delete", { userId: deleting.id, confirm: true }), "Deleted account")) setDeleting(null);
					}}
				>
					{deleting.email} will be deleted with everything they made: {plural(deleting.projects, "project")}, with all files, videos and exports. This cannot be undone.
				</Confirm>
			)}
		</main>
	);
}

function Allowance({ user, onClose }: { user: UserRow; onClose: () => void }) {
	const { busy, act } = useAct();
	const [value, setValue] = useState(String(user.monthlyBudgetUsd));
	const amount = Number(value);
	const valid = value.trim() !== "" && Number.isFinite(amount) && amount >= 0;
	return (
		<Confirm.Form
			title="Change spend cap"
			onClose={onClose}
			busy={busy || !valid || amount === user.monthlyBudgetUsd}
			action="Save cap"
			onSubmit={async () => {
				if (await act(() => op("admin.user_update", { userId: user.id, monthlyBudgetUsd: amount }), "Saved spend cap")) onClose();
			}}
		>
			<label className="field">
				<span className="name">Monthly spend cap for {user.name || user.email}, in billed US dollars</span>
				<input inputMode="decimal" value={value} onChange={(event) => setValue(event.target.value)} autoFocus />
				<span className="hint">They have been charged {usd(user.spentThisMonthUsd)} so far this month. Paid work stops at the cap (plus any credit).</span>
			</label>
		</Confirm.Form>
	);
}

function Credit({ user, onClose }: { user: UserRow; onClose: () => void }) {
	const { busy, act } = useAct();
	const [value, setValue] = useState("");
	const [note, setNote] = useState("");
	const amount = Number(value);
	const valid = value.trim() !== "" && Number.isFinite(amount) && amount !== 0 && amount >= -user.creditUsd;
	return (
		<Confirm.Form
			title="Give credit"
			onClose={onClose}
			busy={busy || !valid}
			action={amount < 0 ? "Take back credit" : "Give credit"}
			onSubmit={async () => {
				const done = await act(
					() => op("admin.credit_grant", { userId: user.id, amountUsd: amount, note: note.trim() || undefined }),
					amount < 0 ? "Took back credit" : "Gave credit",
				);
				if (done) onClose();
			}}
		>
			<label className="field">
				<span className="name">Credit for {user.name || user.email}, in US dollars</span>
				<input inputMode="decimal" placeholder="20" value={value} onChange={(event) => setValue(event.target.value)} autoFocus />
				<span className="hint">
					They have {usd(user.creditUsd)} unspent. Credit is used before their payment method is charged. A negative amount takes unspent credit back.
				</span>
			</label>
			<label className="field">
				<span className="name">Note (optional)</span>
				<input value={note} maxLength={300} placeholder="Why, e.g. refund for a failed render" onChange={(event) => setNote(event.target.value)} />
			</label>
		</Confirm.Form>
	);
}
