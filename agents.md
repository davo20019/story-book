# StoryBook — Agent Reference

## What is this?

StoryBook is an AI-powered children's storybook generator. Parents and kids type or dictate a story idea, and the app generates a fully illustrated, multi-page picture book they can read together — with page-by-page navigation, read-aloud narration, and reference photo support.

**Live:** https://story.davidloor.com

## Tech Stack

- **Runtime:** Cloudflare Workers (TypeScript)
- **Database:** Cloudflare D1 (SQLite)
- **Object Storage:** Cloudflare R2 (illustrations)
- **AI — Text:** Google Gemini 2.5 Flash
- **AI — Images:** Google Gemini 3.1 Flash Image Preview (Nano Banana 2)
- **Frontend:** Vanilla HTML / CSS / JS — no framework, no build step

## Project Structure

```
src/index.ts          — Worker entry point: API routes, Gemini integration, rate limiting, Turnstile
public/index.html     — Single-page HTML shell with tab navigation (Create / My Books / Read)
public/styles.css     — All styles (Fredoka + Nunito fonts, candy color palette, animations)
public/app.js         — Client-side logic: form handling, photo uploads, reader, voice picker, speech
migrations/           — D1 schema migrations (stories, pages, rate_limits tables)
wrangler.example.toml — Cloudflare Workers config template (copy to wrangler.toml)
.dev.vars.example     — Secret env vars template (GEMINI_API_KEY)
```

## Key Architecture Decisions

- **No frontend framework.** Static HTML/CSS/JS served by Workers Assets. Keep it simple.
- **Tab-based navigation** (Create / My Books / Read) instead of multi-column layout — optimized for tablets and phones.
- **Page-by-page reader** with arrow navigation, not a scroll-through-all-pages layout.
- **Character sheet system:** Gemini generates a detailed `characterSheet` (visual description of every character) during story text generation. This sheet is prepended to every image prompt for visual consistency across pages.
- **Reference photo uploads:** Users can attach photos (people, pets, places) that are sent as `inlineData` to Nano Banana 2 alongside each page's image prompt.
- **Rate limiting:** IP-based daily cap stored in D1 `rate_limits` table. Configurable via `DAILY_LIMIT_PER_IP` env var.
- **Turnstile:** Optional Cloudflare Turnstile bot protection. Activates only when `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` are configured.
- **Voice selection:** Browser SpeechSynthesis with auto-selection of best voice + user-facing dropdown picker.

## Database Schema

**stories** — `id` (TEXT PK), `title`, `prompt`, `transcript`, `cover_image_key`, `created_at`, `updated_at`

**pages** — `id` (INTEGER PK), `story_id` (FK → stories), `page_number`, `text`, `image_prompt`, `image_key`, `created_at`

**rate_limits** — `ip` (TEXT), `date_key` (TEXT), `request_count` (INTEGER), PK(ip, date_key)

## API Routes

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/config` | Public config (Turnstile site key) |
| GET | `/api/health` | Health check |
| GET | `/api/stories` | List all stories |
| GET | `/api/stories/:id` | Get story with pages |
| POST | `/api/stories/generate` | Generate new story (accepts prompt, pageCount, referenceImages, turnstileToken) |
| GET | `/api/images/:key` | Serve illustration from R2 |

## Development Commands

```bash
npm install          # Install dependencies
npm run dev          # Local dev server (wrangler dev)
npm run deploy       # Deploy to Cloudflare
npm run typecheck    # TypeScript type checking
```

## Secrets (not in repo)

- `GEMINI_API_KEY` — Set via `npx wrangler secret put GEMINI_API_KEY`
- `TURNSTILE_SECRET_KEY` — Set via `npx wrangler secret put TURNSTILE_SECRET_KEY` (optional)

## Conventions

- All user-facing text uses `textContent` (not `innerHTML`) to prevent XSS.
- Server-side HTML in SVG fallbacks uses `escapeHtml()`.
- The frontend uses DOM APIs to build elements, not string interpolation.
- Wrangler.toml is gitignored — `wrangler.example.toml` is the template.
- Commits should not include deployment-specific values (database IDs, custom domains, API keys).
