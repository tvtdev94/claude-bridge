export type ChannelKind = 'terminal' | 'telegram';

export type SessionKey = {
  channel: ChannelKind;
  /** Telegram user/chat ID, terminal username, or 'shared' */
  identity: string;
};

export type RunRequest = {
  sessionKey: SessionKey;
  prompt: string;
  /** Override permission mode for this run, e.g. proactive triggers */
  permissionMode?: string;
};

export type RunEvent =
  | { type: 'start'; sessionId: string }
  | { type: 'text'; chunk: string }
  | { type: 'tool_use'; toolName: string; input: unknown }
  | { type: 'tool_result'; toolName: string; ok: boolean }
  | { type: 'final'; text: string; sessionId: string; costUsd?: number; durationMs?: number }
  | { type: 'error'; message: string };

export type RunHandle = {
  events: AsyncIterable<RunEvent>;
  cancel: () => void;
};
