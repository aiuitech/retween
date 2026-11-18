import { Link, useRouter } from "@tanstack/react-router";
import { type ReactNode, createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState } from "react";

/** The mark: two keys and the in-betweens, spaced the way an animator eases them. */
export function Mark({ size = 26 }: { size?: number }) {
	return (
		<svg width={size * 1.5} height={size} viewBox="0 0 39 26" aria-hidden="true">
			<path d="M5 13h29" stroke="currentColor" strokeWidth="1.5" />
			{[10.5, 14, 19.5, 25, 28.5].map((x) => (
				<path key={x} d={`M${x} 8.5v9`} stroke="var(--blue)" strokeWidth="1.5" />
			))}
			<path d="M5 8.5 9.5 13 5 17.5.5 13z" fill="currentColor" />
			<path d="M34 8.5 38.5 13 34 17.5 29.5 13z" fill="var(--red)" />
		</svg>
	);
}

const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
const TICKS = Array.from({ length: 11 }, (_, i) => ease((i + 1) / 12));

/**
 * Progress drawn as a timing chart. `value` runs 0 to 1; leave it out while the
 * amount of work is not known yet.
 */
export function Tween({ value, bad, label }: { value?: number; bad?: boolean; label: string }) {
	const known = value !== undefined;
	const at = Math.max(0, Math.min(1, value ?? 0));
	return (
		<div
			className={`tween${bad ? " bad" : ""}${known ? "" : " wait"}`}
			role="progressbar"
			aria-label={label}
			aria-valuemin={0}
			aria-valuemax={100}
			aria-valuenow={known ? Math.round(at * 100) : undefined}
		>
			<b className="done" style={{ left: 0 }} />
			{TICKS.map((tick, n) => (
				<i key={tick} className={known && tick <= at ? "done" : ""} style={{ left: `${tick * 100}%`, ["--n" as string]: n }} />
			))}
			<b className={known && at >= 1 ? "done" : ""} style={{ left: "100%" }} />
		</div>
	);
}

export type Tone = "ok" | "busy" | "bad" | "warn" | "idle";

export function Status({ tone = "idle", children }: { tone?: Tone; children: ReactNode }) {
	return (
		<span className="status" data-tone={tone}>
			{children}
		</span>
	);
}

/** Statuses as the service names them, in words a person would use. */
const STATUS: Record<string, [string, Tone]> = {
	draft: ["Draft", "idle"],
	preparing: ["Preparing", "busy"],
	ready: ["Ready", "ok"],
	failed: ["Failed", "bad"],
	queued: ["Queued", "busy"],
	starting: ["Starting", "busy"],
	rendering: ["Rendering", "busy"],
	uploading: ["Uploading", "busy"],
	finishing: ["Finishing", "busy"],
	done: ["Done", "ok"],
	cancelled: ["Cancelled", "idle"],
	pending: ["Generating", "busy"],
	missing: ["Not generated", "idle"],
	processing: ["Processing", "busy"],
};
export function StatusOf({ status }: { status: string }) {
	const [label, tone] = STATUS[status] ?? [status, "idle" as Tone];
	return <Status tone={tone}>{label}</Status>;
}
export const isRunning = (status: string) => STATUS[status]?.[1] === "busy";

export function Avatar({ name, image, large }: { name: string; image?: string | null; large?: boolean }) {
	const className = `avatar${large ? " large" : ""}`;
	return image ? <img className={className} src={image} alt="" referrerPolicy="no-referrer" /> : <span className={className}>{name.slice(0, 1).toUpperCase()}</span>;
}

function useCopied(): [boolean, (text: string) => void] {
	const [copied, setCopied] = useState(false);
	return [
		copied,
		(text) => {
			void navigator.clipboard.writeText(text);
			setCopied(true);
			setTimeout(() => setCopied(false), 1400);
		},
	];
}

export function Snippet({ children }: { children: string }) {
	const [copied, copy] = useCopied();
	return (
		<div className="snippet">
			<button type="button" onClick={() => copy(children)}>
				{copied ? "Copied" : "Copy"}
			</button>
			{children}
		</div>
	);
}

/** An id an agent or the CLI will ask for: click to copy. */
export function CopyId({ id }: { id: string }) {
	const [copied, copy] = useCopied();
	return (
		<button type="button" className="copy" title="Copy this id" onClick={() => copy(id)}>
			{copied ? "Copied" : id}
		</button>
	);
}

export function Crumbs({ children }: { children: ReactNode }) {
	return (
		<nav aria-label="Breadcrumb">
			<ol className="crumbs">{children}</ol>
		</nav>
	);
}

export function Empty({ title, children, actions }: { title: string; children?: ReactNode; actions?: ReactNode }) {
	return (
		<div className="empty">
			<h3>{title}</h3>
			{children && <p>{children}</p>}
			{actions && <div className="acts">{actions}</div>}
		</div>
	);
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
	return (
		// biome-ignore lint/a11y/noLabelWithoutControl: the control is passed in as children
		<label className="field">
			<span className="name">{label}</span>
			{children}
			{hint && <span className="hint">{hint}</span>}
		</label>
	);
}

// ----------------------------------------------------------------- toasts

type Toast = { id: number; text: string; bad?: boolean };
const ToastContext = createContext<(text: string, bad?: boolean) => void>(() => undefined);
export const useToast = () => useContext(ToastContext);

export function Toaster({ children }: { children: ReactNode }) {
	const [toasts, setToasts] = useState<Toast[]>([]);
	const next = useRef(0);
	const push = useCallback((text: string, bad?: boolean) => {
		const id = next.current++;
		setToasts((list) => [...list.slice(-2), { id, text, bad }]);
		setTimeout(() => setToasts((list) => list.filter((toast) => toast.id !== id)), bad ? 6000 : 2600);
	}, []);
	return (
		<ToastContext.Provider value={push}>
			{children}
			<div className="toasts" role="status" aria-live="polite">
				{toasts.map((toast) => (
					<div key={toast.id} className={`toast${toast.bad ? " bad" : ""}`}>
						{toast.text}
					</div>
				))}
			</div>
		</ToastContext.Provider>
	);
}

/**
 * Runs a change, reloads what is on screen, and says what happened. Returns
 * whether it worked, so a dialog knows to close.
 */
export function useAct() {
	const router = useRouter();
	const toast = useToast();
	const [busy, setBusy] = useState(false);
	const act = async (change: () => Promise<unknown>, done?: string) => {
		setBusy(true);
		try {
			await change();
			await router.invalidate();
			if (done) toast(done);
			return true;
		} catch (error) {
			toast(error instanceof Error ? error.message : "That did not work. Try again.", true);
			return false;
		} finally {
			setBusy(false);
		}
	};
	return { busy, act };
}

/**
 * Loads something in the browser only (sessions, API keys: lists the sign-in
 * library serves to its own client) and exposes a reload.
 */
export function useClientLoad<T>(load: () => Promise<T>) {
	const [data, setData] = useState<T | undefined>();
	const [error, setError] = useState<string | undefined>();
	const [tick, setTick] = useState(0);
	// biome-ignore lint/correctness/useExhaustiveDependencies: reloading is driven by `tick`
	useEffect(() => {
		let live = true;
		load()
			.then((value) => live && (setData(value), setError(undefined)))
			.catch((reason: Error) => live && setError(reason.message));
		return () => {
			live = false;
		};
	}, [tick]);
	return { data, error, reload: () => setTick((n) => n + 1) };
}

/** Reloads the page's data every few seconds while something on it is still running. */
export function usePoll(active: boolean, everyMs = 3000) {
	const router = useRouter();
	useEffect(() => {
		if (!active) return;
		const timer = setInterval(() => {
			if (document.visibilityState === "visible") void router.invalidate();
		}, everyMs);
		return () => clearInterval(timer);
	}, [active, everyMs, router]);
}

// ------------------------------------------------------------------ menus

export function Menu({ label, trigger, className = "btn quiet small icon", children }: { label: string; trigger?: ReactNode; className?: string; children: ReactNode }) {
	const [open, setOpen] = useState(false);
	const root = useRef<HTMLDivElement>(null);
	const button = useRef<HTMLButtonElement>(null);
	const panel = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!open) return;
		const away = (event: PointerEvent) => !root.current?.contains(event.target as Node) && setOpen(false);
		const escape = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
		document.addEventListener("pointerdown", away);
		document.addEventListener("keydown", escape);
		return () => {
			document.removeEventListener("pointerdown", away);
			document.removeEventListener("keydown", escape);
		};
	}, [open]);
	// The panel sits in the browser's top layer, so cards that clip their overflow (and open dialogs) can't hide it.
	// It is placed under the button, right-aligned, and flips above when there's no room below.
	useLayoutEffect(() => {
		const el = panel.current;
		if (!open || !el) return;
		if (!el.matches(":popover-open")) el.showPopover?.();
		const place = () => {
			const anchor = button.current?.getBoundingClientRect();
			if (!anchor) return;
			const gap = 6;
			const edge = 8;
			const { width, height } = el.getBoundingClientRect();
			const below = anchor.bottom + gap + height <= window.innerHeight - edge || anchor.top - gap - height < edge;
			const top = below ? anchor.bottom + gap : anchor.top - gap - height;
			const left = Math.min(Math.max(edge, anchor.right - width), window.innerWidth - width - edge);
			el.style.top = `${Math.round(top)}px`;
			el.style.left = `${Math.round(left)}px`;
		};
		place();
		window.addEventListener("resize", place);
		window.addEventListener("scroll", place, true);
		return () => {
			window.removeEventListener("resize", place);
			window.removeEventListener("scroll", place, true);
		};
	}, [open]);
	return (
		<div className="menu" ref={root}>
			<button
				ref={button}
				type="button"
				className={className}
				aria-haspopup="menu"
				aria-expanded={open}
				aria-label={trigger ? label : undefined}
				title={trigger ? undefined : label}
				onClick={() => setOpen(!open)}
			>
				{trigger ?? (
					<>
						<span aria-hidden="true">•••</span>
						<span className="hide">{label}</span>
					</>
				)}
			</button>
			{open && (
				// biome-ignore lint/a11y/useKeyWithClickEvents: choosing an item closes the menu; the items themselves are the controls
				<div
					ref={panel}
					popover="manual"
					className="menu-panel"
					role="menu"
					onClick={(event) => {
						if ((event.target as HTMLElement).closest("a,button")) setOpen(false);
					}}
				>
					{children}
				</div>
			)}
		</div>
	);
}

// ---------------------------------------------------------------- dialogs

export function Dialog({ open, onClose, title, wide, children }: { open: boolean; onClose: () => void; title: string; wide?: boolean; children: ReactNode }) {
	const ref = useRef<HTMLDialogElement>(null);
	const heading = useId();
	useEffect(() => {
		const dialog = ref.current;
		if (!dialog) return;
		if (open && !dialog.open) dialog.showModal();
		if (!open && dialog.open) dialog.close();
	}, [open]);
	if (!open) return null;
	return (
		// biome-ignore lint/a11y/useKeyWithClickEvents: Escape is handled by the dialog element itself
		<dialog
			ref={ref}
			className={`sheet${wide ? " wide" : ""}`}
			aria-labelledby={heading}
			onClose={onClose}
			onClick={(event) => event.target === ref.current && onClose()}
		>
			<div className="sheet-head">
				<h2 id={heading}>{title}</h2>
				<button type="button" className="close" aria-label="Close" onClick={onClose}>
					×
				</button>
			</div>
			<div className="sheet-body">{children}</div>
		</dialog>
	);
}

/** Asks before something that cannot be undone. With `phrase`, the person types it first. */
export function Confirm({
	open,
	onClose,
	title,
	children,
	action,
	phrase,
	busy,
	onConfirm,
}: {
	open: boolean;
	onClose: () => void;
	title: string;
	children: ReactNode;
	/** What the button says, e.g. "Delete project". */
	action: string;
	phrase?: string;
	busy?: boolean;
	onConfirm: () => void;
}) {
	const [typed, setTyped] = useState("");
	useEffect(() => {
		if (!open) setTyped("");
	}, [open]);
	return (
		<Dialog open={open} onClose={onClose} title={title}>
			<p>{children}</p>
			<form
				onSubmit={(event) => {
					event.preventDefault();
					onConfirm();
				}}
			>
				{phrase && (
					<Field label={`Type “${phrase}” to confirm`}>
						<input value={typed} onChange={(event) => setTyped(event.target.value)} autoComplete="off" autoFocus />
					</Field>
				)}
				<div className="sheet-foot">
					<button type="button" className="btn quiet" onClick={onClose}>
						Cancel
					</button>
					<button type="submit" className="btn danger solid" disabled={busy || (phrase !== undefined && typed.trim() !== phrase)}>
						{action}
					</button>
				</div>
			</form>
		</Dialog>
	);
}

/** A small one-question dialog with a save button, for a single value. */
Confirm.Form = function ConfirmForm({ title, onClose, action, busy, onSubmit, children }: { title: string; onClose: () => void; action: string; busy?: boolean; onSubmit: () => void; children: ReactNode }) {
	return (
		<Dialog open onClose={onClose} title={title}>
			<form
				onSubmit={(event) => {
					event.preventDefault();
					onSubmit();
				}}
			>
				{children}
				<div className="sheet-foot">
					<button type="button" className="btn quiet" onClick={onClose}>
						Cancel
					</button>
					<button type="submit" className="btn" disabled={busy}>
						{action}
					</button>
				</div>
			</form>
		</Dialog>
	);
};

/** The app's "this is not here" screen, for a project, video or render that no longer exists. */
export function Missing({ what, children }: { what: string; children?: ReactNode }) {
	return (
		<main className="page narrow">
			<Empty
				title={`This ${what} is not here`}
				actions={
					<Link className="btn" to="/projects">
						Go to projects
					</Link>
				}
			>
				{children ?? "It may have been deleted, or the link belongs to another account."}
			</Empty>
		</main>
	);
}

/**
 * Renders the project brief, which the service writes as plain Markdown:
 * headings, paragraphs, lists and bold text. Nothing else is interpreted.
 */
export function Prose({ text }: { text: string }) {
	const blocks: ReactNode[] = [];
	let list: { depth: number; text: string }[] = [];
	// Bold, `code`, and hex colours (shown with a swatch, since a brief is full of them).
	const inline = (line: string) =>
		line.split(/(\*\*.+?\*\*|`[^`]+`|#[0-9a-fA-F]{6}\b)/g).map((part, i) => {
			const key = `${i}${part}`;
			if (part.startsWith("**")) return <strong key={key}>{part.slice(2, -2)}</strong>;
			if (part.startsWith("`")) return <code key={key}>{part.slice(1, -1)}</code>;
			if (/^#[0-9a-fA-F]{6}$/.test(part)) {
				return (
					<span key={key} className="swatch">
						<i style={{ background: part }} />
						{part}
					</span>
				);
			}
			return part;
		});
	const flush = () => {
		if (!list.length) return;
		blocks.push(
			<ul key={blocks.length}>
				{list.map((item, i) => (
					<li key={`${i}${item.text}`} style={item.depth ? { marginLeft: item.depth * 20 } : undefined}>
						{inline(item.text)}
					</li>
				))}
			</ul>,
		);
		list = [];
	};
	for (const raw of text.split("\n")) {
		const line = raw.trimEnd();
		const item = line.match(/^(\s*)[-*]\s+(.*)$/);
		if (item) {
			list.push({ depth: Math.floor(item[1]!.length / 2), text: item[2]! });
			continue;
		}
		// An indented line under a list item continues it.
		if (list.length && /^\s+\S/.test(line)) {
			list[list.length - 1]!.text += ` ${line.trim()}`;
			continue;
		}
		flush();
		if (!line.trim()) continue;
		const heading = line.match(/^(#{1,4})\s+(.*)$/);
		if (heading) {
			// The brief opens with its own title; the page already has one.
			if (heading[1]!.length === 1) continue;
			blocks.push(heading[1]!.length === 2 ? <h2 key={blocks.length}>{heading[2]}</h2> : <h3 key={blocks.length}>{heading[2]}</h3>);
		} else blocks.push(<p key={blocks.length}>{inline(line)}</p>);
	}
	flush();
	return <div className="prose">{blocks}</div>;
}
