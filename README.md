# Story Nook

An AI-powered storybook generator for kids and parents. Type or dictate a story idea, and the app creates a fully illustrated, multi-page picture book you can read together — complete with page-by-page navigation and read-aloud narration.

**Live demo:** [story.davidloor.com](https://story.davidloor.com)

## Features

- **AI story generation** — Turns a short prompt into a complete children's story with per-page illustrations
- **Voice input** — Dictate prompts via the Web Speech API or native keyboard mic
- **Page-by-page reader** — Navigate with arrow buttons, keyboard arrows, or dot indicators
- **Read aloud** — Browser speech synthesis reads the story page by page, auto-advancing with pauses
- **Story library** — Browse saved stories as visual book cards with cover art
- **Responsive** — Designed for tablets and phones (couch-friendly for families)
- **Offline-safe images** — Falls back to SVG illustrations when image generation is unavailable

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | [Cloudflare Workers](https://developers.cloudflare.com/workers/) |
| Database | [Cloudflare D1](https://developers.cloudflare.com/d1/) (SQLite) |
| Object Storage | [Cloudflare R2](https://developers.cloudflare.com/r2/) |
| AI — Text | [Google Gemini 2.5 Flash](https://ai.google.dev/) |
| AI — Images | [Google Gemini 3.1 Flash Image Preview](https://ai.google.dev/) |
| Frontend | Vanilla HTML / CSS / JS (no framework, no build step) |

## Architecture

```
┌──────────────┐       ┌─────────────────────────┐
│   Browser    │──────▶│   Cloudflare Worker      │
│  (static UI) │◀──────│                          │
└──────────────┘       │  /api/stories/generate   │──▶ Gemini API (text + images)
                       │  /api/stories            │──▶ D1 (metadata)
                       │  /api/stories/:id        │──▶ D1 (story + pages)
                       │  /api/images/:key        │──▶ R2 (illustrations)
                       └─────────────────────────┘
```

Static assets (HTML, CSS, JS) are served directly from Workers Assets. The Worker handles all API routes, calling Gemini for generation and persisting results to D1 + R2.

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- A [Cloudflare account](https://dash.cloudflare.com/sign-up)
- A [Google AI Studio](https://aistudio.google.com/) API key for Gemini

### Setup

1. **Clone and install:**

```bash
git clone https://github.com/davo20019/story-book.git
cd story-book
npm install
```

2. **Create Cloudflare resources:**

```bash
npx wrangler d1 create storybook-db
npx wrangler r2 bucket create storybook-assets
```

3. **Configure:** Update `wrangler.toml` with the `database_id` returned by the D1 create command.

4. **Apply the database schema:**

```bash
npx wrangler d1 execute storybook-db --local --file=migrations/0001_init.sql
```

5. **Set the Gemini API key:**

```bash
# For local development, create a .dev.vars file:
cp .dev.vars.example .dev.vars
# Then edit .dev.vars and add your key

# For production:
npx wrangler secret put GEMINI_API_KEY
```

6. **Run locally:**

```bash
npm run dev
```

### Deploy

```bash
npm run deploy
```

Optionally configure a custom domain in `wrangler.toml` under `[[routes]]`.

## API

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/stories/generate` | Generate a new story from a prompt |
| `GET` | `/api/stories` | List all saved stories |
| `GET` | `/api/stories/:id` | Get a single story with all pages |
| `GET` | `/api/images/:key` | Serve a stored illustration from R2 |
| `GET` | `/api/health` | Health check |

### Generate request body

```json
{
  "prompt": "A brave fox and a shy firefly explore a glowing forest",
  "pageCount": 8
}
```

Optional fields: `transcript`, `audioBase64`, `audioMimeType` (for audio-based input).

## Project Structure

```
├── public/              # Static frontend (served by Workers Assets)
│   ├── index.html
│   ├── styles.css
│   └── app.js
├── src/
│   └── index.ts         # Cloudflare Worker — API routes + Gemini integration
├── migrations/
│   └── 0001_init.sql    # D1 database schema
├── wrangler.toml        # Cloudflare Workers configuration
├── tsconfig.json
└── package.json
```

## License

[MIT](LICENSE)
