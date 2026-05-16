import cron, { ScheduledTask } from 'node-cron';
import { logger } from '../utils/logger.js';
import type { AgentOrchestrator } from '../core/agent-orchestrator.js';
import type { AppConfig, ProactiveTrigger } from '../config.js';
import type { TelegramChannel } from '../channels/telegram-channel.js';

/**
 * Fires prompts on a cron schedule into the agent and pushes results
 * to the configured notification channel(s).
 */
export class ProactiveTriggerScheduler {
  private tasks: ScheduledTask[] = [];

  constructor(
    private readonly agent: AgentOrchestrator,
    private readonly cfg: AppConfig['scheduler'],
    private readonly telegram: TelegramChannel | null,
    /** Telegram targets (user IDs + chat IDs) that should receive proactive output */
    private readonly telegramTargets: number[],
  ) {}

  start(): void {
    if (this.cfg.triggers.length === 0) {
      logger.info('no proactive triggers configured');
      return;
    }
    for (const trig of this.cfg.triggers) {
      if (!cron.validate(trig.cron)) {
        logger.error({ trig }, 'invalid cron expression, skipping');
        continue;
      }
      const task = cron.schedule(
        trig.cron,
        () => {
          void this.fire(trig);
        },
        { timezone: process.env.TZ || undefined },
      );
      this.tasks.push(task);
      logger.info({ name: trig.name, cron: trig.cron }, 'proactive trigger scheduled');
    }
  }

  stop(): void {
    for (const t of this.tasks) t.stop();
    this.tasks = [];
  }

  private async fire(trig: ProactiveTrigger): Promise<void> {
    logger.info({ name: trig.name }, 'proactive trigger firing');
    try {
      const res = await this.agent.ask({
        sessionKey: { channel: 'terminal', identity: `proactive:${trig.name}` },
        prompt: trig.prompt,
      });
      const target = trig.notify ?? this.cfg.notify;
      const text = res.text || '(trigger produced no text)';
      const header = `🤖 *${trig.name}*\n\n`;
      const payload = header + text;

      if (target === 'terminal' || target === 'both') {
        process.stdout.write(`\n[proactive:${trig.name}]\n${text}\n`);
      }
      if ((target === 'telegram' || target === 'both') && this.telegram) {
        for (const id of this.telegramTargets) {
          await this.telegram.push(id, payload);
        }
      }
      if (res.error) {
        logger.warn({ name: trig.name, error: res.error }, 'trigger had errors');
      }
    } catch (err) {
      logger.error({ err, name: trig.name }, 'proactive trigger crashed');
    }
  }
}
