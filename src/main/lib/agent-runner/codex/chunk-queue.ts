/**
 * Minimal async queue bridging push-based JSON-RPC events to a pull-based generator.
 * Owned by the codex runner: notifications push chunks in; `runCodexAgent` drains them.
 */

import type { UIMessageChunk } from '../../claude/types';
import { mergeDelta } from './codex-events';

export class ChunkQueue {
  private readonly items: UIMessageChunk[] = [];
  private resolve: (() => void) | null = null;
  private done = false;

  push(chunk: UIMessageChunk): void {
    // Coalesce adjacent same-id deltas at the tail to bound IPC chatter + memory
    // when drain has fallen behind (no-op when it keeps up — items is empty).
    // ponytail: this is the ceiling — true producer backpressure is impossible
    // over fire-and-forget JSON-RPC notifications.
    const tail = this.items[this.items.length - 1];
    const merged = tail ? mergeDelta(tail, chunk) : null;
    if (merged) this.items[this.items.length - 1] = merged;
    else this.items.push(chunk);
    this.resolve?.();
    this.resolve = null;
  }

  finish(): void {
    this.done = true;
    this.resolve?.();
    this.resolve = null;
  }

  async *drain(): AsyncGenerator<UIMessageChunk, void, undefined> {
    while (true) {
      while (this.items.length > 0) {
        const next = this.items.shift();
        if (next) yield next;
      }
      if (this.done) return;
      await new Promise<void>((r) => {
        this.resolve = r;
      });
    }
  }
}
