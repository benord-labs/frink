import { createThinkingEmitter, type ThinkingEmitter } from '../../claude/thinking-emitter';
import type { UIMessageChunk } from '../../claude/types';
import { ChunkQueue } from '../codex/chunk-queue';

function closeText(id: string, openTextIds: Set<string>): UIMessageChunk[] {
  return openTextIds.delete(id) ? [{ type: 'text-end', id }] : [];
}

function bracketText(chunk: UIMessageChunk, openTextIds: Set<string>): UIMessageChunk[] {
  if (chunk.type === 'text-delta' && !openTextIds.has(chunk.id)) {
    openTextIds.add(chunk.id);
    return [{ type: 'text-start', id: chunk.id }, chunk];
  }
  if (chunk.type === 'text-end') return closeText(chunk.id, openTextIds);
  return [chunk];
}

function makeChunkSink(
  queue: ChunkQueue,
  openTextIds: Set<string>,
  thinking: ThinkingEmitter,
): (chunk: UIMessageChunk) => void {
  return (chunk) => {
    if (chunk.type === 'reasoning-delta') {
      for (const output of thinking.delta(chunk.delta)) queue.push(output);
      return;
    }
    if (chunk.type !== 'message-metadata' && thinking.isActive()) {
      for (const output of thinking.complete()) queue.push(output);
    }
    for (const output of bracketText(chunk, openTextIds)) queue.push(output);
  };
}

function* completeTurnChunks(
  thinking: ThinkingEmitter,
  openTextIds: Set<string>,
): Generator<UIMessageChunk, void, undefined> {
  yield* thinking.complete();
  for (const id of [...openTextIds]) yield* closeText(id, openTextIds);
}

/** One non-Claude turn's chunks: `emit` takes translator output, `queue` holds it in stream order. */
export type TurnStream = {
  readonly queue: ChunkQueue;
  readonly emit: (chunk: UIMessageChunk) => void;
  /** Closes the thought and text runs still open. */
  readonly close: () => Generator<UIMessageChunk, void, undefined>;
};

/** The session id a runner learns mid-turn, for the frame's `finish`. */
export type TurnSession = { id?: string };

export function createTurnStream(): TurnStream {
  const queue = new ChunkQueue();
  const openTextIds = new Set<string>();
  const thinking = createThinkingEmitter();
  return {
    queue,
    emit: makeChunkSink(queue, openTextIds, thinking),
    close: () => completeTurnChunks(thinking, openTextIds),
  };
}

/** Frames a non-Claude turn: start, its chunks, open runs closed, finish. Cleanup belongs in the
 * finally of `chunks` and must never yield; a wrapper that `yield*`s this frame must hold none. */
export async function* frameTurn(
  stream: TurnStream,
  chunks: AsyncIterable<UIMessageChunk>,
  sessionId: () => string | undefined,
  // Frees what the runner took before `chunks` began, for a reader that stops at start.
  releaseUnstarted?: () => void,
): AsyncGenerator<UIMessageChunk, void, undefined> {
  let entered = false;
  try {
    yield { type: 'start' };
    entered = true;
    yield* chunks;
  } finally {
    if (!entered) releaseUnstarted?.();
    yield* stream.close();
    const id = sessionId();
    yield { type: 'finish', messageMetadata: id ? { sessionId: id } : undefined };
  }
}
