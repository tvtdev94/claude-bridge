import { loadConfig } from './config.js';
import { logger } from './utils/logger.js';
import { ClaudeRunner } from './core/claude-runner.js';
import { SessionManager } from './core/session-manager.js';
import { AgentOrchestrator } from './core/agent-orchestrator.js';
import { TerminalChannel } from './channels/terminal-channel.js';
import { TelegramChannel } from './channels/telegram-channel.js';
import { ProactiveTriggerScheduler } from './scheduler/proactive-trigger-scheduler.js';

async function main(): Promise<void> {
  const cfg = loadConfig();
  logger.level = cfg.logLevel;
  logger.info(
    {
      terminal: cfg.terminal.enabled,
      telegram: cfg.telegram.enabled,
      sessionMode: cfg.session.mode,
      triggers: cfg.scheduler.triggers.length,
      workDir: cfg.claude.workDir,
    },
    'autorunclaude starting',
  );

  const runner = new ClaudeRunner(cfg.claude);
  const sessions = new SessionManager(cfg.session.mode);
  const agent = new AgentOrchestrator(runner, sessions);

  let terminal: TerminalChannel | null = null;
  let telegram: TelegramChannel | null = null;
  let scheduler: ProactiveTriggerScheduler | null = null;

  if (cfg.terminal.enabled) {
    terminal = new TerminalChannel(agent);
    terminal.start();
  }

  if (cfg.telegram.enabled) {
    telegram = new TelegramChannel(agent, cfg.telegram, cfg.claude.workDir);
    await telegram.start();
  }

  if (cfg.scheduler.triggers.length > 0) {
    const targets: number[] = [
      ...cfg.telegram.allowedUserIds,
      ...cfg.telegram.allowedChatIds,
    ];
    scheduler = new ProactiveTriggerScheduler(agent, cfg.scheduler, telegram, targets);
    scheduler.start();
  }

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down');
    scheduler?.stop();
    terminal?.stop();
    if (telegram) await telegram.stop().catch(() => undefined);
    sessions.saveSync();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'uncaughtException');
  });
  process.on('unhandledRejection', (reason) => {
    logger.error({ reason }, 'unhandledRejection');
  });
}

main().catch((err) => {
  logger.fatal({ err }, 'fatal boot error');
  process.exit(1);
});
