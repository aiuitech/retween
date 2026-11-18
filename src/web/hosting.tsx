/**
 * Hosting a video on the web from the app: host an export, then share its
 * page or embed it, with the play options people usually want (autoplay,
 * loop, no controls, a start time, a fixed size).
 */
import { useEffect, useState } from "react";
import { embedSnippet, parseStart, withPlayOptions } from "../../shared/hosting.ts";
import { clock, op, when } from "./api.ts";
import { ASPECT_NAMES } from "./forms.tsx";
import type { HostedVideo, RenderRow } from "./types.ts";
import { Confirm, Dialog, Field, Menu, Snippet, StatusOf, useAct, useToast } from "./ui.tsx";

type DialogProps = { open: boolean; onClose: () => void };

const sitesFrom = (text: string) =>
	text
		.split(/[\s,]+/)
		.map((site) => site.trim())
		.filter(Boolean);

const exportName = (render: RenderRow) => `${ASPECT_NAMES[render.aspect] ?? render.aspect} at ${render.resolution}`;

/** Which hosting dialog is open, shared by a page's buttons and its "On the web" block. */
export function useHostingDialogs() {
	/** The export to host: an id to preselect it, "" for the first one not yet hosted, null when closed. */
	const [hostFor, setHostFor] = useState<string | null>(null);
	const [shareId, setShareId] = useState<string | null>(null);
	return { hostFor, setHostFor, shareId, setShareId };
}
export type HostingDialogs = ReturnType<typeof useHostingDialogs>;

const COST_NOTE =
	"Anyone with the link can watch this cut. Storage ($5 per 1,000 minutes a month) and every minute watched ($1 per 1,000) are billed to your account at cost plus Retween's markup, and playback pauses if the account reaches its monthly cap.";

// ------------------------------------------------------------------ host

export function HostDialog({
	open,
	onClose,
	renders,
	hosted,
	preselect,
	defaultTitle,
	onHosted,
}: DialogProps & { renders: RenderRow[]; hosted: HostedVideo[]; preselect?: string; defaultTitle: string; onHosted: (hostedId: string) => void }) {
	const { busy, act } = useAct();
	const done = renders.filter((render) => render.status === "done");
	const isHosted = (renderId: string) => hosted.some((copy) => copy.renderId === renderId && copy.status !== "failed");
	const [renderId, setRenderId] = useState("");
	const [title, setTitle] = useState("");
	const [description, setDescription] = useState("");
	const [captions, setCaptions] = useState(true);
	const [sites, setSites] = useState("");
	useEffect(() => {
		if (!open) return;
		setRenderId(preselect || done.find((render) => !isHosted(render.id))?.id || done[0]?.id || "");
		setTitle(defaultTitle);
		setDescription("");
		setCaptions(true);
		setSites("");
		// Reset only when the dialog opens, not on every poll that refreshes the lists.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open]);
	const chosen = done.find((render) => render.id === renderId);
	const already = renderId ? isHosted(renderId) : false;

	return (
		<Dialog open={open} onClose={onClose} title="Host on the web">
			<p>You get a page to share and a player to embed on any website, with captions and streaming that adapts to the viewer's connection. There are no ads or suggested videos.</p>
			{done.length === 0 ? (
				<p className="note">Export the video first: a finished export is what gets hosted.</p>
			) : (
				<form
					className="fields"
					onSubmit={async (event) => {
						event.preventDefault();
						let hostedId = "";
						const ok = await act(async () => {
							const result = await op<{ hosted: HostedVideo }>("hosting.publish", {
								renderId,
								title: title.trim(),
								description,
								captions,
								allowedOrigins: sitesFrom(sites),
								// The person pressing this is approving this cut for anyone with the link.
								personApproved: true,
								waitSeconds: 0,
							});
							hostedId = result.hosted.id;
						}, "Hosting: it plays as soon as processing finishes");
						if (ok) {
							onClose();
							onHosted(hostedId);
						}
					}}
				>
					<Field label="Export" hint="Host the shape your page shows: landscape for most sites, vertical for phones and stories.">
						<select value={renderId} onChange={(event) => setRenderId(event.target.value)}>
							{done.map((render) => (
								<option key={render.id} value={render.id}>
									{exportName(render)}
									{render.durationSec ? `, ${clock(render.durationSec)}` : ""}
									{isHosted(render.id) ? " (already hosted)" : ""}
								</option>
							))}
						</select>
					</Field>
					{already && <p className="note info">This export is already hosted. Share the copy you have, or remove it before hosting it again.</p>}
					<Field label="Title">
						<input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={200} required />
					</Field>
					<Field label="Description" hint="Shown under the video on its page. Optional.">
						<textarea value={description} onChange={(event) => setDescription(event.target.value)} maxLength={5000} rows={3} />
					</Field>
					<label className="check">
						<input type="checkbox" checked={captions} onChange={(event) => setCaptions(event.target.checked)} />
						Captions from the narration, on by default
					</label>
					<Field label="Only allow embedding on these sites" hint="One per line, such as example.com or *.example.com. Leave empty to allow any site. The link works for everyone either way.">
						<textarea value={sites} onChange={(event) => setSites(event.target.value)} rows={2} placeholder={"example.com\n*.example.com"} />
					</Field>
					<p className="softer" style={{ margin: 0, fontSize: "0.9rem" }}>
						{COST_NOTE}
					</p>
					<div className="sheet-foot">
						<button type="button" className="btn quiet" onClick={onClose}>
							Cancel
						</button>
						<button type="submit" className="btn" disabled={busy || !chosen || already || !title.trim()}>
							Host video
						</button>
					</div>
				</form>
			)}
		</Dialog>
	);
}

// ----------------------------------------------------------------- share

export function ShareDialog({ open, onClose, hosted, onEdit }: DialogProps & { hosted: HostedVideo; onEdit: () => void }) {
	const { busy, act } = useAct();
	const [autoplay, setAutoplay] = useState(false);
	const [loop, setLoop] = useState(false);
	const [hideControls, setHideControls] = useState(false);
	const [start, setStart] = useState("");
	const [sizing, setSizing] = useState<"responsive" | "fixed">("responsive");
	const [fixedWidth, setFixedWidth] = useState(640);
	useEffect(() => {
		if (!open) return;
		setAutoplay(false);
		setLoop(false);
		setHideControls(false);
		setStart("");
		setSizing("responsive");
	}, [open]);

	const startSec = parseStart(start);
	const badStart = start.trim() !== "" && startSec === undefined;
	const options = { autoplay, loop, hideControls, startSec };
	const link = withPlayOptions(hosted.pageUrl, { startSec });
	const embedUrl = withPlayOptions(hosted.embedUrl, options);
	const code = embedSnippet(embedUrl, hosted.title, hosted.width, hosted.height, sizing === "fixed" ? fixedWidth : undefined);
	// The preview never autoplays: playing it here counts as minutes watched.
	const previewUrl = withPlayOptions(hosted.embedUrl, { ...options, autoplay: false });
	const ready = hosted.status === "ready";
	const failed = hosted.status === "failed";
	const vertical = hosted.height > hosted.width;

	return (
		<Dialog open={open} onClose={onClose} title="Share and embed" wide>
			{failed && <p className="note bad">This video could not be hosted: {hosted.error ?? "Stream could not process it."} Remove it and host the export again.</p>}
			{!ready && !failed && <p className="note info">Still processing, usually a minute or two. You can copy the link and embed code now; they start working when it is ready.</p>}
			{ready && !hosted.enabled && (
				<p className="note">
					Paused: the page and every embed say it is unavailable.{" "}
					<button type="button" className="text" disabled={busy} onClick={() => void act(() => op("hosting.update", { hostedId: hosted.id, enabled: true }), "Resumed")}>
						Resume it
					</button>
				</p>
			)}

			{ready && hosted.enabled && (
				<div className="share-preview" style={{ aspectRatio: `${hosted.width} / ${hosted.height}`, maxWidth: vertical ? 260 : undefined }}>
					<iframe key={previewUrl} src={previewUrl} title={`Preview of ${hosted.title}`} allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowFullScreen />
				</div>
			)}

			<div className="fields">
				<div>
					<div className="share-head">
						<h3>Link</h3>
						<a className="btn quiet small" href={link} target="_blank" rel="noreferrer">
							Open page
						</a>
					</div>
					<Snippet>{link}</Snippet>
				</div>

				<div>
					<div className="share-head">
						<h3>Embed on a website</h3>
					</div>
					<div className="share-options">
						<label className="check">
							<input type="checkbox" checked={autoplay} onChange={(event) => setAutoplay(event.target.checked)} />
							Autoplay <span className="softer">(muted)</span>
						</label>
						<label className="check">
							<input type="checkbox" checked={loop} onChange={(event) => setLoop(event.target.checked)} />
							Loop
						</label>
						<label className="check">
							<input type="checkbox" checked={hideControls} onChange={(event) => setHideControls(event.target.checked)} />
							Hide controls
						</label>
					</div>
					<div className="share-row">
						<Field label="Start at" hint={badStart ? "Write it as 1:30 or 90." : "For the link and the embed."}>
							<input value={start} onChange={(event) => setStart(event.target.value)} placeholder="0:00" inputMode="numeric" aria-invalid={badStart} />
						</Field>
						<Field label="Size">
							<select value={sizing} onChange={(event) => setSizing(event.target.value as "responsive" | "fixed")}>
								<option value="responsive">Fill the width of its column</option>
								<option value="fixed">Fixed width</option>
							</select>
						</Field>
						{sizing === "fixed" && (
							<Field label="Width" hint={`${fixedWidth} × ${Math.round((fixedWidth * hosted.height) / hosted.width)} pixels`}>
								<input type="number" min={160} max={3840} step={10} value={fixedWidth} onChange={(event) => setFixedWidth(Math.max(160, Math.min(3840, Number(event.target.value) || 640)))} />
							</Field>
						)}
					</div>
					<Snippet wrap>{code}</Snippet>
					<p className="softer" style={{ margin: 0, fontSize: "0.9rem" }}>
						{hosted.allowedOrigins.length ? `Plays only on ${hosted.allowedOrigins.join(", ")}. ` : "Plays on any site. "}
						<button type="button" className="text" onClick={onEdit}>
							Change this
						</button>
					</p>
				</div>
			</div>

			<div className="sheet-foot">
				<button type="button" className="btn" onClick={onClose}>
					Done
				</button>
			</div>
		</Dialog>
	);
}

// --------------------------------------------------------------- details

export function HostedDetailsDialog({ open, onClose, hosted }: DialogProps & { hosted: HostedVideo }) {
	const { busy, act } = useAct();
	const [title, setTitle] = useState(hosted.title);
	const [description, setDescription] = useState(hosted.description ?? "");
	const [sites, setSites] = useState(hosted.allowedOrigins.join("\n"));
	useEffect(() => {
		if (!open) return;
		setTitle(hosted.title);
		setDescription(hosted.description ?? "");
		setSites(hosted.allowedOrigins.join("\n"));
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open]);
	return (
		<Dialog open={open} onClose={onClose} title="Hosted video details">
			<form
				className="fields"
				onSubmit={async (event) => {
					event.preventDefault();
					const ok = await act(
						() => op("hosting.update", { hostedId: hosted.id, title: title.trim(), description, allowedOrigins: sitesFrom(sites) }),
						"Saved",
					);
					if (ok) onClose();
				}}
			>
				<Field label="Title">
					<input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={200} required />
				</Field>
				<Field label="Description" hint="Shown under the video on its page.">
					<textarea value={description} onChange={(event) => setDescription(event.target.value)} maxLength={5000} rows={3} />
				</Field>
				<Field label="Only allow embedding on these sites" hint="One per line. Leave empty to allow any site. Embeds already on other sites stop playing.">
					<textarea value={sites} onChange={(event) => setSites(event.target.value)} rows={2} placeholder={"example.com\n*.example.com"} />
				</Field>
				<div className="sheet-foot">
					<button type="button" className="btn quiet" onClick={onClose}>
						Cancel
					</button>
					<button type="submit" className="btn" disabled={busy || !title.trim()}>
						Save
					</button>
				</div>
			</form>
		</Dialog>
	);
}

// ------------------------------------------------------------------ list

/** One hosted copy: what it is, and everything that can be done with it. */
export function HostedLine({ hosted, onShare, onEdit, render }: { hosted: HostedVideo; onShare: () => void; onEdit: () => void; render?: RenderRow }) {
	const { busy, act } = useAct();
	const toast = useToast();
	const [removing, setRemoving] = useState(false);
	const ready = hosted.status === "ready";
	const failed = hosted.status === "failed";
	const copy = (text: string, what: string) => {
		void navigator.clipboard.writeText(text);
		toast(`Copied ${what}`);
	};
	return (
		<div className="line">
			{hosted.posterUrl ? <img className="hosted-thumb" src={hosted.posterUrl} alt="" loading="lazy" style={{ aspectRatio: `${hosted.width} / ${hosted.height}` }} /> : null}
			<div className="grow">
				<div className="title clip">{hosted.title}</div>
				<div className="facts">
					{ready && !hosted.enabled && <span style={{ color: "var(--amber)" }}>Paused</span>}
					<span>{render ? exportName(render) : `${hosted.width} × ${hosted.height}`}</span>
					{hosted.durationSec ? <span>{clock(hosted.durationSec)}</span> : null}
					{hosted.captions && <span>Captions</span>}
					<span>{hosted.allowedOrigins.length ? `Embeds on ${hosted.allowedOrigins.length === 1 ? hosted.allowedOrigins[0]!.replace(/^https?:\/\//, "") : `${hosted.allowedOrigins.length} sites`}` : "Embeds anywhere"}</span>
					<span>{when(hosted.createdAt)}</span>
					{hosted.error && <span style={{ color: "var(--red)" }}>{hosted.error}</span>}
					{hosted.warnings?.map((warning) => (
						<span key={warning} style={{ color: "var(--amber)" }}>
							{warning}
						</span>
					))}
				</div>
			</div>
			<StatusOf status={ready && !hosted.enabled ? "paused" : hosted.status} />
			<div className="acts">
				{!failed && (
					<button type="button" className="btn quiet small" onClick={onShare}>
						Share
					</button>
				)}
				<Menu label={`Actions for the hosted video ${hosted.title}`}>
					{ready && (
						<a href={hosted.pageUrl} target="_blank" rel="noreferrer">
							Open page
						</a>
					)}
					{!failed && (
						<button type="button" onClick={() => copy(hosted.pageUrl, "the link")}>
							Copy link
						</button>
					)}
					{hosted.embedCode && (
						<button type="button" onClick={() => copy(hosted.embedCode!, "the embed code")}>
							Copy embed code
						</button>
					)}
					{!failed && (
						<button type="button" onClick={onEdit}>
							Edit details
						</button>
					)}
					{ready && (
						<button
							type="button"
							disabled={busy}
							onClick={() =>
								void act(() => op("hosting.update", { hostedId: hosted.id, enabled: !hosted.enabled }), hosted.enabled ? "Paused: nothing plays until you resume it" : "Resumed")
							}
						>
							{hosted.enabled ? "Pause playback" : "Resume playback"}
						</button>
					)}
					<button type="button" className="danger" onClick={() => setRemoving(true)}>
						Stop hosting
					</button>
				</Menu>
			</div>
			<Confirm
				open={removing}
				onClose={() => setRemoving(false)}
				title="Stop hosting this video?"
				action="Stop hosting"
				busy={busy}
				onConfirm={async () => {
					if (await act(() => op("hosting.delete", { hostedId: hosted.id }), "No longer hosted")) setRemoving(false);
				}}
			>
				The page and every embed of it stop working, and it stops being billed. The export itself is kept.
			</Confirm>
		</div>
	);
}

/**
 * A page's "On the web" section: its hosted copies, a button to host one, and
 * the dialogs. The page owns which dialog is open (useHostingDialogs), so its
 * own buttons (an export's menu, the header) can open them too.
 */
export function HostingBlock({ renders, hosted, videoTitle, dialogs }: { renders: RenderRow[]; hosted: HostedVideo[]; videoTitle: string; dialogs: HostingDialogs }) {
	const { hostFor, setHostFor, shareId, setShareId } = dialogs;
	const [editId, setEditId] = useState<string | null>(null);
	const done = renders.filter((render) => render.status === "done");
	const unhosted = done.filter((render) => !hosted.some((copy) => copy.renderId === render.id && copy.status !== "failed"));
	const sharing = hosted.find((copy) => copy.id === shareId);
	const editing = hosted.find((copy) => copy.id === editId);
	const rendersById = new Map(renders.map((render) => [render.id, render]));
	return (
		<div className="block">
			<div className="block-head">
				<div>
					<h2>On the web</h2>
					<p>
						{hosted.length
							? "Pages to share and players to embed on any site. Storage and minutes watched are billed to this account."
							: done.length
								? "Host an export to get a page to share and a player to embed on any website, with captions and adaptive streaming."
								: "Once the video is exported, host it here to get a page to share and a player to embed on any website."}
					</p>
				</div>
				{unhosted.length > 0 && (
					<button type="button" className="btn quiet" onClick={() => setHostFor("")}>
						Host on the web
					</button>
				)}
			</div>
			{hosted.length > 0 && (
				<div className="lines">
					{hosted.map((copy) => (
						<HostedLine key={copy.id} hosted={copy} render={rendersById.get(copy.renderId)} onShare={() => setShareId(copy.id)} onEdit={() => setEditId(copy.id)} />
					))}
				</div>
			)}
			<HostDialog
				open={hostFor !== null}
				onClose={() => setHostFor(null)}
				renders={renders}
				hosted={hosted}
				preselect={hostFor || undefined}
				defaultTitle={videoTitle}
				onHosted={(id) => setShareId(id)}
			/>
			{shareId && (
				<ShareDialog
					open
					onClose={() => setShareId(null)}
					// Just hosted: the list catches up on the next refresh.
					hosted={sharing ?? PENDING(shareId, videoTitle)}
					onEdit={() => {
						setShareId(null);
						setEditId(shareId);
					}}
				/>
			)}
			{editing && <HostedDetailsDialog open onClose={() => setEditId(null)} hosted={editing} />}
		</div>
	);
}

/** Stands in for a copy that was just created and is not in the loaded list yet. */
const PENDING = (id: string, title: string): HostedVideo => ({
	id,
	renderId: "",
	status: "queued",
	enabled: true,
	title,
	pageUrl: `${location.origin}/v/${id}`,
	embedUrl: `${location.origin}/embed/${id}`,
	width: 16,
	height: 9,
	allowedOrigins: [],
	createdAt: new Date().toISOString(),
});
