import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

/**
 * Single-consumer async-message queue that drives the Claude SDK's
 * streaming-input mode. `query({ prompt: queue.stream })` holds ONE `claude` CLI
 * subprocess — and its MCP connections — open for the whole chat; each user turn
 * is delivered by {@link StreamingInputQueue.push}, and {@link StreamingInputQueue.close}
 * ends the session. This is the mechanism that keeps MCP servers warm across
 * turns instead of re-connecting (and re-losing the CLI's 5s handshake race) on
 * every message. See `docs/frink/todos/mcp-stdio-tools-stuck-pending.md`.
 *
 * Contract: exactly one consumer (the SDK iterates `stream`). Push before close;
 * pushing after close throws so a lifecycle bug surfaces loudly rather than
 * silently dropping a turn.
 */
export interface StreamingInputQueue {
  /** Pass as `query({ prompt })`. Yields each pushed message; ends after close drains. */
  readonly stream: AsyncIterable<SDKUserMessage>;
  /** Enqueue one user turn. Throws if the queue is already closed. */
  push(message: SDKUserMessage): void;
  /** End the session; `stream` completes once buffered messages drain. */
  close(): void;
  readonly closed: boolean;
}

export function createStreamingInputQueue(): StreamingInputQueue {
  const buffer: SDKUserMessage[] = [];
  let wake: (() => void) | null = null;
  let closed = false;

  const wakeConsumer = (): void => {
    const resolve = wake;
    wake = null;
    resolve?.();
  };

  const stream: AsyncIterable<SDKUserMessage> = {
    async *[Symbol.asyncIterator]() {
      while (true) {
        while (buffer.length > 0) yield buffer.shift() as SDKUserMessage;
        if (closed) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
  };

  return {
    stream,
    get closed() {
      return closed;
    },
    push(message: SDKUserMessage): void {
      if (closed) throw new Error('StreamingInputQueue: push after close');
      buffer.push(message);
      wakeConsumer();
    },
    close(): void {
      closed = true;
      wakeConsumer();
    },
  };
}
