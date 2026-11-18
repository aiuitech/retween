import { createFileRoute } from "@tanstack/react-router";
import { type ReactNode, useEffect, useState } from "react";
import { op, usd, when } from "../../../api.ts";
import { forgetMe } from "../../../session.ts";
import { useAct } from "../../../ui.tsx";

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
	options: { voiceModels: { id: string; label: string }[]; imageQualities: string[]; clipResolutions: string[]; renderResolutions: string[] };
}

interface Spend {
	month: string;
	asOf: string;
	chargesUsd: number;
	byKind: { kind: string; label: string; quantity?: number; unit?: string; chargeUsd: number }[];
	byProject: { projectId?: string; name: string; chargeUsd: number }[];
	creditUsd: number;
	estimatedBillUsd: number;
	invoice?: { status: string; issuedOn?: string };
	billing: { status: string; manageUrl?: string };
	recentInvoices: { period: string; status: string; chargeUsd: number; creditUsd: number; amountDueUsd: number; url?: string }[];
}

const INVOICE_STATUS: Record<string, string> = {
	open: "Being collected",
	paid: "Paid",
	failed: "Payment failed",
	void: "Void",
	uncollectible: "Unpaid",
	credited: "Covered by credit",
	no_charge: "Nothing to pay",
	skipped: "Not billed",
	draft: "Being prepared",
};

const monthName = (period: string) => new Date(`${period}-01T00:00:00Z`).toLocaleString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });

export const Route = createFileRoute("/_app/account/spending")({
	loader: async () => {
		const [controls, spend] = await Promise.all([op<ControlsResult>("account.controls"), op<Spend>("billing.spend")]);
		return { ...controls, spend };
	},
	component: Spending,
});

function Spending() {
	const { me } = Route.useRouteContext();
	const { controls, options, spend } = Route.useLoaderData();
	const { busy, act } = useAct();
	const { budget } = me;
	const cap = budget.ownLimitUsd ?? budget.monthlyBudgetUsd;
	const spent = cap ? Math.min(1, budget.estimatedBillUsd / cap) : 0;
	const exempt = me.billing === "exempt";
	const [limit, setLimit] = useState("");
	const savedLimit = controls.monthlyLimitUsd === null ? "" : String(controls.monthlyLimitUsd);
	useEffect(() => setLimit(savedLimit), [savedLimit]);

	const save = (change: Partial<Controls>) =>
		act(async () => {
			await op("account.controls_update", change);
			forgetMe();
		}, "Saved changes");

	const toggle = (key: keyof Controls, title: string, note: string, extra?: ReactNode) => (
		<div className="line control">
			<input type="checkbox" id={`control-${key}`} checked={Boolean(controls[key])} disabled={busy} onChange={(event) => void save({ [key]: event.target.checked })} />
			<label className="grow" htmlFor={`control-${key}`}>
				<div className="title">{title}</div>
				<div className="soft">{note}</div>
			</label>
			{extra}
		</div>
	);
	const choose = (key: keyof Controls, label: string, values: { value: string; label: string }[], disabled = false) => (
		<select className="compact" value={String(controls[key] ?? "")} disabled={disabled || busy} aria-label={label} onChange={(event) => void save({ [key]: event.target.value || null })}>
			{values.map((option) => (
				<option key={option.value} value={option.value}>
					{option.label}
				</option>
			))}
		</select>
	);
	const upTo = (values: string[]) => values.map((value) => ({ value, label: `Up to ${value}` }));

	return (
		<>
			<section className="block">
				<div className="block-head">
					<div>
						<h2>This month</h2>
						<p>
							{exempt
								? "Administrator accounts are not billed. Charges still count against the spend cap."
								: `Charges as they will be billed, up to the last request. ${monthName(spend.month)} is invoiced on ${spend.invoice?.issuedOn ? when(spend.invoice.issuedOn) : "the 2nd"} and charged to your payment method.`}
						</p>
					</div>
					{spend.billing.manageUrl && (
						<a className="btn quiet small" href={spend.billing.manageUrl}>
							Payment method and invoices
						</a>
					)}
				</div>
				{me.billing === "past_due" && (
					<p className="note bad" style={{ marginBottom: 14 }}>
						An invoice could not be collected, so paid work is paused. Update your payment method and it is retried at once.
					</p>
				)}
				<dl className="figures">
					<div>
						<dt>Charges so far</dt>
						<dd>{usd(spend.chargesUsd)}</dd>
					</div>
					<div>
						<dt>Credit</dt>
						<dd>{usd(spend.creditUsd)}</dd>
					</div>
					<div>
						<dt>Estimated bill</dt>
						<dd>{usd(spend.estimatedBillUsd)}</dd>
					</div>
					<div>
						<dt>Spend cap</dt>
						<dd>{usd(cap)}</dd>
					</div>
				</dl>
				<div className="meter" style={{ marginTop: 14 }} role="img" aria-label={`${Math.round(spent * 100)}% of this month's spend cap used`}>
					<i className={spent > 0.85 ? "hot" : ""} style={{ width: `${spent * 100}%` }} />
				</div>
				<p className="soft" style={{ marginTop: 10 }}>
					{usd(budget.remainingUsd)} left before the cap stops paid work this month.{" "}
					{budget.ownLimitUsd !== undefined ? `Your own limit of ${usd(budget.ownLimitUsd)} applies. ` : "An administrator can raise the cap. "}
					Credit is used before your payment method is charged.
				</p>
				{spend.byKind.length > 0 && (
					<div className="lines" style={{ marginTop: 14 }}>
						{spend.byKind.map((line) => (
							<div className="line" key={line.kind}>
								<div className="grow">
									<div className="title">{line.label}</div>
									{line.unit && <div className="soft">{`${line.quantity?.toLocaleString("en-US")} ${line.unit}`}</div>}
								</div>
								<span className="num">{usd(line.chargeUsd)}</span>
							</div>
						))}
					</div>
				)}
				{spend.byProject.length > 1 && (
					<div className="facts" style={{ marginTop: 12 }}>
						{spend.byProject.map((row) => (
							<span key={row.projectId ?? "account"}>
								{row.name} {usd(row.chargeUsd)}
							</span>
						))}
					</div>
				)}
			</section>

			{spend.recentInvoices.length > 0 && (
				<section className="block">
					<div className="block-head">
						<div>
							<h2>Invoices</h2>
							<p>One a month, for the month before.</p>
						</div>
					</div>
					<div className="lines">
						{spend.recentInvoices.map((invoice) => (
							<div className="line" key={invoice.period}>
								<div className="grow">
									<div className="title">{monthName(invoice.period)}</div>
									<div className="facts">
										<span>{INVOICE_STATUS[invoice.status] ?? invoice.status}</span>
										<span>Charges {usd(invoice.chargeUsd)}</span>
										{invoice.creditUsd > 0 && <span>Credit {usd(invoice.creditUsd)}</span>}
									</div>
								</div>
								<span className="num">{usd(invoice.amountDueUsd)}</span>
								{invoice.url && (
									<a className="btn quiet small" href={invoice.url} target="_blank" rel="noreferrer">
										View
									</a>
								)}
							</div>
						))}
					</div>
				</section>
			)}

			<section className="block">
				<div className="block-head">
					<div>
						<h2>Cost controls</h2>
						<p>Choose what your videos may spend money on. Anything switched off is replaced by a cheaper stand-in when a video is prepared. Nothing already made is regenerated.</p>
					</div>
				</div>
				<div className="lines">
					{toggle(
						"clips",
						"Generated video clips",
						"By far the most expensive media. Off: clip scenes use a still instead.",
						choose("clipMaxResolution", "Largest generated clip", upTo(options.clipResolutions), !controls.clips),
					)}
					{toggle(
						"images",
						"Generated images",
						"Off: scenes fall back to the brand backdrop. Lower quality costs less.",
						choose("imageMaxQuality", "Highest image quality", upTo(options.imageQualities), !controls.images),
					)}
					{toggle("vectors", "Vector illustrations", "Flat illustrations that draw themselves on.")}
					{controls.vectors && toggle("vectorPro", "Pro vector model", "Sharper detail at about four times the price.")}
					{toggle("cutouts", "Cut-outs", "Lifts a subject off its background for depth effects.")}
					{toggle("music", "Generated music", "Off: videos have no music bed unless you upload one.")}
					{toggle("soundEffects", "Generated sound effects", "Whooshes, chimes and ambience named in the storyboard.")}
					<div className="line control">
						<span className="indent" />
						<div className="grow">
							<div className="title">Narration voice model</div>
							<div className="soft">Flash and Turbo cost half as much per character.</div>
						</div>
						{choose("narrationModel", "Narration voice model", [{ value: "", label: "Follow the brand kit" }, ...options.voiceModels.map((model) => ({ value: model.id, label: model.label }))])}
					</div>
					<div className="line control">
						<span className="indent" />
						<div className="grow">
							<div className="title">Largest export</div>
							<div className="soft">Bigger exports take longer to render, and render time is charged.</div>
						</div>
						{choose("renderMaxResolution", "Largest export", upTo(options.renderResolutions))}
					</div>
					<form
						className="line control"
						onSubmit={(event) => {
							event.preventDefault();
							const value = limit.trim() === "" ? null : Number(limit);
							if (value === null || (Number.isFinite(value) && value >= 0)) void save({ monthlyLimitUsd: value });
						}}
					>
						<span className="indent" />
						<label className="grow" htmlFor="own-limit">
							<div className="title">Your own monthly limit</div>
							<div className="soft">Stops paid work at this amount in US dollars, below the spend cap. Leave empty to use the cap.</div>
						</label>
						<input id="own-limit" className="compact" inputMode="decimal" placeholder="No limit" value={limit} onChange={(event) => setLimit(event.target.value)} />
						<button className="btn quiet small" type="submit" disabled={busy || limit.trim() === savedLimit}>
							Set limit
						</button>
					</form>
				</div>
			</section>
		</>
	);
}
