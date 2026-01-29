# Moltbot Inspector 🔍

Moltbot is incredibly powerful — it can run shell commands, edit files, manage git repos, install packages, and do pretty much anything on your machine. But sometimes it can go off the rails, and you might never even know about it.

**Moltbot Inspector** is a local web app built with **React + Vite** that lets you review every conversation your bot has ever had — including deleted sessions — and flag dangerous actions it may have taken without your knowledge.

> ⚠️ **Non-destructive & read-only.** Inspector runs alongside Moltbot and has zero impact on your sessions. It never modifies, deletes, or interferes with any conversations — it only reads the JSONL session files from disk. Think of it as a security camera for your bot: it watches, highlights dangerous actions, and tracks your review progress, but never touches anything.

## What it does

- **Browse all sessions** — active, orphaned, and soft-deleted
- **Danger detection** — automatically scans for risky commands (`rm -rf`, `git push --force`, `git reset --hard`, config edits, `sudo`, etc.) and highlights them with red/yellow borders
- **Read progress tracking** — click any message to mark everything above as reviewed; blue divider shows where you left off
- **Live updates via SSE** — new messages and sessions appear automatically with toast notifications
- **localStorage persistence** — active session, filter, sort, search query, expand state, and danger-only mode are all preserved across page reloads
- **Session renaming** — click session title to give it a custom label
- **Mobile responsive** — sidebar as overlay with FAB toggle button
- **Message search** — filter messages by text content
- **Expand/collapse all** — toggle all tool calls and thinking blocks at once
- **Danger-only mode** — view only flagged messages (blocks marking in this mode)

## Setup

```bash
npm install
```

## Development

Run the backend server and Vite dev server:

```bash
# Terminal 1: Backend (port 9100)
node server.js

# Terminal 2: Vite dev server (port 5173, proxies /api to backend)
npm run dev
```

Open http://localhost:5173

## Production Build

```bash
npm run build
```

This produces a `dist/` folder. To serve it, either:
1. Point your backend's static file serving to `dist/` instead of the project root
2. Use any static file server to serve `dist/` and proxy `/api` to the backend

## Configuration

### Environment variables

- `SESSIONS_DIR` — path to session JSONL files (default: `~/.clawdbot/agents/main/sessions`)
- `PORT` — backend port (default: `9100`)
- `DATA_DIR` — path to user data (default: `~/.moltbot-inspector`)

### User data (`~/.moltbot-inspector/`)

On first launch, Inspector creates `~/.moltbot-inspector/` and copies the default `danger-rules.json` there. You can customize the rules — they won't be overwritten on updates.

- `danger-rules.json` — danger detection rules (regex patterns + tool-based rules)
- `progress.json` — read progress (server-side, persists across devices)

## Files

- `server.js` — Node.js backend with SSE, session APIs, danger scanning
- `danger-rules.json` — default danger rules (copied to `~/.moltbot-inspector/` on first run)
- `src/` — React + TypeScript application source
