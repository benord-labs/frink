import type { ThinkingEmitter } from '../../claude/thinking-emitter';
import type { UIMessageChunk } from '../../claude/types';
import type { ChunkQueue } from './chunk-queue';

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

export function makeChunkSink(
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

export function* completeTurnChunks(
  thinking: ThinkingEmitter,
  openTextIds: Set<string>,
): Generator<UIMessageChunk, void, undefined> {
  yield* thinking.complete();
  for (const id of [...openTextIds]) yield* closeText(id, openTextIds);
}
