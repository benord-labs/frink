import type { TaskSignalState } from '../../../shared/types/task-signal';

// AI SDK UIMessageChunk format
export type UIMessageChunk =
  // Message lifecycle
  | { type: 'start'; messageId?: string }
  | { type: 'finish'; messageMetadata?: MessageMetadata }
  | { type: 'start-step' }
  | { type: 'finish-step' }
  // Text streaming
  | { type: 'text-start'; id: string }
  | { type: 'text-delta'; id: string; delta: string }
  | { type: 'text-end'; id: string }
  // Reasoning (Extended Thinking)
  | { type: 'reasoning'; id: string; text: string }
  | { type: 'reasoning-delta'; id: string; delta: string }
  // Tool calls
  | {
      type: 'tool-input-start';
      toolCallId: string;
      toolName: string;
      /** When true, AI SDK skips onToolCall for synthetic/provider-driven tools. */
      providerExecuted?: boolean;
    }
  | { type: 'tool-input-delta'; toolCallId: string; inputTextDelta: string }
  | {
      type: 'tool-input-available';
      toolCallId: string;
      toolName: string;
      input: unknown;
      /** When true, AI SDK skips onToolCall (used for streaming Thinking updates). */
      providerExecuted?: boolean;
    }
  | { type: 'tool-output-available'; toolCallId: string; output: unknown }
  | {
      type: 'tool-output-error';
      toolCallId: string;
      errorText: string;
      /** Set when the tool was denied by Frink permission policy (not generic errors). */
      permissionDenied?: boolean;
    }
  // Error & metadata
  | { type: 'error'; errorText: string }
  | { type: 'auth-error'; errorText: string }
  | {
      type: 'ask-user-question';
      toolUseId: string;
      questions: Array<{
        question: string;
        header: string;
        options: Array<{ label: string; description: string }>;
        multiSelect: boolean;
      }>;
    }
  | { type: 'ask-user-question-timeout'; toolUseId: string }
  | {
      type: 'ask-user-question-result';
      toolUseId: string;
      result: string | { answers: unknown };
    }
  | {
      type: 'task-signal';
      state: TaskSignalState;
      summary: string;
      details?: string;
      verification?: Record<string, unknown>;
      toolUseId: string;
    }
  | { type: 'message-metadata'; messageMetadata: MessageMetadata }
  /**
   * Compaction lifecycle. A `data-` chunk rather than a bespoke type because the AI SDK only
   * materialises a message part for `data-`-prefixed chunks — anything else falls off its stream
   * switch and is dropped without a part, so no card can render.
   *
   * The opening chunk is `transient`: it drives the live affordances but deliberately leaves no
   * part behind, so a run killed mid-compaction cannot strand a card that reads "Compacting…"
   * forever. Only a settled compaction is worth a permanent line in the transcript.
   *
   * The lifecycle lives inside `data` rather than beside it because the SDK upserts a data part by
   * replacing `data` alone, leaving any sibling top-level field frozen at its first value.
   */
  | {
      type: 'data-compact';
      id: string;
      transient?: boolean;
      data: {
        state: 'input-streaming' | 'output-available' | 'output-error';
        /** Only known once the boundary lands; distinguishes a user's `/compact` from an automatic one. */
        trigger?: 'manual' | 'auto';
      };
    }
  // Session initialization (MCP servers, plugins, tools)
  | {
      type: 'session-init';
      tools: string[];
      mcpServers: MCPServer[];
      plugins: { name: string; path: string }[];
      skills: string[];
    };

export type MCPServerStatus = 'connected' | 'failed' | 'pending' | 'needs-auth';

type MCPServerIcon = {
  src: string;
  mimeType?: string;
  sizes?: string[];
  theme?: 'light' | 'dark';
};

export type MCPServer = {
  name: string;
  status: MCPServerStatus;
  serverInfo?: {
    name: string;
    version: string;
    icons?: MCPServerIcon[];
  };
  error?: string;
};

type ModelUsageEntry = {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUSD: number;
};

export type MessageMetadata = {
  sessionId?: string;
  sdkMessageUuid?: string; // SDK's message UUID for resumeSessionAt (rollback support)
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  totalCostUsd?: number;
  durationMs?: number;
  resultSubtype?: string;
  finalTextId?: string;
  /** Tokens in the context window after this turn, and the window's size (composer ring). */
  contextTokens?: number;
  contextWindow?: number;
  /** When the turn's prompt cache goes cold at the latest (epoch ms); unset when no TTL was seen. */
  promptCacheExpiresAt?: number;
  modelUsage?: Record<string, ModelUsageEntry>;
};
