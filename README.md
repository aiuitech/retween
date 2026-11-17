# Retween

A video studio that agents operate. A project keeps a brand; a storyboard says what each scene shows and says; Retween voices it, finds or generates the pictures, times every scene to the recorded audio, and renders it at any aspect ratio.

Live at https://retween.app. Three surfaces over one API:

| Surface | Where | Auth |
| --- | --- | --- |
| MCP | `https://retween.app/mcp` | OAuth (browser sign-in), or an API key as a bearer token |
| CLI | `npm install -g https://retween.app/cli/retween.tgz` | `retween login` (device flow), or `RETWEEN_API_KEY` |
| Web | https://retween.app | Google sign-in. Profile, API keys, library, admin dashboard |

## How it fits together

```
shared/            contracts used by every part
  brand.ts           the brand kit (what a project remembers)
  storyboard.ts      what an author writes: scenes, no durations
  compose.ts         storyboard + measured media → timeline (pure function)
  timeline.ts        the render contract: absolute frames, resolution independent
  narration.ts       pronunciation respelling and word timings
src/worker/        the Cloudflare Worker
  ops/               every capability, defined once (name, description, zod input, handler)
  routes/mcp.ts      ops → MCP tools
  index.ts           ops → REST (POST /api/v1/ops/<name>), auth, uploads, signed file URLs
  workflows/         asset generation, prepare → compose pipeline, container rendering
  providers/         OpenRouter (images, clips), ElevenLabs (voice, music, sfx), stock sources
  auth/              better-auth: Google, admin, API keys, device flow, OAuth provider for MCP
src/web/           the web app (React, served as static assets by the Worker)
cli/               the CLI: builds its commands from GET /api/v1/ops
renderer/          Remotion + headless Chrome behind a small HTTP server (the container image)
migrations/        D1 schema
```

An operation added to `src/worker/ops/` appears as an MCP tool, a CLI command and a REST endpoint with no further work.

**Why timing is trustworthy.** Storyboards carry no durations. `video.prepare` generates narration (with word-level timestamps), stills, stock and sound effects first; then sizes clips and music to the voice; only then composes the timeline. Scene lengths, bullet cues, captions and music ducking are all derived from measured audio.

**Infrastructure.** Worker + static assets, D1 (`retween`), R2 (`retween-media`, private; files are served through signed URLs), three Workflows, and a Durable Object-backed Container (`standard-4`, one instance per render, stopped when the render finishes).

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

Google OAuth client: authorised redirect URI `https://retween.app/api/auth/callback/google`.

## Access

Anyone can sign in with Google, but a new account can do nothing until an administrator approves it. Emails in `SUPERUSER_EMAILS` (`cloudflare.config.ts`) become administrators on first sign-in. Each account has a monthly generation budget (default $25, `DEFAULT_MONTHLY_BUDGET_CENTS`) that administrators can change per person.
