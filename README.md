# Moltbot Inspector 🔍

**Your AI agent has full access to your machine. Are you sure it's behaving?**

[Moltbot](https://molt.bot) (and Clawdbot) can run shell commands, edit files, push to git, install packages, access your camera, take screenshots — essentially do *anything* on your system. It runs autonomously in background sessions, cron jobs, and sub-agents. Most of the time, you never see what it does.

**Moltbot Inspector** lets you see everything. It's a local web app that reads your bot's session history and shows you exactly what happened — every command, every file edit, every tool call. It automatically flags dangerous actions so you can catch problems before they escalate.

## When you need this

- 🤔 **"What did my bot do while I was away?"** — Browse all sessions including deleted ones
- 🚨 **"Did it run anything dangerous?"** — Auto-detects `rm -rf`, `git push --force`, `sudo`, config edits, secret exposure, and more
- 📱 **"Did it access my camera/screen?"** — Flags surveillance actions (screenshots, camera, location tracking)
- 📊 **"I have 100+ sessions, how do I review them all?"** — Track read progress, filter by status, mark sessions as reviewed
- 🔄 **"I want to monitor in real-time"** — Live updates via SSE, toast notifications for new messages

## Quick start

```bash
npx moltbot-inspector
```

Opens at http://localhost:9100. That's it.

### Custom port

```bash
PORT=9101 npx moltbot-inspector
```

### Custom sessions directory

```bash
SESSIONS_DIR=~/.moltbot/agents/main/sessions npx moltbot-inspector
```

## What it detects

| Category | Examples | Severity |
|----------|----------|----------|
| **Destructive filesystem** | `rm -rf`, `shred`, `find -delete` | 🔴 Critical |
| **Git destructive** | `git push --force`, `git reset --hard`, `git clean -f` | 🔴 Critical |
| **Repo/account actions** | `gh repo delete`, `gh repo edit --visibility public` | 🔴 Critical |
| **Config changes** | `sed -i`, writing to `.env`, `.ssh/`, `.zshrc` | 🟡 Warning |
| **Package/system** | `sudo`, `brew uninstall`, `chmod 777` | 🟡 Warning |
| **Process killing** | `kill -9`, `killall`, `pkill` | 🟡 Warning |
| **Secrets/network** | `curl -X POST`, exported tokens/passwords | 🟡 Warning |
| **Surveillance** | Screenshots, camera access, screen recording, location | 🟡 Warning |
| **Cron changes** | `crontab`, `launchctl`, `systemctl` | 🟡 Warning |

Rules are fully customizable — edit `~/.moltbot-inspector/danger-rules.json`.

## Features

- **Multi-axis filtering** — filter by review status (unread/in progress/reviewed), session type (active/orphan/deleted), and danger level — all combinable
- **Read progress tracking** — click any message to mark everything up to that point as reviewed; a blue divider shows where you left off
- **Live updates** — new messages and sessions appear automatically with toast notifications
- **Tool call previews** — see URLs, file paths, search queries, and commands inline without expanding
- **Session renaming** — click the title to give any session a custom label
- **Message search** — full-text search within a session
- **Mobile responsive** — works on phones and tablets
- **State persistence** — all filters, sort order, and UI state saved in localStorage

## Live monitoring

Inspector watches your sessions directory in real-time. When your bot starts a new conversation, receives a message, or runs a tool — it appears instantly in the UI. No need to refresh the page.

- New sessions appear in the sidebar automatically
- New messages stream into the currently open session
- Toast notifications show activity in other sessions
- Works for background sessions, cron jobs, and sub-agents too

## Privacy & security

- 🔒 **100% local** — everything runs on your machine. No cloud, no telemetry, no external connections
- 📁 **Read-only** — Inspector never modifies, deletes, or interferes with your sessions. It only reads JSONL files from disk
- 🏠 **Localhost only** — server binds to `127.0.0.1` by default, inaccessible from the network
- 💾 **Your data stays yours** — progress and settings stored in `~/.moltbot-inspector/`, never sent anywhere

## Configuration

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `9100` | Server port |
| `HOST` | `127.0.0.1` | Bind address (localhost only by default) |
| `SESSIONS_DIR` | auto-detect (`~/.moltbot/` or `~/.clawdbot/`) | Path to session JSONL files |
| `DATA_DIR` | `~/.moltbot-inspector` | User config and progress storage |

### User data (`~/.moltbot-inspector/`)

Created automatically on first launch:

- `danger-rules.json` — danger detection rules (customize freely, won't be overwritten on updates)
- `progress.json` — read progress (persists across devices if you sync the folder)

### Remote access via Tailscale

To access Inspector from your phone or another device:

```bash
# Serve local port via Tailscale HTTPS
tailscale serve https:9100 / http://localhost:9100
```

Then open `https://your-machine.tailnet.ts.net:9100` from any device on your tailnet.

## Development

```bash
git clone https://github.com/Lukavyi/moltbot-inspector.git
cd moltbot-inspector
npm install

# Terminal 1: Backend
node server.js

# Terminal 2: Vite dev server with HMR
npm run dev
```

Open http://localhost:5173 (proxies API to backend).

```bash
npm test          # Unit tests (Vitest)
npm run build     # Production build → dist/
```

## License

MIT
