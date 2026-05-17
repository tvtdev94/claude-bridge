import { Bot, GrammyError, HttpError, Context, InputFile } from 'grammy';
import { logger } from '../utils/logger.js';
import type { AgentOrchestrator } from '../core/agent-orchestrator.js';
import type { SessionKey } from '../core/types.js';
import type { AppConfig } from '../config.js';
import {
  extractMediaMarkers,
  MEDIA_MARKER_SYSTEM_PROMPT,
  type MediaAttachment,
} from './media-marker-parser.js';

const TELEGRAM_MSG_LIMIT = 4000;
const STREAM_EDIT_INTERVAL_MS = 1500;

const HELP = [
  '*autorunclaude* — Claude Code agent over Telegram',
  '',
  '`/new`     — start a fresh conversation',
  '`/status`  — show your session info',
  '`/help`    — this menu',
  '',
  'Anything else is sent straight to Claude.',
].join('\n');

export class TelegramChannel {
  private bot: Bot;
  private busyChats = new Set<number>();

  constructor(
    private readonly agent: AgentOrchestrator,
    private readonly cfg: AppConfig['telegram'],
    /** Used to resolve relative paths in [[SEND_*]] markers */
    private readonly workDir: string = process.cwd(),
  ) {
    if (!cfg.botToken) throw new Error('TELEGRAM_BOT_TOKEN is required');
    this.bot = new Bot(cfg.botToken);
    this.wire();
  }

  async start(): Promise<void> {
    this.bot.catch((err) => {
      const ctx = err.ctx;
      logger.error({ err: err.error, update: ctx.update.update_id }, 'grammy error');
      if (err.error instanceof GrammyError) {
        logger.error({ desc: err.error.description }, 'telegram API error');
      } else if (err.error instanceof HttpError) {
        logger.error('telegram network error');
      }
    });

    await this.bot.api.setMyCommands([
      { command: 'new', description: 'Start a fresh conversation' },
      { command: 'status', description: 'Show session info' },
      { command: 'help', description: 'Show help' },
    ]);

    void this.bot.start({
      onStart: (info) => logger.info({ username: info.username }, 'telegram bot started'),
      // Discard any backlog accumulated while the bot was offline.
      // Without this, every restart re-processes the same pending updates
      // (Telegram keeps them up to 24h), causing infinite restart loops if
      // a prompt's side-effect kills the bot before grammy confirms the
      // offset via the next getUpdates call.
      drop_pending_updates: true,
    });
  }

  async stop(): Promise<void> {
    await this.bot.stop();
  }

  /**
   * Push a message into a Telegram chat (for proactive triggers).
   * targetId can be a user ID or chat ID.
   */
  async push(targetId: number, text: string): Promise<void> {
    try {
      await this.sendChunked(targetId, text);
    } catch (err) {
      logger.error({ err, targetId }, 'failed to push telegram message');
    }
  }

  /**
   * Broadcast a message to every whitelisted user and chat.
   * Used for daemon lifecycle notifications (online / offline).
   */
  async broadcast(text: string): Promise<void> {
    const targets = new Set<number>([
      ...this.cfg.allowedUserIds,
      ...this.cfg.allowedChatIds,
    ]);
    if (targets.size === 0) return;
    await Promise.allSettled(
      [...targets].map((id) =>
        this.bot.api.sendMessage(id, text).catch((err) => {
          logger.error({ err, id }, 'broadcast send failed');
        }),
      ),
    );
  }

  private wire(): void {
    this.bot.use(async (ctx, next) => {
      if (!this.isAuthorized(ctx)) {
        const userId = ctx.from?.id;
        const chatId = ctx.chat?.id;
        logger.warn({ userId, chatId, name: ctx.from?.username }, 'unauthorized telegram access');
        await ctx.reply('⛔ Not authorized. Ask the operator to whitelist your ID.');
        return;
      }
      await next();
    });

    this.bot.command('start', async (ctx) => {
      await ctx.reply(HELP, { parse_mode: 'Markdown' });
    });
    this.bot.command('help', async (ctx) => {
      await ctx.reply(HELP, { parse_mode: 'Markdown' });
    });
    this.bot.command('new', async (ctx) => {
      const sk = this.sessionKeyOf(ctx);
      if (!sk) return;
      this.agent.resetSession(sk);
      await ctx.reply('✓ Session reset. Next message starts a fresh conversation.');
    });
    this.bot.command('status', async (ctx) => {
      const sk = this.sessionKeyOf(ctx);
      if (!sk) return;
      await ctx.reply(`Session key: \`${sk.channel}:${sk.identity}\``, { parse_mode: 'Markdown' });
    });

    this.bot.on('message:text', async (ctx) => {
      const text = ctx.message.text;
      if (!text || text.startsWith('/')) return;
      await this.handlePrompt(ctx, text);
    });
  }

  private isAuthorized(ctx: Context): boolean {
    const uid = ctx.from?.id;
    const cid = ctx.chat?.id;
    if (uid && this.cfg.allowedUserIds.has(uid)) return true;
    if (cid && this.cfg.allowedChatIds.has(cid)) return true;
    return false;
  }

  private sessionKeyOf(ctx: Context): SessionKey | null {
    const id = ctx.from?.id;
    if (!id) return null;
    return { channel: 'telegram', identity: String(id) };
  }

  private async handlePrompt(ctx: Context, prompt: string): Promise<void> {
    const chatId = ctx.chat!.id;
    if (this.busyChats.has(chatId)) {
      await ctx.reply('⏳ Still working on previous prompt. Please wait or /new to reset.');
      return;
    }
    const sk = this.sessionKeyOf(ctx);
    if (!sk) return;

    this.busyChats.add(chatId);
    await ctx.api.sendChatAction(chatId, 'typing').catch(() => undefined);

    const status = await ctx.reply('🧠 thinking…');
    const statusMsgId = status.message_id;
    let accumulated = '';
    let lastEditAt = 0;
    let lastEditedText = '';

    const maybeEdit = async () => {
      const now = Date.now();
      if (now - lastEditAt < STREAM_EDIT_INTERVAL_MS) return;
      lastEditAt = now;
      const preview = truncateForTelegram(accumulated);
      if (preview === lastEditedText) return;
      lastEditedText = preview;
      try {
        await ctx.api.editMessageText(chatId, statusMsgId, preview);
        await ctx.api.sendChatAction(chatId, 'typing').catch(() => undefined);
      } catch {
        /* edit may fail if user deleted or rate-limited */
      }
    };

    try {
      const res = await this.agent.ask({
        sessionKey: sk,
        prompt,
        appendSystemPrompt: MEDIA_MARKER_SYSTEM_PROMPT,
        onText: (chunk) => {
          accumulated += chunk;
          void maybeEdit();
        },
      });

      const rawFinal = res.text || accumulated || '(no response)';
      const { cleanedText, attachments } = extractMediaMarkers(rawFinal, this.workDir);
      const finalText = cleanedText || (attachments.length > 0 ? '✓ done' : '(no response)');

      // Replace the streaming placeholder with the cleaned final text
      try {
        await ctx.api.editMessageText(chatId, statusMsgId, truncateForTelegram(finalText));
      } catch {
        await ctx.reply(truncateForTelegram(finalText));
      }
      if (finalText.length > TELEGRAM_MSG_LIMIT) {
        const rest = finalText.slice(TELEGRAM_MSG_LIMIT);
        await this.sendChunked(chatId, rest);
      }

      // Send any media attachments Claude marked for upload
      for (const att of attachments) {
        await this.sendAttachment(chatId, att);
      }

      if (res.error) {
        await ctx.reply(`⚠ ${res.error}`);
      }
    } catch (err) {
      logger.error({ err }, 'telegram prompt crashed');
      await ctx.reply(`⚠ error: ${(err as Error).message}`).catch(() => undefined);
    } finally {
      this.busyChats.delete(chatId);
    }
  }

  private async sendChunked(chatId: number, text: string): Promise<void> {
    for (let i = 0; i < text.length; i += TELEGRAM_MSG_LIMIT) {
      await this.bot.api.sendMessage(chatId, text.slice(i, i + TELEGRAM_MSG_LIMIT));
    }
  }

  private async sendAttachment(chatId: number, att: MediaAttachment): Promise<void> {
    const file = new InputFile(att.path);
    const opts = att.caption ? { caption: att.caption } : undefined;
    try {
      switch (att.kind) {
        case 'photo':
          await this.bot.api.sendPhoto(chatId, file, opts);
          break;
        case 'document':
          await this.bot.api.sendDocument(chatId, file, opts);
          break;
        case 'video':
          await this.bot.api.sendVideo(chatId, file, opts);
          break;
        case 'audio':
          await this.bot.api.sendAudio(chatId, file, opts);
          break;
      }
      logger.info({ chatId, kind: att.kind, path: att.path }, 'media sent');
    } catch (err) {
      logger.error({ err, att }, 'failed to send attachment');
      await this.bot.api
        .sendMessage(chatId, `⚠ failed to send ${att.kind} (${att.path}): ${(err as Error).message}`)
        .catch(() => undefined);
    }
  }
}

function truncateForTelegram(s: string): string {
  if (s.length <= TELEGRAM_MSG_LIMIT) return s;
  return s.slice(0, TELEGRAM_MSG_LIMIT - 20) + '\n…(truncated)';
}
