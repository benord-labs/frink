/**
 * Shared thinking block emitter for CLI agent runners.
 *
 * Both the Claude Code CLI and Codex stream thinking/reasoning blocks
 * as incremental deltas. This helper accumulates them and emits the
 * correct UIMessageChunk sequence so the UI renders a collapsible
 * "Thought" card.
 *
 * Chunk sequence:
 *   1. tool-input-start → UI shows "Thinking…" immediately
 *   2. tool-input-available* → progressive text via `input: { text }` with
 *      `providerExecuted: true` (AI SDK treats tool-input-delta as partial
 *      JSON; plain thinking prose must not use tool-input-delta)
 *   3. tool-input-available → final text (again) + tool-output-available → done
 */

import type { UIMessageChunk } from './types';

export type ThinkingEmitter = {
  /** Whether a thinking block is currently in progress. */
  isActive(): boolean;
  /** Feed an incremental thinking text delta. Returns chunks to yield. */
  delta(text: string): UIMessageChunk[];
  /** Mark thinking as complete. Returns chunks to yield. */
  complete(): UIMessageChunk[];
  /** Get the current thinking ID (for dedup tracking). */
  currentId(): string | null;
  /** Reset state (e.g. on new message). */
  reset(): void;
};

function thinkingInputAvailableChunk(thinkingId: string, text: string): UIMessageChunk {
  return {
    type: 'tool-input-available',
    toolCallId: thinkingId,
    toolName: 'Thinking',
    input: { text },
    providerExecuted: true,
  };
}

export function createThinkingEmitter(): ThinkingEmitter {
  let thinkingId: string | null = null;
  let accumulated = '';

  return {
    isActive() {
      return thinkingId !== null;
    },

    delta(text: string): UIMessageChunk[] {
      const chunks: UIMessageChunk[] = [];

      if (!thinkingId) {
        thinkingId = `thinking-${Date.now()}`;
        accumulated = '';
        chunks.push({
          type: 'tool-input-start',
          toolCallId: thinkingId,
          toolName: 'Thinking',
        });
      }

      accumulated += text;
      chunks.push(thinkingInputAvailableChunk(thinkingId, accumulated));

      return chunks;
    },

    complete(): UIMessageChunk[] {
      if (!thinkingId) return [];

      const id = thinkingId;
      const chunks: UIMessageChunk[] = [
        thinkingInputAvailableChunk(id, accumulated),
        {
          type: 'tool-output-available',
          toolCallId: id,
          output: { completed: true },
        },
      ];

      thinkingId = null;
      accumulated = '';

      return chunks;
    },

    currentId() {
      return thinkingId;
    },

    reset() {
      thinkingId = null;
      accumulated = '';
    },
  };
}
