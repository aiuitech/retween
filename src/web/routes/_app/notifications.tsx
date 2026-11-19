import { Link, createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";
import { op, whenExactly } from "../../api.ts";
import { forgetMe } from "../../session.ts";
import type { NotificationRow } from "../../types.ts";
import { Empty, useAct } from "../../ui.tsx";

export const Route = createFileRoute("/_app/notifications")({
	loader: () => op<{ notifications: NotificationRow[]; unread: number }>("notification.list", { limit: 100 }),
	head: () => ({ meta: [{ title: "Inbox · Retween" }] }),
	component: Inbox,
});

function Inbox() {
	const { notifications, unread } = Route.useLoaderData();
	const { busy, act } = useAct();
	// The count in the top bar comes from the cached account; let the next page ask again.
	useEffect(() => forgetMe(), []);
	return (
		<main className="page narrow">
			<div className="head">
				<div className="words">
					<h1>Inbox</h1>
					<p>
						Projects shared with you, people joining yours, review notes and finished exports. <Link to="/account/notifications">Choose which are emailed</Link>.
					</p>
				</div>
				<div className="acts">
					{unread > 0 && (
						<button type="button" className="btn quiet" disabled={busy} onClick={() => void act(() => op("notification.read", {}).then(forgetMe), "Marked all read")}>
							Mark all read
						</button>
					)}
				</div>
			</div>
			<div className="block">
				{notifications.length === 0 ? (
					<Empty title="Nothing yet">When someone shares a project with you, sends review notes or an export finishes, it shows up here.</Empty>
				) : (
					<div className="lines">
						{notifications.map((item) => (
							<div className={`line${item.link ? " go" : ""}`} key={item.id}>
								<span className={`dot${item.read ? " read" : ""}`} aria-label={item.read ? undefined : "Unread"} />
								<div className="grow">
									{item.link ? (
										<a
											className="cover title"
											href={item.link}
											onClick={() => {
												if (!item.read) void op("notification.read", { ids: [item.id] }).then(forgetMe);
											}}
										>
											{item.title}
										</a>
									) : (
										<div className="title">{item.title}</div>
									)}
									{item.body && <div className="soft">{item.body}</div>}
								</div>
								<div className="facts">
									<span>{whenExactly(item.createdAt)}</span>
								</div>
							</div>
						))}
					</div>
				)}
			</div>
		</main>
	);
}
