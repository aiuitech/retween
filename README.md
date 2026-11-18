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
  providers/         OpenRouter (images, clips), ElevenLabs (voice, music, sfx), stock sources, YouTube
  auth/              better-auth: Google, admin, API keys, device flow, OAuth provider for MCP
src/web/           the web app (React, served as static assets by the Worker)
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

**Infrastructure.** Worker + static assets, D1 (`retween`), R2 (`retween-media`, private; files are served through signed URLs), five Workflows (asset, pipeline, render, publish, footage), and a Durable Object-backed Container (`standard-4`, one instance per render, stopped when the render finishes).

## Develop

```sh
npm install && npm --prefix renderer install
cp .dev.vars.example .dev.vars        # fill in the keys
npm run db:migrate:local
npm run renderer                      # terminal 1: renderer on :8099 (no Docker needed)
npm run dev                           # terminal 2: http://localhost:5173
```

Local development has a sign-in shortcut that is compiled out of production builds:
`curl -X POST localhost:5173/api/dev/login -H 'content-type: application/json' -d '{"email":"you@example.com"}'`
returns a session token (use it as a bearer token) and sets the browser cookie.

After changing the database schema: `npm run db:generate`, then `npm run db:migrate:local`.
After changing auth plugins: `npx auth generate --config auth.gen.ts --output src/worker/db/auth-schema.ts --adapter drizzle --dialect sqlite -y`, then the two commands above.

## Deploy

Uses the `cf` CLI (not Wrangler); configuration is in `cloudflare.config.ts`. Docker must be running to build the renderer image.

```sh
npm run db:migrate          # apply new migrations to production D1
npm run deploy              # build and deploy; existing secrets are kept
npm run deploy:secrets      # same, and upload secrets from .secrets.production
```

Secrets (in `.secrets.production`, which is git-ignored): `BETTER_AUTH_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `OPENROUTER_API_KEY`, `ELEVENLABS_API_KEY`, and optionally `PEXELS_API_KEY`, `PIXABAY_API_KEY` (more stock) and `FAL_KEY` (subject cut-outs and vector illustrations through fal.ai).

Google OAuth client: authorised redirect URIs `https://retween.app/api/auth/callback/google` and `https://retween.app/api/youtube/callback` (plus the `http://localhost:5173/…` equivalents for local development).

## YouTube publishing

`youtube.connect` hands the person a link (`/api/youtube/connect`); they pick a channel on Google's consent screen and it appears under Connect → YouTube in the web app. `youtube.publish` sends a finished render to it through the `retween-publish` Workflow: a resumable upload streamed from R2 in 32 MiB chunks, then captions (SRT from the timeline's narration timings), an optional thumbnail and playlist. Credits owed for third-party media are appended to the description. Uploads default to private.

It uses the same Google OAuth client as sign-in, asking separately for the `youtube.force-ssl` scope (needed for captions and playlists; `youtube.upload` alone cannot do those). Refresh tokens are stored AES-GCM-encrypted with a key derived from `BETTER_AUTH_SECRET`. Setup in Google Cloud:

1. Enable the **YouTube Data API v3** on the project that owns the OAuth client.
2. Add the `…/auth/youtube.force-ssl` scope to the OAuth consent screen and the callback redirect URIs above.
3. While the consent screen is in testing, only listed test users can connect. Going beyond that needs Google's verification of the sensitive scope.

Quota: uploads have their own allowance of 100 a day per Cloud project. Captions cost 400 units each, and thumbnails and playlist additions 50 each, out of the shared 10,000 units a day.

## Access

Anyone can sign in with Google, but a new account can do nothing until an administrator approves it. Emails in `SUPERUSER_EMAILS` (`cloudflare.config.ts`) become administrators on first sign-in. Each account has a monthly generation budget (default $25, `DEFAULT_MONTHLY_BUDGET_CENTS`) that administrators can change per person.

## Costs per account

Every vendor charge is written to the usage ledger (`usage_events`) against the account that caused it, as soon as the vendor answers. `admin.costs` turns the ledger into a statement per account for any period, by provider, kind and model, and applies a markup (`markup: 1.3` → cost × 1.3). The monthly budget is checked against the same ledger.

| Vendor | What is charged | How the cost is known (`basis`) |
| --- | --- | --- |
| OpenRouter | images, video clips | `vendor`: `usage.cost` from the response (`list` if it is missing) |
| ElevenLabs | narration | `metered`: the `character-cost` header × our rate per 1k characters |
| ElevenLabs | music, sound effects | `metered` / `list`: length × published per-minute price |
| fal | cut-outs, vector art | `metered`: `x-fal-billable-units` × the endpoint's price from fal's pricing API (`list` as a fallback) |
| Cloudflare Containers | renders, preview frames | `metered`: container run time from start to stop (measured in `Renderer`), including the idle time before it sleeps |
| Cloudflare R2 | stored assets and renders | `metered`: a nightly cron charges each account one day of storage |

Rates that are not reported per request live in `src/worker/services/pricing.ts`; keep them in line with the invoices.

**Reconciliation.** Each night, after accruing storage, two optional jobs replace metered costs from the past week with what the vendor billed (`basis` becomes `vendor`). `admin.reconcile` runs them on demand, e.g. before producing statements for a month that just closed.

- fal: uses the existing `FAL_KEY`, which needs billing read access (the BILLING or FULL preset). Each request's charge is read from fal's billing-events API by its request id.
- Containers: set `CLOUDFLARE_ANALYTICS_TOKEN` to an API token with Account Analytics: Read. Containers are labelled with their instance name, so a run's CPU, memory and disk usage is read from the `containersUsageAdaptiveGroups` dataset over the run's window. This also replaces the full-CPU assumption with the CPU actually used.

## Cost controls

Each account can choose what Retween spends its money on (Account → Cost controls, or `account.controls` / `account.controls_update`; administrators can pass a `userId`). It can switch off generated clips, images, vector illustrations, cut-outs, music and sound effects. It can also cap clip resolution and length, image quality and export resolution, pick a cheaper narration model (Flash and Turbo cost half as much), and set its own monthly limit below the allowance.

Controls govern new spending only. Media that was already generated keeps being used, and changing a control never regenerates anything. Media hashes are taken before the limits are applied. When a storyboard asks for something that is switched off, `video.prepare` still succeeds with a cheaper stand-in and reports it. A clip becomes its first-frame image, else a generated still, else the brand backdrop. A still or vector becomes the brand backdrop, and music, sound effects and cut-outs are left out. Asking for one directly (`asset.generate_video` etc.) is refused with `disabled_by_controls`. `video.estimate`, `project.brief` and `whoami` all reflect the controls, so agents can plan within them. Vendor request ids are kept in `vendor_ref` for reconciliation. Free services (stock libraries, Iconify, OpenStreetMap, YouTube) cost nothing and are not recorded; Workers, D1 and Workflows requests are shared overhead.
