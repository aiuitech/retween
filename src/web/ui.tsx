import { type ReactNode, useEffect, useState } from "react";

export function Track({ keys = [0.08, 0.34, 0.61, 0.92], on = [0, 3] }: { keys?: number[]; on?: number[] }) {
	return (
		<div className="track" aria-hidden="true">
			{keys.map((at, i) => (
				<span key={at} className={`key${on.includes(i) ? " on" : ""}`} style={{ left: `${at * 100}%` }} />
			))}
			<span className="head" />
		</div>
	);
}

export function Section({ index, title, note, children }: { index: string; title: string; note?: string; children: ReactNode }) {
	return (
		<section className="section">
			<header>
				<div className="label">{index}</div>
				<h2>{title}</h2>
				{note && <p>{note}</p>}
			</header>
			<div className="body">{children}</div>
		</section>
	);
}

export function Snippet({ children }: { children: string }) {
	const [copied, setCopied] = useState(false);
	return (
		<div className="snippet">
			<button
				type="button"
				onClick={() => {
					void navigator.clipboard.writeText(children);
					setCopied(true);
					setTimeout(() => setCopied(false), 1400);
				}}
			>
				{copied ? "Copied" : "Copy"}
			</button>
			{children}
		</div>
	);
}

export function Avatar({ name, image }: { name: string; image?: string | null }) {
	return image ? (
		<img src={image} alt="" referrerPolicy="no-referrer" />
	) : (
		<span className="avatar">{name.slice(0, 1).toUpperCase()}</span>
	);
}

/** Loads data once and exposes a reload; errors come back as a message. */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[] = []) {
	const [data, setData] = useState<T | undefined>();
	const [error, setError] = useState<string | undefined>();
	const [tick, setTick] = useState(0);
	useEffect(() => {
		let live = true;
		load()
			.then((value) => live && (setData(value), setError(undefined)))
			.catch((reason: Error) => live && setError(reason.message));
		return () => {
			live = false;
		};
		// biome-ignore lint/correctness/useExhaustiveDependencies: reload is driven by `tick`
	}, [tick, ...deps]);
	return { data, error, reload: () => setTick((n) => n + 1) };
}

export function Slate({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className="stage">
			<div className="slate">
				<div className="bar" />
				<div className="in">
					<div className="label">{label}</div>
					{children}
				</div>
			</div>
		</div>
	);
}
