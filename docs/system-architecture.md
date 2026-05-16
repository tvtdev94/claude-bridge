# System architecture

## Process model

- **Single Node.js daemon** boots `src/index.ts`.
- Inside that one process: a terminal REPL, a Telegram bot, and a cron scheduler all share **one orchestrator → one runner → one session manager**.
- Each user prompt → spawns a **short-lived `claude --print` child process**, parses its stream-json stdout, then exits.
- Conversation continuity preserved via Claude's `--resume <session-id>`.

```
Process tree at runtime:
  node dist/index.js   (long-lived daemon)
    └─ claude ...      (transient, one per active prompt)
```

## Modules

| File | Responsibility |
|---|---|
| `src/index.ts` | Wires everything, handles signals, graceful shutdown |
| `src/config.ts` | Loads `.env`, validates, types |
| `src/utils/logger.ts` | pino logger, pretty in dev |
| `src/core/types.ts` | Shared types: `SessionKey`, `RunEvent`, etc. |
| `src/core/claude-runner.ts` | Spawn `claude --print --output-format stream-json`, parse events |
| `src/core/session-manager.ts` | `Map<channel:identity, sessionId>` persisted to `data/sessions.json` |
| `src/core/agent-orchestrator.ts` | Single entry point. Looks up session, runs Claude, aggregates events |
| `src/channels/terminal-channel.ts` | readline REPL |
| `src/channels/telegram-channel.ts` | grammy bot, auth, streaming edits |
| `src/scheduler/proactive-trigger-scheduler.ts` | node-cron firing prompts |

## Data flow

```
user types prompt
       │
       ▼
channel.handlePrompt
       │
       ▼
agent.ask({sessionKey, prompt})
       │
       ├── sessions.get(sessionKey) → existing UUID or null
       │
       ▼
runner.run({prompt, resumeSessionId})
       │
       ▼
spawn: claude --print --output-format stream-json \
              --include-partial-messages --verbose \
              --permission-mode bypassPermissions \
              [--resume <uuid>]
       │
       ▼
parse stdout line-by-line as JSON events
       │
       ▼
emit RunEvent stream:
  start  → save sessionId
  text   → forward to channel (live)
  final  → consolidated text + cost + duration
  error  → surface to user
       │
       ▼
sessions.set(sessionKey, sessionId)
       │
       ▼
return AskResult to channel
       │
       ▼
channel renders to user
```

## Session keys

`SessionKey = { channel, identity }`

| Channel | Identity | Session mode `per-user` | Session mode `shared` |
|---|---|---|---|
| terminal | `'local'` (always) | one session for the local user | one session per channel |
| telegram | Telegram user ID | one session per Telegram user | one session for all Telegram users |
| scheduler | `proactive:<trigger-name>` | dedicated session per trigger | dedicated session per trigger |

Proactive triggers always run in their own dedicated session so they don't pollute user conversations.

## Subscription auth (vs API key)

We invoke the user's installed `claude` CLI as a subprocess. That CLI uses whatever auth it's logged in with — typically OAuth subscription via `claude auth login`. The init event from stream-json confirms it: `"apiKeySource":"none"` means subscription, not API key.

Consequence: **costs displayed by `result.total_cost_usd` are theoretical** — what you'd pay on the API. Your subscription absorbs them.

## Telegram streaming UX

To avoid spamming the user with N messages as Claude streams:

1. Send a placeholder `🧠 thinking…`.
2. As text chunks arrive, accumulate them.
3. Every `STREAM_EDIT_INTERVAL_MS` (1500ms by default), edit that one placeholder with the accumulated text.
4. When `final` event fires, replace placeholder with the canonical final text.
5. If final text exceeds Telegram's ~4000-char limit, send extra chunks as new messages.

Edits that fail (rate limit, deletion) are silently ignored — next edit attempt will retry.

## Cloud portability

No assumptions about Windows or POSIX. Everything that could differ:

- `path` operations use `node:path`
- subprocess uses `shell: false` (no shell parsing)
- session storage is `data/sessions.json` under `process.cwd()`
- `.env` loaded by `dotenv`

To migrate to VPS: copy repo, `npm install`, `claude auth login`, copy `.env`, `pm2 start`.

## Failure modes & recovery

| Failure | Behaviour |
|---|---|
| `claude` subprocess crashes | error surfaced to user, daemon stays up |
| Subprocess hangs | killed after `CLAUDE_TIMEOUT_MINUTES` |
| Telegram network error | grammy auto-retries, logged |
| Daemon crashes | PM2 auto-restarts (max_restarts: 20, delay 5s) |
| Daemon OOM | PM2 restarts at 1GB memory |
| Session file corrupted | warned, starts with empty session map |

## Extending

- **Add a channel** (e.g. Discord, Slack): implement same interface as `TerminalChannel` / `TelegramChannel` — accept user input, call `agent.ask()`, render response. Wire in `src/index.ts`.
- **Per-user permission overrides**: extend `AgentOrchestrator.ask` to read a per-user permission policy.
- **Persistent conversation log**: hook `onEvent` in `agent.ask()` and append events to a JSON Lines file.
- **Approval workflow**: switch `bypassPermissions` to `default` and surface permission prompts back to the user via the channel.
