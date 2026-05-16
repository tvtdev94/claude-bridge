import 'dotenv/config';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { logger } from './utils/logger.js';

export type ProactiveTrigger = {
  name: string;
  cron: string;
  prompt: string;
  /** Optional override of target channel for this trigger */
  notify?: 'terminal' | 'telegram' | 'both';
};

export type SessionMode = 'shared' | 'per-user';
export type PermissionMode = 'bypassPermissions' | 'acceptEdits' | 'default' | 'plan' | 'dontAsk' | 'auto';

export type AppConfig = {
  telegram: {
    enabled: boolean;
    botToken: string | null;
    allowedUserIds: Set<number>;
    allowedChatIds: Set<number>;
  };
  terminal: {
    enabled: boolean;
  };
  claude: {
    cliPath: string;
    workDir: string;
    permissionMode: PermissionMode;
    model: string | null;
    effort: string | null;
    timeoutMs: number;
  };
  session: {
    mode: SessionMode;
  };
  scheduler: {
    triggers: ProactiveTrigger[];
    notify: 'terminal' | 'telegram' | 'both';
  };
  logLevel: string;
};

function parseIdList(raw: string | undefined): Set<number> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => Number(s))
      .filter((n) => Number.isFinite(n)),
  );
}

function parseBool(raw: string | undefined, defaultValue: boolean): boolean {
  if (raw === undefined || raw === '') return defaultValue;
  return /^(1|true|yes|on)$/i.test(raw);
}

function parseTriggers(raw: string | undefined): ProactiveTrigger[] {
  if (!raw) return [];
  // Allow either a JSON string OR a path to a JSON file
  let jsonText = raw.trim();
  if (!jsonText.startsWith('[') && !jsonText.startsWith('{')) {
    const path = resolve(jsonText);
    if (!existsSync(path)) {
      logger.warn({ path }, 'PROACTIVE_TRIGGERS file not found, ignoring');
      return [];
    }
    jsonText = readFileSync(path, 'utf8');
  }
  try {
    const arr = JSON.parse(jsonText);
    if (!Array.isArray(arr)) throw new Error('Triggers must be a JSON array');
    return arr.map((t: any, i: number) => {
      if (!t.name || !t.cron || !t.prompt) {
        throw new Error(`Trigger #${i} missing name/cron/prompt`);
      }
      return {
        name: String(t.name),
        cron: String(t.cron),
        prompt: String(t.prompt),
        notify: t.notify,
      };
    });
  } catch (err) {
    logger.error({ err }, 'Failed to parse PROACTIVE_TRIGGERS');
    return [];
  }
}

export function loadConfig(): AppConfig {
  const config: AppConfig = {
    telegram: {
      enabled: parseBool(process.env.ENABLE_TELEGRAM_CHANNEL, true),
      botToken: process.env.TELEGRAM_BOT_TOKEN?.trim() || null,
      allowedUserIds: parseIdList(process.env.TELEGRAM_ALLOWED_USER_IDS),
      allowedChatIds: parseIdList(process.env.TELEGRAM_ALLOWED_CHAT_IDS),
    },
    terminal: {
      enabled: parseBool(process.env.ENABLE_TERMINAL_CHANNEL, true),
    },
    claude: {
      cliPath: process.env.CLAUDE_CLI_PATH?.trim() || 'claude',
      workDir: process.env.CLAUDE_WORK_DIR?.trim() || process.cwd(),
      permissionMode: (process.env.CLAUDE_PERMISSION_MODE?.trim() || 'bypassPermissions') as PermissionMode,
      model: process.env.CLAUDE_MODEL?.trim() || null,
      effort: process.env.CLAUDE_EFFORT?.trim() || null,
      timeoutMs: Number(process.env.CLAUDE_TIMEOUT_MINUTES || 30) * 60 * 1000,
    },
    session: {
      mode: (process.env.SESSION_MODE?.trim() || 'per-user') as SessionMode,
    },
    scheduler: {
      triggers: parseTriggers(process.env.PROACTIVE_TRIGGERS),
      notify: (process.env.PROACTIVE_NOTIFY?.trim() || 'telegram') as 'terminal' | 'telegram' | 'both',
    },
    logLevel: process.env.LOG_LEVEL?.trim() || 'info',
  };

  // Sanity checks - warn but don't crash
  if (config.telegram.enabled && !config.telegram.botToken) {
    logger.warn('Telegram enabled but TELEGRAM_BOT_TOKEN missing - Telegram channel will be skipped');
    config.telegram.enabled = false;
  }
  if (
    config.telegram.enabled &&
    config.telegram.allowedUserIds.size === 0 &&
    config.telegram.allowedChatIds.size === 0
  ) {
    logger.warn('Telegram enabled but NO allowed user/chat IDs - bot will reject everyone');
  }
  if (!config.terminal.enabled && !config.telegram.enabled) {
    logger.error('Both channels disabled - nothing to do');
    process.exit(1);
  }

  return config;
}
