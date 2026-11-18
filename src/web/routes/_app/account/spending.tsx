import { createFileRoute } from "@tanstack/react-router";
import { type ReactNode, useEffect, useState } from "react";
import { op, usd } from "../../../api.ts";
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

export const Route = createFileRoute("/_app/account/spending")({
	loader: () => op<ControlsResult>("account.controls"),
	component: Spending,
});

function Spending() {
	const { me } = Route.useRouteContext();
	const { controls, options } = Route.useLoaderData();
	const { busy, act } = useAct();
	const { budget } = me;
	const spent = budget.monthlyBudgetUsd ? Math.min(1, budget.spentThisMonthUsd / budget.monthlyBudgetUsd) : 0;
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
						<p>Generating and rendering draw on a monthly allowance set by an administrator. It resets on the first of the month.</p>
					</div>
				</div>
				<dl className="figures">
					<div>
						<dt>Spent</dt>
						<dd>{usd(budget.spentThisMonthUsd)}</dd>
					</div>
					<div>
						<dt>Left</dt>
						<dd>{usd(budget.remainingUsd)}</dd>
					</div>
					<div>
						<dt>Allowance</dt>
						<dd>{usd(budget.monthlyBudgetUsd)}</dd>
					</div>
				</dl>
				<div className="meter" style={{ marginTop: 14 }} role="img" aria-label={`${Math.round(spent * 100)}% of this month's allowance used`}>
					<i className={spent > 0.85 ? "hot" : ""} style={{ width: `${spent * 100}%` }} />
				</div>
				<p className="soft" style={{ marginTop: 10 }}>
					{budget.ownLimitUsd !== undefined && `Your own limit of ${usd(budget.ownLimitUsd)} applies. `}
					Charges are what each vendor bills for your requests, including render time and storage.
				</p>
			</section>

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
							<div className="soft">Stops paid work at this amount in US dollars, even if your allowance is higher. Leave empty for none.</div>
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
