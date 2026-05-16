import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { logger } from '../utils/logger.js';
import type { SessionKey } from './types.js';
import type { SessionMode } from '../config.js';

type PersistShape = Record<string, string>;

const DEFAULT_PATH = resolve(process.cwd(), 'data', 'sessions.json');

/**
 * Maps logical session keys (channel + identity) → claude session UUID.
 * Persists across restarts so conversations survive process bounce.
 */
export class SessionManager {
  private map = new Map<string, string>();
  private dirty = false;
  private writeTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly mode: SessionMode,
    private readonly path: string = DEFAULT_PATH,
  ) {
    this.load();
  }

  /** Resolve a session key string considering shared vs per-user mode. */
  private keyOf(k: SessionKey): string {
    if (this.mode === 'shared') return `${k.channel}:shared`;
    return `${k.channel}:${k.identity}`;
  }

  /** Returns existing session ID for this key, or null if fresh. */
  get(k: SessionKey): string | null {
    return this.map.get(this.keyOf(k)) ?? null;
  }

  /** Store the session ID Claude returned in its init event. */
  set(k: SessionKey, sessionId: string): void {
    const key = this.keyOf(k);
    if (this.map.get(key) === sessionId) return;
    this.map.set(key, sessionId);
    this.dirty = true;
    this.scheduleSave();
  }

  /** Wipe a session (e.g. user /new). */
  reset(k: SessionKey): void {
    const key = this.keyOf(k);
    if (this.map.delete(key)) {
      this.dirty = true;
      this.scheduleSave();
    }
  }

  /** Snapshot for diagnostics. */
  all(): Record<string, string> {
    return Object.fromEntries(this.map);
  }

  private load(): void {
    try {
      if (!existsSync(this.path)) return;
      const raw = readFileSync(this.path, 'utf8');
      const parsed = JSON.parse(raw) as PersistShape;
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === 'string') this.map.set(k, v);
      }
      logger.info({ count: this.map.size, path: this.path }, 'loaded sessions');
    } catch (err) {
      logger.warn({ err }, 'failed to load sessions, starting fresh');
    }
  }

  private scheduleSave(): void {
    if (this.writeTimer) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      if (!this.dirty) return;
      this.saveSync();
    }, 500);
  }

  saveSync(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const obj: PersistShape = Object.fromEntries(this.map);
      writeFileSync(this.path, JSON.stringify(obj, null, 2), 'utf8');
      this.dirty = false;
    } catch (err) {
      logger.error({ err }, 'failed to persist sessions');
    }
  }
}
