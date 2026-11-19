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
