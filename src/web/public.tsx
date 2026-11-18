import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { Mark } from "./ui.tsx";

export function Wordmark() {
	return (
		<Link className="wordmark" to="/">
			<Mark />
			retween
		</Link>
	);
}

/** A single-purpose screen: consent, command-line sign-in, waiting for approval. */
export function Slate({ kind, title, children }: { kind: string; title: ReactNode; children: ReactNode }) {
	return (
		<>
			<div className="welcome" style={{ paddingBottom: 0 }}>
				<div className="welcome-top">
					<Wordmark />
				</div>
			</div>
			<div className="stage">
				<div className="cel slate">
					<p className="kind">{kind}</p>
					<h1>{title}</h1>
					{children}
				</div>
			</div>
		</>
	);
}
