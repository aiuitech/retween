import { createFileRoute } from "@tanstack/react-router";
import { op } from "../../../api.ts";
import { useAct } from "../../../ui.tsx";

interface Setting {
	kind: string;
	label: string;
	description: string;
	email: boolean;
}

export const Route = createFileRoute("/_app/account/notifications")({
	loader: () => op<{ email: Setting[] }>("notification.settings"),
	component: NotificationSettings,
});

function NotificationSettings() {
	const { email } = Route.useLoaderData();
	const { busy, act } = useAct();
	return (
		<section className="block">
			<div className="block-head">
				<div>
					<h2>Notification emails</h2>
					<p>Everything appears in your inbox here. Choose what is also sent to you by email.</p>
				</div>
			</div>
			<div className="lines" style={{ marginTop: 12 }}>
				{email.map((setting) => (
					<label className="line toggle-line" key={setting.kind}>
						<input
							type="checkbox"
							checked={setting.email}
							disabled={busy}
							onChange={(event) => void act(() => op("notification.settings_update", { email: { [setting.kind]: event.target.checked } }), "Saved")}
						/>
						<span className="grow">
							<span className="title">{setting.label}</span>
							<span className="soft" style={{ display: "block" }}>
								{setting.description}
							</span>
						</span>
					</label>
				))}
			</div>
		</section>
	);
}
