# Retween

A video studio that agents operate. A project keeps a brand; a storyboard says what each scene shows and says; Retween voices it, finds or generates the pictures, times every scene to the recorded audio, and renders it at any aspect ratio.

Live at https://retween.app. Three surfaces over one API:

| Surface | Where | Auth |
| --- | --- | --- |
| MCP | `https://retween.app/mcp` | OAuth (browser sign-in), or an API key as a bearer token |
| CLI | `npm install -g https://retween.app/cli/retween.tgz` | `retween login` (device flow), or `RETWEEN_API_KEY` |
| Web | https://retween.app | Google sign-in. Profile, API keys, library, admin dashboard |

**Uploads.** Files up to 90 MB go up in one request (`PUT /api/v1/projects/<id>/assets`, or the signed link from `asset.upload_link`). Larger files, up to 4 GB, go up in 64 MiB parts through the Worker (R2 multipart, `services/uploads.ts`): start, PUT each part, then complete. The web app and `retween asset upload` switch to parts by themselves, and `asset.upload_link` gives agents the curl steps.

## How it fits together

```
shared/            contracts used by every part
  brand.ts           the brand kit (what a project remembers)
  storyboard.ts      what an author writes: scenes, no durations
  compose.ts         storyboard + measured media → timeline (pure function)
  timeline.ts        the render contract: absolute frames, resolution independent
  inspect.ts         frames to look at, cue sheets, pacing / layout / sound checks (pure)
  footage.ts         cutting a person's own recording by quoting its transcript (pure)
  narration.ts       pronunciation respelling and word timings
src/worker/        the Cloudflare Worker
  ops/               every capability, defined once (name, description, zod input, handler)
  routes/mcp.ts      ops → MCP tools
  index.ts           ops → REST (POST /api/v1/ops/<name>), auth, uploads, signed file URLs
  workflows/         asset generation, prepare → compose pipeline, container rendering
  providers/         OpenRouter (images, clips, voice, music, timing), ElevenLabs (voice, music, sfx), stock sources, YouTube
  auth/              better-auth: Google, admin, API keys, device flow, OAuth provider for MCP
src/web/           the web app (TanStack Start: pages in routes/, rendered by the Worker)
cli/               the CLI: builds its commands from GET /api/v1/ops
renderer/          Remotion + headless Chrome behind a small HTTP server (the container image)
migrations/        D1 schema
```

An operation added to `src/worker/ops/` appears as an MCP tool, a CLI command and a REST endpoint with no further work.

**Why timing is trustworthy.** Storyboards carry no durations. `video.prepare` generates narration (with word-level timestamps), stills, stock and sound effects first; then sizes clips and music to the voice; only then composes the timeline. Scene lengths, bullet cues, captions and music ducking are all derived from measured audio.

**Checking work without rendering.** Agents read text and look at stills; they cannot watch an MP4 or hear a mix. So these ops turn video into images and numbers, run on the person's warm preview renderer and take seconds:

| Op | What the agent gets |
| --- | --- |
| `video.preview` | One frame as an image, optionally the same frame in several aspect ratios side by side, or a trial version of a scene without saving it |
| `video.sheet` | A contact sheet: every scene once it has settled, or N frames across a stretch to see an animation or transition |
| `video.check` | Issues ranked by severity, with fixes: text that shrank or overflowed per aspect ratio (reported by `FitBox` while laid out at export size), fast narration, more text than time to read it, late reveals, dead air, unusable media |
| `video.timing` | A cue sheet: scene times, narration lines with times and words a minute, when each bullet / chart value / place / sound effect lands, music ducking, unvoiced stretches |
| `video.audio` | The mix measured like a platform would: BS.1770 loudness per stem and scene, peaks and clipping, voice-over-music balance, narration level jumps, silences. Clips are decoded with Remotion's ffmpeg and mixed with the renderer's own `volumeAt`; it matches a real render within about 0.2 LU |
| `video.draft` | A low-res MP4 of a stretch (ultrafast encode on the preview renderer), for motion and for showing a person |
| `asset.view`, `stock.search` `preview` | Pictures and clips (as frame strips) on one numbered sheet, so media is chosen by eye |
| `video.check` (listening and shape) | Each narration take is transcribed once (Whisper via OpenRouter, cached as the asset's `meta.heard`) and compared with the script, so misread names and skipped phrases show up; respelled words are reported as information. It also flags a late first word, a silent title-card opening, stretches where the picture does not change, runs of one scene type, no call to action, and a structure copied from the project's other videos (YouTube's inauthentic-content policy) |
| `video.review` | A video-capable model (Gemini via OpenRouter) watches and listens to a 480p draft of up to two minutes and returns timestamped notes by scene |

Sheets are a second Remotion composition (`renderer/src/Sheet.tsx`): each tile is the video laid out at full export size, frozen on one frame and scaled down with a transform, so one page load covers many frames and text fits exactly as in the export.

**Editing the person's own footage.** A phone video of someone talking (or an interview, or a voice memo) is footage, not just a background clip. Uploaded video is processed automatically by the `retween-footage` Workflow on a container instance named `footage-<asset id>`, using real ffmpeg (Debian's, in the renderer image):

- **Edit master.** An H.264 version of the video, at 30 fps constant, upright, tone-mapped to SDR, at most 1080p, with a keyframe every second. It replaces the asset's file, because phone HEVC, HDR and variable frame rates do not play reliably in the renderer. The upload is kept beside it (`meta.footage.originalKey`, and counted in storage), and reprocessing starts again from it.
- **Voice track.** A mono audio asset, high-passed (`denoise` adds light noise reduction) and levelled with two-pass loudnorm to −19 LUFS. A mono track plays on both channels at full level, which measures as −16, the same as generated narration.
- **Shot changes and silences**, found during the same ffmpeg passes.
- **Transcript.** ElevenLabs Scribe v2 transcribes the voice track with word timings, speakers and sound events, about $0.20 an hour. The result is stored as the asset's `meta.words`, the same shape as narration. If transcription fails, the footage is still usable, cut by seconds.

| Op | What it does |
| --- | --- |
| `footage.process` | Process audio or imported video, or redo processing with a language, key terms or noise reduction |
| `footage.get` | Progress, plus what the recording holds: length, picture, loudness, and transcript size with retake and filler counts |
| `footage.transcript` | Timed paragraphs by speaker, marked with retakes (restarted sentences), fillers, pauses and shot changes. Also SRT, words, and search |
| `footage.view` | A contact sheet of frames, each labelled with its time and what is being said |

A scene uses a stretch of a recording with `footage: { assetId, from, to }`. `from` and `to` are quoted words (or seconds), and the cut is placed in the pauses around them, frame-aligned so picture and voice start together. The scene lasts exactly that long, and its captions, bullet, chart and map cues, and music ducking follow the recording. `show: "speaker"` makes the footage the scene's picture (beside the text in a split scene), muted, with the voice track playing as the narration. Back-to-back cuts from one recording alternate between 1× and 1.12× zoom to hide the jump. `show: "voice"` plays the person over the scene's own visual, as b-roll. Any picture or footage can also take a `look`: brightness, contrast, saturation, temperature, grayscale, blur and vignette. Video visuals take a `speed`.

**Infrastructure.** Worker + static assets, D1 (`retween`), R2 (`retween-media`, private; files are served through signed URLs), six Workflows (asset, pipeline, render, publish, footage, hosting), Cloudflare Stream for hosted videos, and a Durable Object-backed Container (`standard-4`, one instance per render, stopped when the render finishes).

**Thumbnails and posters.** `thumbnail.design` draws up to three variants with the video's own renderer (a `thumbnail` tile kind in the `Sheet` composition: a one-frame-per-variant timeline of scene pictures without their text, with `ThumbnailOverlay` drawn over it) and shows each at full size and at feed sizes with the duration badge. `choose` saves one as a 1280×720 JPEG under 2 MB (`videos.thumbnail_asset_id`); `youtube.publish` sends it by default. Each render also takes a poster still of its opening before its container stops (`renders.poster_key`). Contracts are in `shared/thumbnail.ts`; constants the Remotion bundle needs are in the import-free `shared/thumbnail-layout.ts`, because the bundle cannot resolve `zod` from `shared/` inside the image.

**Reviews.** `review.request` opens a round on a video (`reviews`, `review_comments`) and returns a link to `/review/<id>?t=<token>`. The token is an HMAC of the review id (`services/reviews.ts`), so the page works without an account and the link can be shown again without being stored. The page plays the current export, or a 720p draft of the stretch, and the person leaves notes on moments, points on the frame or whole scenes, then submits them with a verdict. `review.get` waits for and returns the notes mapped to scenes and spoken words, with an image of the commented frames; `video.get` and `project.brief` flag unread notes. `youtube.publish` refuses anything beyond private without an approved round (or `personApproved`).

**Publishing.** `youtube.preflight` checks an export before it goes up (Short or not, current cut, approval, thumbnail, chapters, captions, credits, duplicates, the daily upload limit) and suggests the `containsSyntheticMedia` answer from the media. Scenes with a `chapter` title become chapters in the description. `youtube.retention` lays YouTube Analytics' retention curve over the scenes of the uploaded export and can save the lesson as a pinned learning note.

**Editing.** `scene.patch` merges changes into one or many scenes. Every storyboard change saves the previous state first (`video_checkpoints`, last 20 kept); `video.checkpoint` saves a named one whose media is kept through later preparation, and `video.restore` goes back. `video.derive` cuts a new video (a Short, a teaser) from some scenes, reusing their media; cleanup never deletes media another video in the project uses. The web app's storyboard (`src/web/storyboard.tsx`) offers the same tools by hand: a zoomable track that scrolls sideways, drag to reorder, a scene editor (fields or the whole scene as JSON, with a frame preview of unsaved changes), retakes of one scene's narration or picture, history, and preparing with an estimate first. It calls the same operations, so nothing there is out of an agent's reach.

**Custom layers.** Any scene can carry `custom`: JavaScript that returns elements made with `h()` for each frame, given the frame, size, brand colours and fonts, the scene's word timings and animation helpers (`renderer/src/components/CustomLayer.tsx`). It runs inside the normal timeline, so previews, checks and exports include it. Errors drop the layer and come back as render warnings. It runs in the account's own renderer instances; the shadowed globals are a guard against accidents, not a sandbox.

**Craft.** `guide` with a topic (hook, pacing, structure, shorts, thumbnail, publishing, originality, review) returns short notes, also served as MCP resources at `retween://guide/<topic>` (`services/craft.ts`).

## Develop

```sh
pnpm install && pnpm --dir renderer install
cp .dev.vars.example .dev.vars        # fill in the keys
pnpm db:migrate:local
pnpm renderer                         # terminal 1: renderer on :8099 (no Docker needed)
pnpm dev                              # terminal 2: http://localhost:5173
```

Local development has a sign-in shortcut that is compiled out of production builds:
`curl -X POST localhost:5173/api/dev/login -H 'content-type: application/json' -d '{"email":"you@example.com"}'`
returns a session token (use it as a bearer token) and sets the browser cookie.

After changing the database schema: `pnpm db:generate`, then `pnpm db:migrate:local`.
After changing auth plugins: `pnpm exec auth generate --config auth.gen.ts --output src/worker/db/auth-schema.ts --adapter drizzle --dialect sqlite -y`, then the two commands above.

## Deploy

Uses the `cf` CLI (not Wrangler); configuration is in `cloudflare.config.ts`. Docker must be running to build the renderer image.

```sh
pnpm run deploy             # build the CLI, apply D1 migrations, upload secrets, deploy
pnpm run deploy --dry-run   # build and check without migrating or uploading
```

Secrets are uploaded from `.secrets.production` (git-ignored) on every deploy; without that file, the deployed secrets are left as they are. They are: `BETTER_AUTH_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `OPENROUTER_API_KEY`, `ELEVENLABS_API_KEY`, and optionally `PEXELS_API_KEY`, `PIXABAY_API_KEY` (more stock) and `FAL_KEY` (subject cut-outs and vector illustrations through fal.ai).

Google OAuth client: authorised redirect URIs `https://retween.app/api/auth/callback/google` and `https://retween.app/api/youtube/callback` (plus the `http://localhost:5173/…` equivalents for local development).

## YouTube publishing

`youtube.connect` hands the person a link (`/api/youtube/connect`); they pick a channel on Google's consent screen and it appears under Connect → YouTube in the web app. `youtube.publish` sends a finished render to it through the `retween-publish` Workflow: a resumable upload streamed from R2 in 32 MiB chunks, then captions (SRT from the timeline's narration timings), an optional thumbnail and playlist. Credits owed for third-party media are appended to the description. Uploads default to private.

It uses the same Google OAuth client as sign-in, asking separately for the `youtube.force-ssl` scope (needed for captions and playlists; `youtube.upload` alone cannot do those). Refresh tokens are stored AES-GCM-encrypted with a key derived from `BETTER_AUTH_SECRET`. Setup in Google Cloud:

1. Enable the **YouTube Data API v3** and the **YouTube Analytics API** on the project that owns the OAuth client.
2. Add the `…/auth/youtube.force-ssl` and `…/auth/yt-analytics.readonly` scopes to the OAuth consent screen, and the callback redirect URIs above. Analytics is optional for the person: a channel connected without it publishes as before, and `youtube.retention` asks them to connect again.
3. While the consent screen is in testing, only listed test users can connect. Going beyond that needs Google's verification of the sensitive scope.

Quota: uploads have their own allowance of 100 a day per Cloud project. Captions cost 400 units each, and thumbnails and playlist additions 50 each, out of the shared 10,000 units a day.

## Hosting

`hosting.publish` copies a finished render to Cloudflare Stream (the `STREAM` binding) through the `retween-hosting` Workflow: Stream fetches the file from a signed R2 link, the workflow waits for it to be processed, then adds WebVTT captions timed to the narration. Each copy gets a watch page at `/v/<id>` (themed with the brand's palette, with the thumbnail as poster, chapters that seek, credits, Open Graph and Twitter player tags) and an embed at `/embed/<id>`; `embedCode` is a responsive iframe for it, and `/api/oembed` lets CMSs, Notion and Slack unfurl a watch page link. `allowedOrigins` limits which sites may embed it (`frame-ancestors`). The web app shows them on an export's page under "On the web".

Copies require signed URLs, so they only play through these pages, which ask Stream for a one-hour token per view. That is how playback is governed: the pages stop handing out tokens while the owner pauses the video (`hosting.update enabled: false`), or the owner's account is suspended, has no payment method, has an unpaid invoice or is over its monthly cap (`playbackBlocked` in `services/usage.ts`).

Billing is at cost × markup like everything else, from two ledger kinds written by the nightly cron (`services/hosting.ts`), before invoicing:

- `hosting`: one day of storage for every copy, per account, at $5 per 1,000 minutes a month (Stream bills by length, not size).
- `streaming`: minutes delivered per copy at $1 per 1,000, from `streamMinutesViewedAdaptiveGroups` grouped by copy and `creator` (each copy's owner), so plays are charged even after a copy is deleted. The two days before each run are measured, recorded against the day they happened and replaced on the second pass, since analytics trail by a few minutes; on the 2nd this covers the closed month's last day before it is invoiced. Analytics are sampled, so this can differ slightly from Cloudflare's invoice.

This needs `CLOUDFLARE_ANALYTICS_TOKEN` (Account Analytics: Read): without it plays could not be billed, so `hosting.publish` refuses. Deleting a video or project deletes its copies; a copy whose video is gone some other way (an account deleted) is removed by the nightly sweep. Stream storage is bought in prepaid blocks of 1,000 minutes on the Cloudflare account, so keep headroom there: uploads fail when it runs out.

## Access

Anyone can sign in with Google. A new account can do nothing until it adds a payment method (`/billing`, a Stripe Checkout page in setup mode: nothing is charged then); the API answers `402 billing_required` with that link. Emails in `SUPERUSER_EMAILS` (`cloudflare.config.ts`) become administrators on first sign-in; administrators are never billed. Every account has a monthly spend cap in billed dollars (default $10, `DEFAULT_MONTHLY_BUDGET_CENTS`) that administrators can change per person, and an account can set its own lower limit in its cost controls.

## Billing

People pay for what they use, monthly. Every vendor charge is in the usage ledger as it happens (below); the account is billed cost × `BILLING_MARKUP` (1.3).

- **Spend at any moment.** `billing.spend` (MCP `billing_spend`, `retween billing spend`, Account → Spending) gives this month's charges as they will be billed, by kind and project, unspent credit, the estimated invoice, what is left of the cap, and recent invoices. Administrators can pass a `userId`; they also see the raw cost.
- **Invoices.** From the 2nd of each month the nightly job (after reconciliation) turns last month's ledger into one Stripe invoice per account (`services/billing.ts`): a line per kind of usage with markup, less unspent credit, charged automatically to the saved payment method. Stripe handles retries and dunning. Re-running is safe: accounts already invoiced are left alone. `admin.invoice_run` (dry run by default) does it by hand; `admin.invoices` lists them.
- **Credit.** Superusers give or take back credit with `admin.credit_grant` (Admin → a person → Give credit). Credit is spent by the next invoices before the card is charged, and adds to the account's headroom under its cap.
- **Unpaid invoices.** A failed payment (or an opened dispute) makes the account `past_due`: paid work is refused with `402 payment_past_due` until it is settled. Adding a new payment method (Stripe's customer portal, `/api/billing/portal`) retries open invoices at once.
- **Webhook.** `POST /api/stripe/webhook`, signed with `STRIPE_WEBHOOK_SECRET`. Subscribe it to `checkout.session.completed`, `setup_intent.succeeded`, `invoice.finalized`, `invoice.paid`, `invoice.payment_failed`, `invoice.voided`, `invoice.marked_uncollectible`, `charge.dispute.created` and `customer.deleted`, on API version `2026-10-28.endive` (the SDK's). Locally: `stripe listen --forward-to localhost:5173/api/stripe/webhook`.

## Costs per account

Every vendor charge is written to the usage ledger (`usage_events`) against the account that caused it, as soon as the vendor answers. `admin.costs` turns the ledger into a statement per account for any period, by provider, kind and model, and applies the markup (`BILLING_MARKUP` unless one is passed). The monthly spend cap and invoices are computed from the same ledger.

| Vendor | What is charged | How the cost is known (`basis`) |
| --- | --- | --- |
| OpenRouter | images, video clips, music (Lyria) | `vendor`: `usage.cost` from the response (`list` if it is missing) |
| OpenRouter | narration (Kokoro, Gemini TTS, Voxtral, …) and the transcription that times it | `vendor`: the generation's cost looked up by `X-Generation-Id` (`list`: characters × the catalogue price, if the lookup has nothing yet) |
| ElevenLabs | narration | `metered`: the `character-cost` header × our rate per 1k characters |
| ElevenLabs | music, sound effects | `metered` / `list`: length × published per-minute price |
| fal | cut-outs, vector art | `metered`: `x-fal-billable-units` × the endpoint's price from fal's pricing API (`list` as a fallback) |
| Cloudflare Containers | renders, preview frames | `metered`: container run time from start to stop (measured in `Renderer`), including the idle time before it sleeps |
| Cloudflare R2 | stored assets and renders | `metered`: a nightly cron charges each account one day of storage |
| Cloudflare Stream | hosted videos | `metered`: a nightly cron charges one day of each copy's length (`hosting`), and the minutes delivered per copy from Cloudflare's analytics (`streaming`) |

Rates that are not reported per request live in `src/worker/services/pricing.ts`; keep them in line with the invoices.

## Voice and music vendors

Narration goes to ElevenLabs unless the brand's `narration.modelId` names an OpenRouter speech model (`vendor/model`, e.g. `hexgrad/kokoro-82m` at about $0.0006 per 1,000 characters against ElevenLabs' $0.04–0.08). `voice.list` with `models: true` lists them all with prices, and with `model` lists one model's voices. OpenRouter voices return no timestamps, so each take is transcribed with word timings (`openai/whisper-large-v3-turbo`, about $0.00005 a line) and the heard words are aligned to the script (`alignmentFromWords` in `shared/narration.ts`), giving captions and cues the same timing data ElevenLabs' alignment gives. A cost-controls `narrationModel` can force either kind; a voice that belongs to the other vendor falls back to the model's default voice.

Music beds come from ElevenLabs (streamed, so long beds do not hit the gateway timeout) or from Lyria 3 via OpenRouter (`audio.musicModel` or `storyboard.music.model`: `google/lyria-3-pro-preview` for a full piece at $0.08, `google/lyria-3-clip-preview` for a 30 s loop at $0.04).

ElevenLabs caps simultaneous requests per plan (Creator: 3). Preparation starts ElevenLabs jobs at most `ELEVENLABS_CONCURRENCY` at a time (`cloudflare.config.ts`), and every ElevenLabs call waits and retries on a 429.

## Loudness

Exports are levelled after rendering: two-pass EBU R128 `loudnorm` in the renderer (`renderer/server/master.ts`), video stream copied, to the brand's `audio.loudness` (default −14 LUFS, true peak ≤ −1 dBTP; `"off"` keeps the mix as it is). `video.render` takes a per-export `loudness`. `video.audio` measures the mix before levelling and says what the render will do to it.

**Reconciliation.** Each night, after accruing storage, two optional jobs replace metered costs from the past week with what the vendor billed (`basis` becomes `vendor`). `admin.reconcile` runs them on demand, e.g. before producing statements for a month that just closed.

- fal: uses the existing `FAL_KEY`, which needs billing read access (the BILLING or FULL preset). Each request's charge is read from fal's billing-events API by its request id.
- Containers: set `CLOUDFLARE_ANALYTICS_TOKEN` to an API token with Account Analytics: Read. Containers are labelled with their instance name, so a run's CPU, memory and disk usage is read from the `containersUsageAdaptiveGroups` dataset over the run's window. This also replaces the full-CPU assumption with the CPU actually used.

## Cost controls

Each account can choose what Retween spends its money on (Account → Cost controls, or `account.controls` / `account.controls_update`; administrators can pass a `userId`). It can switch off generated clips, images, vector illustrations, cut-outs, music and sound effects. It can also cap clip resolution and length, image quality and export resolution, pick a cheaper narration model (Flash and Turbo cost half as much), and set its own monthly limit below the allowance.

Controls govern new spending only. Media that was already generated keeps being used, and changing a control never regenerates anything. Media hashes are taken before the limits are applied. When a storyboard asks for something that is switched off, `video.prepare` still succeeds with a cheaper stand-in and reports it. A clip becomes its first-frame image, else a generated still, else the brand backdrop. A still or vector becomes the brand backdrop, and music, sound effects and cut-outs are left out. Asking for one directly (`asset.generate_video` etc.) is refused with `disabled_by_controls`. `video.estimate`, `project.brief` and `whoami` all reflect the controls, so agents can plan within them. Vendor request ids are kept in `vendor_ref` for reconciliation. Free services (stock libraries, Iconify, OpenStreetMap, YouTube) cost nothing and are not recorded; Workers, D1 and Workflows requests are shared overhead.
