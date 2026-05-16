import { logger } from '../utils/logger.js';
import { ClaudeRunner } from './claude-runner.js';
import type { SessionManager } from './session-manager.js';
import type { RunEvent, SessionKey } from './types.js';

export type AskOptions = {
  sessionKey: SessionKey;
  prompt: string;
  permissionMode?: string;
  /** Extra system-prompt text appended to Claude's default */
  appendSystemPrompt?: string;
  /** Called as text streams in (low-frequency batched chunks). */
  onText?: (chunk: string) => void;
  /** Called on every event (for debug/UI). */
  onEvent?: (ev: RunEvent) => void;
};

export type AskResult = {
  text: string;
  sessionId: string;
  costUsd?: number;
  durationMs?: number;
  error?: string;
};

/**
 * Single entry point all channels (terminal, telegram, scheduler) call.
 * Handles: session lookup → spawn → event aggregation → session persist.
 */
export class AgentOrchestrator {
  constructor(
    private readonly runner: ClaudeRunner,
    private readonly sessions: SessionManager,
  ) {}

  async ask(opts: AskOptions): Promise<AskResult> {
    const resumeId = this.sessions.get(opts.sessionKey);
    const handle = this.runner.run({
      prompt: opts.prompt,
      resumeSessionId: resumeId,
      permissionMode: opts.permissionMode,
      appendSystemPrompt: opts.appendSystemPrompt,
    });

    let text = '';
    let sessionId = resumeId ?? '';
    let costUsd: number | undefined;
    let durationMs: number | undefined;
    let error: string | undefined;
    let finalText = '';

    for await (const ev of handle.events) {
      opts.onEvent?.(ev);

      switch (ev.type) {
        case 'start':
          sessionId = ev.sessionId;
          this.sessions.set(opts.sessionKey, sessionId);
          break;
        case 'text':
          text += ev.chunk;
          opts.onText?.(ev.chunk);
          break;
        case 'final':
          finalText = ev.text;
          if (ev.sessionId) sessionId = ev.sessionId;
          costUsd = ev.costUsd;
          durationMs = ev.durationMs;
          break;
        case 'error':
          error = ev.message;
          logger.error({ msg: ev.message }, 'claude run error');
          break;
        case 'tool_use':
          logger.debug({ tool: ev.toolName }, 'tool_use');
          break;
      }
    }

    if (sessionId) this.sessions.set(opts.sessionKey, sessionId);

    return {
      text: finalText || text,
      sessionId,
      costUsd,
      durationMs,
      error,
    };
  }

  resetSession(sessionKey: SessionKey): void {
    this.sessions.reset(sessionKey);
  }
}
