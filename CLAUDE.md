# StoryBook

See [agents.md](./agents.md) for full project context, architecture, and conventions.

## Quick Reference

- **Deploy:** `npm run deploy`
- **Dev:** `npm run dev`
- **Typecheck:** `npm run typecheck`
- **Worker code:** `src/index.ts`
- **Frontend:** `public/` (vanilla HTML/CSS/JS, no build step)
- **Config:** Copy `wrangler.example.toml` → `wrangler.toml` (gitignored)
- **Secrets:** `GEMINI_API_KEY`, `TURNSTILE_SECRET_KEY` (via `wrangler secret put`)

## Rules

- Do not commit `wrangler.toml` — it contains deployment-specific values. Edit `wrangler.example.toml` for repo changes.
- Use `textContent` and DOM APIs in frontend JS, not `innerHTML` with user data.
- Escape all user content server-side with `escapeHtml()`.
- Keep the frontend framework-free — vanilla HTML/CSS/JS only.
- Test with `npx tsc --noEmit` before deploying.
