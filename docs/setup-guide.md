# Setup guide

End-to-end setup, including Telegram bot creation.

## Prerequisites

- Node.js 20 LTS or newer (`node --version`)
- `claude` CLI installed and logged in (`claude auth login`)
- A Telegram account

## 1. Install project

```bash
cd D:\WORKSPACES\autorunclaude
npm install
```

## 2. Create your Telegram bot

You'll talk to `@BotFather` on Telegram. It's an official Telegram bot that creates other bots.

### Step-by-step

1. **Open Telegram → search `@BotFather`** → start a chat.

2. **Send `/newbot`**. BotFather replies:
   > Alright, a new bot. How are we going to call it? Please choose a name for your bot.

3. **Send a display name** for the bot, e.g. `My AutoRun Claude`. This is what users see.

4. BotFather asks:
   > Good. Now let's choose a username for your bot. It must end in `bot`.

   **Send a username**, e.g. `my_autorun_claude_bot`. Must be unique across Telegram.

5. BotFather replies with success message containing:
   > Use this token to access the HTTP API:
   > `123456789:ABC-DEF1234ghIkl-zyx57W2v1u123ew11`

   **Copy this token.** This is your `TELEGRAM_BOT_TOKEN`.

6. *(Optional but recommended)* Send `/setprivacy` → choose your bot → `Disable`. This lets the bot read all messages in groups, not only ones starting with `/`. Only do this if you plan to add the bot to a group.

7. *(Optional)* `/setdescription`, `/setabouttext`, `/setuserpic` to customise the bot's profile.

### Find your Telegram user ID

The bot only accepts commands from whitelisted user IDs.

1. On Telegram, search `@userinfobot` → start chat → it replies with your numeric ID (e.g. `123456789`).
2. Add that ID to `TELEGRAM_ALLOWED_USER_IDS`.

For team members, ask each to message `@userinfobot` and send you their ID. Add them comma-separated:
```env
TELEGRAM_ALLOWED_USER_IDS=123456789,987654321,555666777
```

### (Optional) Allow a group chat

If you want the bot to respond in a Telegram group:

1. Add your bot to the group.
2. Visit `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates` in a browser.
3. Find the `"chat":{"id":-1001234567890,...` — that negative number is the chat ID.
4. Add to `.env`:
   ```env
   TELEGRAM_ALLOWED_CHAT_IDS=-1001234567890
   ```

## 3. Configure `.env`

```bash
cp .env.example .env
```

Open `.env` and fill in:

```env
TELEGRAM_BOT_TOKEN=123456789:ABC-DEF1234ghIkl-zyx57W2v1u123ew11
TELEGRAM_ALLOWED_USER_IDS=123456789
CLAUDE_WORK_DIR=D:\WORKSPACES\autorunclaude
CLAUDE_PERMISSION_MODE=bypassPermissions
ENABLE_TERMINAL_CHANNEL=true
ENABLE_TELEGRAM_CHANNEL=true
SESSION_MODE=per-user
```

`CLAUDE_WORK_DIR` is the directory Claude operates in (read/write/run-commands scope). Change to wherever you want the agent to work — typically a code project directory.

## 4. First run (dev mode)

```bash
npm run start:dev
```

You should see:

```
[INFO] autorunclaude starting
[INFO] telegram bot started {"username":"my_autorun_claude_bot"}
autorunclaude terminal channel ready. Type /help for commands.
›
```

**Test terminal:**

```
› what's the current directory?
```

**Test Telegram:** open your bot on Telegram → send `/help` → then any prompt.

## 5. Daemonize for 24/7

```bash
npm install -g pm2
npm run build
npm run pm2:start
```

Useful PM2 commands:

```bash
pm2 logs autorunclaude     # tail logs
pm2 restart autorunclaude  # restart
pm2 stop autorunclaude     # stop
pm2 status                 # see all processes
pm2 save && pm2 startup    # auto-start on boot
```

PM2 disables the terminal channel automatically (no TTY available).

## 6. Proactive triggers (optional)

Schedule recurring prompts.

**Option A — inline JSON in `.env`:**

```env
PROACTIVE_TRIGGERS=[{"name":"daily-summary","cron":"0 9 * * *","prompt":"Read today's git activity and summarise in 5 bullets"}]
PROACTIVE_NOTIFY=telegram
```

**Option B — JSON file:**

Create `triggers.json` at project root:

```json
[
  {
    "name": "daily-summary",
    "cron": "0 9 * * *",
    "prompt": "Read today's git activity and summarise in 5 bullets"
  },
  {
    "name": "hourly-health",
    "cron": "0 * * * *",
    "prompt": "Check `pm2 status` and report anything unhealthy",
    "notify": "telegram"
  }
]
```

Then:
```env
PROACTIVE_TRIGGERS=./triggers.json
```

Cron syntax: `minute hour day month dow`. Examples:
- `0 9 * * *` — every day at 09:00
- `*/15 * * * *` — every 15 minutes
- `0 9 * * 1-5` — every weekday 09:00

Timezone follows the `TZ` env variable, default system local time.

## 7. Move to VPS / cloud later

Same steps on the server:

```bash
git clone <your-repo> autorunclaude
cd autorunclaude
npm install
claude auth login     # link your subscription on this machine too
cp .env.example .env  # then edit
npm run build
pm2 start ecosystem.config.cjs
pm2 save && pm2 startup
```

Your subscription is tied to your Anthropic account, so you can use `claude auth login` on multiple machines (subject to subscription concurrency limits).

## Troubleshooting

| Symptom | Fix |
|---|---|
| `claude: command not found` | Install Claude Code CLI or set `CLAUDE_CLI_PATH=/full/path/to/claude` |
| Bot doesn't respond | Check `pm2 logs` — likely your user ID isn't in `TELEGRAM_ALLOWED_USER_IDS` |
| "claude exited with code 1" | Run the prompt manually: `echo "test" \| claude --print` — usually an auth/subscription issue |
| Sessions reset every restart | Ensure `data/sessions.json` is writable, not gitignored on first run |
| Telegram message edits flooding | Increase `STREAM_EDIT_INTERVAL_MS` constant in `src/channels/telegram-channel.ts` |
