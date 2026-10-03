<div align="center">

# yt-dl

**A zero-configuration TikTok · Facebook · YouTube downloader that lives in Telegram — plus a matching web UI.**

Paste a link, get the file. No database, no admin panel, no telemetry.

[![Node.js](https://img.shields.io/badge/node-%3E%3D18-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Hono](https://img.shields.io/badge/Hono-4.x-E36002)](https://hono.dev)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Stars](https://img.shields.io/github/stars/toewaioo/tikwm-bot?style=flat&logo=github)](https://github.com/toewaioo/tikwm-bot/stargazers)
[![Issues](https://img.shields.io/github/issues/toewaioo/tikwm-bot)](https://github.com/toewaioo/tikwm-bot/issues)

[Features](#features) · [Quick start](#quick-start) · [Commands](#bot-commands) · [Routes](#http-routes) · [Deploy](#deployment)

</div>

---

## Overview

`yt-dl` is a single Node.js service that answers Telegram updates and serves a web
downloader from the same process. It ships as a Telegram bot and as a website, and
deliberately ships as **nothing else**: no database migrations, no admin dashboard,
no log aggregation, no accounts.

| You send | You get |
|---|---|
| A **TikTok** link | Watermark-free video, or the full photo carousel (live-photo slides as videos) + 🎵 audio button |
| A **Facebook** link | Best combined video + 🎵 audio button — messy app-share links are cleaned up first |
| A **YouTube** link | Cover image + quality menu (1080p → 360p, M4A/OPUS) served through short `/dl` redirect buttons |
| Any **text** | A YouTube search with tappable results and pagination |
| `/story @handle` | A TikTok profile's recent videos, tap to download |

The same three platforms are also available on the web UI at `/` — no login,
no storage, no cookies.

## Features

- **Three extractors, one flow** — TikTok via [TikWM](https://tikwm.com), Facebook
  and YouTube via tool77; results are normalized into one delivery pipeline.
- **Telegram-native delivery** — videos are sent by URL when they fit under 20 MB,
  otherwise the server downloads them and uploads the file itself.
- **Inline download menus** — YouTube buttons are short `/dl` links instead of raw
  CDN URLs (googlevideo links are 800–1500 chars each and blow past Telegram's
  reply-markup cap); the real URL is resolved at tap time.
- **Stateless by design** — extractor responses and button payloads live in an
  in-process TTL cache (`src/core/cache.ts`). Nothing about users or downloads is
  written anywhere.
- **Webhook + REST in one app** — Hono routes for Telegram, the site, and the AJAX
  extractor, mountable on Node or Vercel serverless without code changes.
- **No framework, no ORM** — raw Telegram Bot API calls, plain `fetch`, ~2,300
  lines of TypeScript you can read in one sitting.

## Quick start

### Prerequisites

- **Node.js 18+** (20+ recommended) — or [Bun](https://bun.sh) for installs
- A bot token from [@BotFather](https://t.me/BotFather)
- A public HTTPS URL for the webhook (any tunnel works for local testing)
- *(Optional)* A [YouTube Data API v3](https://console.cloud.google.com) key to enable search

### 1. Install

```bash
git clone https://github.com/toewaioo/tikwm-bot.git
cd tikwm-bot
bun install        # or: npm install
```

### 2. Configure

```bash
cp .env.example .env
```

| Variable | Required | Default | What it does |
|---|---|---|---|
| `BOT_TOKEN` | ✅ | — | Telegram bot token from @BotFather |
| `WEBHOOK_URL` | — | *(unset)* | Public HTTPS URL of `/webhook`; also locks `/set-webhook` to that domain |
| `BOT_USERNAME` | — | `YourBotUsername` | Shown on the web page's "Open in Telegram" link |
| `GOOGLE_API_KEY` | — | *(unset)* | YouTube Data API v3 key — required for plain-text search |
| `PORT` / `HOST` | — | `3000` / `0.0.0.0` | Bind address for the standalone server |
| `TEMP_DIR` | — | `storage/temp` | Scratch dir for large media (serverless: `/tmp`) |
| `CACHE_TTL` | — | `3600` | Lifetime of cached extractor results (seconds) |
| `TOOL77_CACHE_TTL` | — | `3600` | Lifetime of the YouTube download-menu buttons |
| `MAX_URL_UPLOAD_BYTES` | — | `20971520` | Send-by-URL ceiling before falling back to local download + upload |

### 3. Register the webhook

Open the connector route once — it points Telegram at this deployment's
`/webhook`:

```bash
curl https://your-domain/set-webhook
```

```json
{ "ok": true, "url": "https://your-domain/webhook", "telegram": { "ok": true, "result": true } }
```

No CLI, no secret, nothing to copy between machines. The CLI equivalent
still works if you'd rather run it from `.env`:

```bash
bun run set-webhook
```

### 4. Run

```bash
bun run dev          # build the embedded page + start with tsx
# or
bun run build && bun start
```

Open `http://localhost:3000`, send your bot a link, done.

<details>
<summary><b>Script reference</b></summary>

| Script | What it does |
|---|---|
| `bun run dev` | Embeds the web page and starts the server via tsx |
| `bun run build` | Embeds the web page and compiles TypeScript to `dist/` |
| `bun run start` | Runs the compiled server (`node dist/src/server.js`) |
| `bun run typecheck` | `tsc --noEmit` |
| `bun run embed` | Regenerates `src/views/indexHtml.ts` from `index.html` |
| `bun run set-webhook` | Registers `WEBHOOK_URL` with Telegram |

</details>

## Bot commands

| Command | Description |
|---|---|
| `/start` | Welcome message |
| `/help` | Usage summary |
| `/about` | What the bot is |
| `/story @handle` | Browse a TikTok account's recent videos |

Everything else is a link or a search phrase — no commands required.
A full player-facing guide lives in [`docs/USER_GUIDE.md`](docs/USER_GUIDE.md).

## HTTP routes

| Route | Method | Purpose |
|---|---|---|
| `/webhook` | `POST` | Telegram update entry point |
| `/set-webhook` | `GET`/`POST` | Registers this deployment's `/webhook` with Telegram |
| `/` | `GET` | Web downloader page |
| `/ajax`, `/` | `POST` | Extract a URL → JSON (video, cover, audio, image set) |
| `/dl` | `GET` | `302` redirect to the real CDN URL behind a YouTube menu button |
| `/proxy` | `GET` | Streams a YouTube file through this server (Google's CDN rejects off-origin fetches) |
| `/index.php?dl=1\|proxy=1\|ajax=1`, `/webhook.php` | — | Legacy aliases kept so old chat links keep working |

## Project structure

```
src/
├── app.ts               Hono routes: /webhook, /, /ajax, /dl, /proxy (+ legacy)
├── server.ts            Standalone entry — binds the port
├── config.ts            .env → typed config, dot-notation lookup
├── controllers/
│   └── bot.ts           The whole Telegram flow: routing, menus, delivery
├── services/
│   ├── telegram.ts      Thin Bot API wrapper (send/edit/markup/retry-on-parse-error)
│   ├── tikwm.ts         TikTok extraction (video, carousel, audio)
│   ├── tool77.ts        Facebook + YouTube extraction, format menus
│   ├── tiktokUser.ts    TikTok profile browsing
│   ├── youtubeSearch.ts YouTube Data API search
│   └── media.ts         Large-file download to temp + cleanup
├── core/
│   ├── cache.ts         In-memory TTL cache
│   ├── router.ts        Webhook decode → BotController
│   └── host.ts          AsyncLocalStorage scope for the request host
├── helpers/
│   ├── validator.ts     URL detection, Facebook normalization, redirect following
│   └── text.ts          Unicode-safe string helpers
└── views/               index.html (source of truth) + generated indexHtml.ts

api/index.ts             Vercel serverless entry (same app, different transport)
bin/set-webhook.ts       One-off CLI to register the webhook
scripts/embed-view.ts    Inlines the page so serverless builds need no fs reads
```

## Tech stack

| Layer | Choice |
|---|---|
| Runtime | Node.js 18+ (20+ recommended) · Bun for package management |
| HTTP | [Hono](https://hono.dev) on [`@hono/node-server`](https://github.com/honojs/node-server) |
| Language | TypeScript 5.9, `strict` mode |
| State | In-process TTL cache — **no database** |
| Delivery | Telegram Bot API (raw `fetch`, no SDK) |

## Deployment

### Long-running server

```bash
bun install && bun run build
bun start                      # or: node dist/src/server.js
```

Put it behind any HTTPS reverse proxy (Caddy, nginx) and point `WEBHOOK_URL` at
the public `/webhook` path. A process manager (systemd, pm2) keeps it up.

> **Note:** Node 18's `fetch` throws out of its own internal tick when a proxied
> stream is cancelled — `src/server.ts` installs a narrow guard so closing a
> download mid-flight can't take the bot down. Node 20+ never hits it.

### Vercel

`api/index.ts` adapts the same Hono app to a serverless function and
`vercel.json` rewrites every path to it, so all routes above keep working.

1. Import the repo at [vercel.com/new](https://vercel.com/new) (Bun is detected
   from `bun.lock`; `bun run build` runs automatically).
2. Add every variable from `.env.example` in **Project → Settings → Environment
   Variables**, plus `TEMP_DIR=/tmp` (the project directory is read-only).
3. Deploy, then connect it: `curl https://<app>.vercel.app/set-webhook`
   (or `WEBHOOK_URL=… bun run set-webhook`).

Things worth knowing:

- `vercel.json` caps the function at **60s** (Hobby limit) while the large-media
  path allows 120s — on Pro, raise `functions["api/index.ts"].maxDuration` or lower
  `MAX_URL_UPLOAD_BYTES`.
- `/proxy` streams YouTube files through Vercel, so it counts against your
  bandwidth quota.
- The cache is per-instance: a cold start expires the bot's download menus.
  Resending the link rebuilds them.

## Notes & limitations

- **Extraction runs on third-party services.** TikWM and tool77 are unofficial,
  undocumented endpoints — if they change or rate-limit, downloads fail until
  they recover. The code isolates both behind `src/services/`, so swapping an
  extractor is a one-file change.
- **Search needs `GOOGLE_API_KEY`.** Without it, plain-text messages return no
  results (links work fine).
- **Nothing is persisted.** Restarting the process expires download menus and
  cached audio buttons; users just resend the link.
- **Download buttons last ~1 hour** by design (`TOOL77_CACHE_TTL`), because the
  signed CDN URLs behind them expire too.

## Disclaimer

This project is for personal, educational use. It downloads publicly available
media through third-party services — only download content you own or have the
right to download, and respect each platform's terms of service. The authors are
not responsible for how you use it.

## Contributing

Issues and pull requests are welcome.

```bash
git clone https://github.com/toewaioo/tikwm-bot.git
cd tikwm-bot
bun install
bun run typecheck   # must pass before opening a PR
```

Please keep the no-database, no-admin, no-logs constraint intact — that's the
point of the project.

## License

Released under the [MIT License](LICENSE) © toewaioo.

If this bot saves you time, star ⭐ the repo — it helps others find it.
# tikwm-bot
