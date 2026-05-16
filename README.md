# autorunclaude

Persistent Claude Code agent. Runs 24/7. Accepts commands from your **local terminal** and from **Telegram**. Uses your Claude **subscription** (not API key). Has full access to every skill, plugin, slash command, MCP server, and agent your local `claude` CLI sees.

## What it does

- Wraps `claude --print --output-format stream-json` in a long-lived Node.js daemon.
- Each user (terminal user or whitelisted Telegram user) gets their own persistent conversation session — survives restarts.
- Telegram bot streams Claude's response live by editing a single message until done.
- Optional cron-based **proactive triggers** to fire prompts on schedule.
- Cloud-portable: identical setup on Windows, macOS, Linux, VPS.

## Architecture

```
┌──────────────┐
│   Terminal   │──┐
└──────────────┘  │     ┌──────────────────────┐    ┌─────────────────────┐
                  ├────▶│  Agent Orchestrator  │───▶│  claude --print     │
┌──────────────┐  │     │                      │    │  (subscription)     │
│ Telegram Bot │──┘     │  - session manager   │    └─────────────────────┘
└──────────────┘        │  - per-user UUIDs    │           │
                        └──────────────────────┘           ▼
                                  ▲                ┌────────────────┐
                                  │                │ stream-json    │
                        ┌─────────┴──────────┐     │ stdout         │
                        │ Cron Scheduler     │     └────────────────┘
                        │ (proactive prompts)│
                        └────────────────────┘
```

See `docs/system-architecture.md` for details.

## Quick start

```bash
# 1. install
npm install

# 2. configure
cp .env.example .env
# fill in TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_USER_IDS

# 3. ensure claude CLI is logged in via subscription
claude auth login

# 4. dev run (with terminal channel + Telegram)
npm run start:dev

# 5. production daemon
npm run build
npm run pm2:start
npm run pm2:logs
```

Full bot creation walkthrough in [`docs/setup-guide.md`](docs/setup-guide.md).

## Channels

### Terminal

Type prompts directly. Commands:

- `/new` — drop current conversation, start fresh
- `/status` — show session key
- `/help` — list commands
- `/exit` — stop daemon

### Telegram

Whitelist your Telegram user ID via `TELEGRAM_ALLOWED_USER_IDS`. Then DM the bot. Commands:

- `/new` — fresh conversation
- `/status` — session info
- `/help` — help menu

Each Telegram user gets a separate session (or all share one if `SESSION_MODE=shared`).

## Proactive triggers

Define in `.env`:

```env
PROACTIVE_TRIGGERS=[{"name":"morning-check","cron":"0 9 * * *","prompt":"Summarise overnight server logs"}]
```

Or point to a JSON file:

```env
PROACTIVE_TRIGGERS=./triggers.json
```

Results push to whatever channel `PROACTIVE_NOTIFY` says (`terminal`, `telegram`, `both`).

## Deployment

### Local (Windows / macOS / Linux)

```bash
npm install -g pm2
npm run build
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup     # optional — auto-start on boot
```

### Cloud / VPS

Identical commands. Make sure:

1. `claude` CLI installed and `claude auth login` completed under the same user
2. `.env` present in project root
3. Project directory the agent operates in (`CLAUDE_WORK_DIR`) actually exists

Tested on Node 20 LTS.

## Security note

`CLAUDE_PERMISSION_MODE=bypassPermissions` means Claude can read/write any file under `CLAUDE_WORK_DIR` and run any shell command without confirmation. Run only inside trusted directories. Whitelist Telegram IDs carefully — anyone on the whitelist gets full shell access through your machine.
