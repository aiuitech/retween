import { useState } from "react";
import { type Me, op, usd, when } from "../api.ts";
import { Avatar, Section, useLoad } from "../ui.tsx";

interface UserRow {
	id: string;
	email: string;
	name: string;
	image: string | null;
	role: "admin" | "user";
	superuser: boolean;
	approved: boolean;
	banned: boolean;
	monthlyBudgetUsd: number;
	spentThisMonthUsd: number;
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
	["pending", "Waiting"],
	["approved", "Approved"],
	["banned", "Suspended"],
] as const;

export function Admin({ me }: { me: Me }) {
	const [filter, setFilter] = useState<(typeof FILTERS)[number][0]>("all");
	const [search, setSearch] = useState("");
	const [error, setError] = useState("");
	const stats = useLoad(() => op<Stats>("admin.stats"));
	const users = useLoad(
		() => op<{ users: UserRow[]; total: number; pendingApproval: number }>("admin.users", { status: filter === "all" ? undefined : filter, search: search || undefined }),
		[filter, search],
	);
	const usage = useLoad(() => op<{ events: UsageEvent[] }>("admin.usage", { limit: 40 }));

	const change = async (userId: string, patch: object) => {
		setError("");
		try {
			await op("admin.user_update", { userId, ...patch });
			users.reload();
			stats.reload();
		} catch (reason) {
			setError((reason as Error).message);
		}
	};
	const remove = async (user: UserRow) => {
		if (!confirm(`Delete ${user.email} and everything they made? This cannot be undone.`)) return;
		setError("");
		try {
			await op("admin.user_delete", { userId: user.id, confirm: true });
			users.reload();
			stats.reload();
		} catch (reason) {
			setError((reason as Error).message);
		}
	};

	return (
		<>
			<Section index="A" title="Service" note="Totals across every account. Spend covers this calendar month.">
				<div className="figures">
					{[
						["Users", stats.data?.users],
						["Projects", stats.data?.projects],
						["Videos", stats.data?.videos],
						["Renders", stats.data?.finishedRenders],
						["Spend", stats.data ? usd(stats.data.spendThisMonthUsd) : undefined],
						["Stored", stats.data ? (stats.data.storedBytes >= 1e9 ? `${(stats.data.storedBytes / 1e9).toFixed(1)} GB` : `${Math.round(stats.data.storedBytes / 1e6)} MB`) : undefined],
					].map(([label, value]) => (
						<div key={label as string}>
							<span className="label">{label}</span>
							<b>{value ?? "–"}</b>
						</div>
					))}
				</div>
				{stats.data?.spendByKind.length ? (
					<p className="mono faint">{stats.data.spendByKind.map((row) => `${row.kind} ${usd(row.usd)} (${row.events})`).join("  ·  ")}</p>
				) : null}
			</Section>

			<Section
				index="B"
				title="People"
				note="New sign-ins wait here until approved. Each person has a monthly generation allowance; suspending someone signs them out everywhere."
			>
				{error && <div className="notice">{error}</div>}
				<div className="filters">
					{FILTERS.map(([key, label]) => (
						<button type="button" key={key} className="tab" aria-current={filter === key ? "page" : undefined} onClick={() => setFilter(key)}>
							{label}
							{key === "pending" && users.data?.pendingApproval ? ` (${users.data.pendingApproval})` : ""}
						</button>
					))}
					<input placeholder="Search name or email" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search users" />
				</div>
				<div className="rows">
					{users.error && <div className="notice">{users.error}</div>}
					{users.data?.users.length === 0 && <div className="empty">No one matches.</div>}
					{(users.data?.users ?? []).map((user) => (
						<div className="row" key={user.id}>
							<Avatar name={user.name || user.email} image={user.image} />
							<div className="grow">
								<div className="title">
									{user.name || user.email} {user.id === me.id && <span className="faint">(you)</span>}
								</div>
								<div className="faint mono">
									{user.email} · joined {when(user.createdAt)} · {user.projects} project{user.projects === 1 ? "" : "s"} · {usd(user.spentThisMonthUsd)} of{" "}
									<Budget user={user} onSave={(value) => change(user.id, { monthlyBudgetUsd: value })} />
								</div>
							</div>
							{user.banned ? (
								<span className="pill signal">Suspended</span>
							) : user.role === "admin" ? (
								<span className="pill solid">{user.superuser ? "Superuser" : "Admin"}</span>
							) : user.approved ? (
								<span className="pill ok">Approved</span>
							) : (
								<span className="pill signal">Waiting</span>
							)}
							<div className="actions">
								{!user.approved && !user.banned && (
									<button type="button" className="btn small" onClick={() => change(user.id, { approved: true })}>
										Approve
									</button>
								)}
								{user.id !== me.id && !user.superuser && (
									<>
										{user.approved && user.role !== "admin" && !user.banned && (
											<button type="button" className="btn small ghost" onClick={() => change(user.id, { approved: false })}>
												Revoke
											</button>
										)}
										{!user.banned && (
											<button type="button" className="btn small ghost" onClick={() => change(user.id, { role: user.role === "admin" ? "user" : "admin" })}>
												{user.role === "admin" ? "Remove admin" : "Make admin"}
											</button>
										)}
										<button type="button" className="btn small ghost" onClick={() => change(user.id, { banned: !user.banned })}>
											{user.banned ? "Restore" : "Suspend"}
										</button>
										<button type="button" className="btn small ghost danger" onClick={() => remove(user)}>
											Delete
										</button>
									</>
								)}
							</div>
						</div>
					))}
				</div>
			</Section>

			<Section index="C" title="Activity" note="The most recent generation and render charges.">
				<div className="rows">
					{usage.data?.events.length === 0 && <div className="empty">Nothing has been generated yet.</div>}
					{(usage.data?.events ?? []).map((event) => (
						<div className="row" key={event.id}>
							<span className="pill" style={{ width: 74, textAlign: "center" }}>
								{event.kind}
							</span>
							<div className="grow">
								<div className="title">{event.email}</div>
								<div className="faint mono">
									{new Date(event.at).toLocaleString()} · {event.quantity} {event.unit} · {event.model ?? event.provider}
								</div>
							</div>
							<span className="mono">
								{event.estimated ? "≈ " : ""}${event.usd.toFixed(4)}
							</span>
						</div>
					))}
				</div>
			</Section>
		</>
	);
}

/** Inline-editable monthly allowance. */
function Budget({ user, onSave }: { user: UserRow; onSave: (value: number) => void }) {
	const [editing, setEditing] = useState(false);
	const [value, setValue] = useState(String(user.monthlyBudgetUsd));
	if (!editing) {
		return (
			<button
				type="button"
				onClick={() => setEditing(true)}
				title="Change monthly allowance"
				style={{ font: "inherit", color: "inherit", background: "none", border: 0, borderBottom: "1px dashed currentColor", padding: 0, cursor: "pointer" }}
			>
				{usd(user.monthlyBudgetUsd)}/mo
			</button>
		);
	}
	const commit = () => {
		const amount = Number(value);
		if (Number.isFinite(amount) && amount >= 0 && amount !== user.monthlyBudgetUsd) onSave(amount);
		setEditing(false);
	};
	return (
		<input
			value={value}
			onChange={(e) => setValue(e.target.value)}
			onBlur={commit}
			onKeyDown={(e) => (e.key === "Enter" ? commit() : e.key === "Escape" ? setEditing(false) : undefined)}
			inputMode="decimal"
			aria-label="Monthly allowance in dollars"
			style={{ width: 70, padding: "0 2px", font: "inherit" }}
			autoFocus
		/>
	);
}
