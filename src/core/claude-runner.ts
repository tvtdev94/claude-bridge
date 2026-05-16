import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { logger } from '../utils/logger.js';
import type { AppConfig } from '../config.js';
import type { RunEvent, RunHandle } from './types.js';

export type RunOptions = {
  prompt: string;
  /** If present, resumes this session ID. Otherwise starts a fresh session. */
  resumeSessionId?: string | null;
  /** Per-request override of permission mode */
  permissionMode?: string;
  /** Extra system-prompt text appended to Claude's default (e.g. channel-specific tool conventions) */
  appendSystemPrompt?: string;
};

/**
 * Spawns `claude --print --output-format stream-json` and emits typed events.
 * Uses subscription auth (whatever `claude` CLI is logged in as).
 */
export class ClaudeRunner {
  constructor(private readonly cfg: AppConfig['claude']) {}

  run(opts: RunOptions): RunHandle {
    const args: string[] = [
      '--print',
      '--output-format',
      'stream-json',
      '--include-partial-messages',
      '--verbose',
      '--permission-mode',
      opts.permissionMode || this.cfg.permissionMode,
    ];

    if (opts.resumeSessionId) {
      args.push('--resume', opts.resumeSessionId);
    }
    if (this.cfg.model) {
      args.push('--model', this.cfg.model);
    }
    if (this.cfg.effort) {
      args.push('--effort', this.cfg.effort);
    }
    if (opts.appendSystemPrompt) {
      args.push('--append-system-prompt', opts.appendSystemPrompt);
    }

    logger.debug({ args, cwd: this.cfg.workDir }, 'spawning claude');

    const child = spawn(this.cfg.cliPath, args, {
      cwd: this.cfg.workDir,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams;

    // Pipe prompt via stdin (text input format = default)
    child.stdin.write(opts.prompt);
    child.stdin.end();

    let killed = false;
    const timeout = setTimeout(() => {
      killed = true;
      logger.warn({ pid: child.pid }, 'claude subprocess timeout, killing');
      child.kill('SIGKILL');
    }, this.cfg.timeoutMs);

    const stderrChunks: string[] = [];
    child.stderr.on('data', (d) => stderrChunks.push(d.toString()));

    const events = this.toEventStream(child, () => stderrChunks.join(''));

    return {
      events,
      cancel: () => {
        killed = true;
        clearTimeout(timeout);
        if (!child.killed) child.kill('SIGTERM');
      },
    };
  }

  /**
   * Reads stdout line-by-line, parses JSON events, normalizes to RunEvent stream.
   */
  private async *toEventStream(
    child: ChildProcessWithoutNullStreams,
    getStderr: () => string,
  ): AsyncGenerator<RunEvent> {
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });

    const queue: RunEvent[] = [];
    let resolveNext: (() => void) | null = null;
    let done = false;

    const push = (ev: RunEvent) => {
      queue.push(ev);
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r();
      }
    };

    lines.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const obj = JSON.parse(trimmed);
        for (const ev of this.normalizeEvent(obj)) push(ev);
      } catch (err) {
        logger.warn({ line: trimmed.slice(0, 200) }, 'unparseable claude stdout line');
      }
    });

    const finalize = (code: number | null) => {
      if (code !== 0 && code !== null) {
        const stderr = getStderr();
        push({
          type: 'error',
          message: `claude exited with code ${code}${stderr ? `: ${stderr.slice(0, 500)}` : ''}`,
        });
      }
      done = true;
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r();
      }
    };

    child.on('close', finalize);
    child.on('error', (err) => {
      push({ type: 'error', message: `spawn failed: ${err.message}` });
      done = true;
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r();
      }
    });

    while (true) {
      if (queue.length > 0) {
        yield queue.shift()!;
        continue;
      }
      if (done) return;
      await new Promise<void>((resolve) => (resolveNext = resolve));
    }
  }

  /**
   * Converts raw Claude CLI stream-json events into our RunEvent shape.
   * Stream-json schema (Claude Code 2.x):
   *  - { type: "system", subtype: "init", session_id }
   *  - { type: "assistant", message: { content: [...] } }
   *  - { type: "user", message: { content: [...] } }  (tool results)
   *  - { type: "stream_event", event: { type: "content_block_delta", delta: {...} } }
   *  - { type: "result", subtype, result, session_id, duration_ms, total_cost_usd }
   */
  private *normalizeEvent(obj: any): Iterable<RunEvent> {
    if (!obj || typeof obj !== 'object') return;

    if (obj.type === 'system' && obj.subtype === 'init') {
      yield { type: 'start', sessionId: String(obj.session_id) };
      return;
    }

    if (obj.type === 'stream_event' && obj.event) {
      const ev = obj.event;
      if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
        yield { type: 'text', chunk: String(ev.delta.text) };
      }
      return;
    }

    if (obj.type === 'assistant' && obj.message?.content) {
      for (const block of obj.message.content) {
        if (block.type === 'tool_use') {
          yield { type: 'tool_use', toolName: String(block.name || 'unknown'), input: block.input };
        }
      }
      return;
    }

    if (obj.type === 'user' && obj.message?.content) {
      for (const block of obj.message.content) {
        if (block.type === 'tool_result') {
          yield {
            type: 'tool_result',
            toolName: 'tool',
            ok: !block.is_error,
          };
        }
      }
      return;
    }

    if (obj.type === 'result') {
      yield {
        type: 'final',
        text: typeof obj.result === 'string' ? obj.result : '',
        sessionId: String(obj.session_id || ''),
        costUsd: typeof obj.total_cost_usd === 'number' ? obj.total_cost_usd : undefined,
        durationMs: typeof obj.duration_ms === 'number' ? obj.duration_ms : undefined,
      };
      return;
    }
  }
}
