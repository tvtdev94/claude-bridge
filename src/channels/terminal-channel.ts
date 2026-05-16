import { createInterface, Interface as ReadlineInterface } from 'node:readline';
import { stdin as input, stdout as output } from 'node:process';
import { logger } from '../utils/logger.js';
import type { AgentOrchestrator } from '../core/agent-orchestrator.js';
import type { SessionKey } from '../core/types.js';

const HELP = `
Commands:
  /new       Start a fresh conversation (drop session)
  /status    Show current session info
  /help      This menu
  /exit      Stop the daemon
Anything else is sent to Claude.
`.trim();

export class TerminalChannel {
  private rl: ReadlineInterface | null = null;
  private sessionKey: SessionKey = { channel: 'terminal', identity: 'local' };
  private busy = false;

  constructor(private readonly agent: AgentOrchestrator) {}

  start(): void {
    this.rl = createInterface({ input, output, prompt: '› ' });
    output.write(`\nautorunclaude terminal channel ready. Type /help for commands.\n`);
    this.rl.prompt();

    this.rl.on('line', (line) => {
      const text = line.trim();
      if (!text) {
        this.rl?.prompt();
        return;
      }
      void this.handleLine(text);
    });

    this.rl.on('close', () => {
      output.write('\nterminal closed\n');
    });
  }

  stop(): void {
    this.rl?.close();
    this.rl = null;
  }

  private async handleLine(line: string): Promise<void> {
    if (this.busy) {
      output.write('… still working on previous prompt, please wait\n');
      this.rl?.prompt();
      return;
    }

    if (line === '/exit') {
      output.write('shutting down…\n');
      process.exit(0);
    }
    if (line === '/help') {
      output.write(HELP + '\n');
      this.rl?.prompt();
      return;
    }
    if (line === '/new') {
      this.agent.resetSession(this.sessionKey);
      output.write('✓ session reset\n');
      this.rl?.prompt();
      return;
    }
    if (line === '/status') {
      output.write(`session key: ${this.sessionKey.channel}:${this.sessionKey.identity}\n`);
      this.rl?.prompt();
      return;
    }

    this.busy = true;
    try {
      output.write('\n');
      const res = await this.agent.ask({
        sessionKey: this.sessionKey,
        prompt: line,
        onText: (chunk) => output.write(chunk),
      });
      if (!res.text) output.write('(no text returned)');
      output.write('\n');
      if (res.error) output.write(`\n⚠ ${res.error}\n`);
      if (res.costUsd !== undefined || res.durationMs !== undefined) {
        const parts: string[] = [];
        if (res.durationMs !== undefined) parts.push(`${(res.durationMs / 1000).toFixed(1)}s`);
        if (res.costUsd !== undefined) parts.push(`$${res.costUsd.toFixed(4)}`);
        output.write(`\n[${parts.join(' · ')}]\n`);
      }
    } catch (err) {
      logger.error({ err }, 'terminal handler crashed');
      output.write(`\n⚠ error: ${(err as Error).message}\n`);
    } finally {
      this.busy = false;
      this.rl?.prompt();
    }
  }
}
