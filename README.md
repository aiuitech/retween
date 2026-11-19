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

**Infrastructure.** Worker + static assets, D1 (`retween`), R2 (`retween-media`, private; files are served through signed URLs), six Workflows (asset, pipeline, render, publish, footage, hosting), Cloudflare Stream for hosted videos, Cloudflare Email Sending (`EMAIL` binding) for invitations and notifications, and a Durable Object-backed Container (`standard-4`, one instance per render, stopped when the render finishes).

**Thumbnails and posters.** `thumbnail.design` draws up to three variants with the video's own renderer (a `thumbnail` tile kind in the `Sheet` composition: a one-frame-per-variant timeline of scene pictures without their text, with `ThumbnailOverlay` drawn over it) and shows each at full size and at feed sizes with the duration badge. `choose` saves one as a 1280×720 JPEG under 2 MB (`videos.thumbnail_asset_id`); `youtube.publish` sends it by default. Each render also takes a poster still of its opening before its container stops (`renders.poster_key`). Contracts are in `shared/thumbnail.ts`; constants the Remotion bundle needs are in the import-free `shared/thumbnail-layout.ts`, because the bundle cannot resolve `zod` from `shared/` inside the image.

**Reviews.** `review.request` opens a round on a video (`reviews`, `review_comments`) and returns a link to `/review/<id>?t=<token>`. The token is an HMAC of the review id (`services/reviews.ts`), so the page works without an account and the link can be shown again without being stored. The page plays the current export, or a 720p draft of the stretch, and the person leaves notes on moments, points on the frame or whole scenes, then submits them with a verdict. `review.get` waits for and returns the notes mapped to scenes and spoken words, with an image of the commented frames; `video.get` and `project.brief` flag unread notes. `youtube.publish` refuses anything beyond private without an approved round (or `personApproved`).

**Sharing.** A project's owner shares it by email address (`project.share`, or the project's Sharing tab) as an **editor** (everything except deleting the project and changing who has access) or a **viewer** (read everything, run checks and previews, change nothing). Someone with an account gets access at once; anyone else is emailed an invitation (`project_invites`, link `/invite/<id>?t=<token>`, the token an HMAC of the id as with reviews) and gets access when they sign up with that address, or open the link signed in with it. `project.members` lists who has access, `project.unshare` removes someone, withdraws an invitation or (with your own id) leaves. Access is checked in one place, `getProject` (`services/projects.ts`): each operation runs with `actor.access` set from its flags, so operations that only read (and are not `paid`) need a viewer and everything else an editor; owner-only operations ask for `"owner"`. Paid work is billed to whoever starts it, and storage to the owner. An account without a payment method that has projects shared with it is a **guest** (`billing: "guest"`): it can work in those projects but cannot create projects or start paid work until it adds one.

**Notifications.** `services/notifications.ts` records a row per person (`notifications`, shown in the web app's Inbox and by `notification.list`) and emails it through Cloudflare Email Sending unless the person turned that kind off (`notification_settings`, Account → Notifications, `notification.settings_update`). Kinds: a project shared with you, your access changing, someone accepting your invitation, review notes arriving (to whoever asked and every editor), and an export finishing (email off by default) or failing. Sending never fails the work that caused it. Locally, sent messages are written to `.cloudflare/tmp/email/` and named in the dev server's log. In production the sender's domain (`EMAIL_FROM`, `notifications@retween.app`) must be onboarded to Email Sending.
