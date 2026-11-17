import type { ThinkingEmitter } from '../../claude/thinking-emitter';
import type { UIMessageChunk } from '../../claude/types';
import type { CodexAppServerClient } from './app-server-client';
import type { ChunkQueue } from './chunk-queue';

/** Ends the open text run, so text after a thought or a card starts a new block below it. */
export function endTextRun(state: { openTextId: string | null }): UIMessageChunk[] {
  if (state.openTextId === null) return [];
  const id = state.openTextId;
  state.openTextId = null;
  return [{ type: 'text-end', id }];
}

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

/** Ends the turn on a client close or transport error. Kept on the CLIENT, not the thread
 * subscription: every concurrent turn on a shared client sees the same crash. */
export function registerCloseHandlers(
  client: CodexAppServerClient,
  queue: ChunkQueue,
): Array<{ dispose: () => void }> {
  return [
    // A crash sends no turn/completed, so end the turn here or the generator holds its runtime slot.
    client.onClose(() => {
      queue.push({ type: 'error', errorText: 'Codex app-server connection closed unexpectedly.' });
      queue.finish();
    }),
    // A transport write/handler error may NOT close the connection (broken stdin pipe) — end anyway.
    client.onError((err) => {
      const detail = Array.isArray(err) && err[0] instanceof Error ? `: ${err[0].message}` : '';
      queue.push({ type: 'error', errorText: `Codex app-server transport error${detail}.` });
      queue.finish();
    }),
  ];
}
