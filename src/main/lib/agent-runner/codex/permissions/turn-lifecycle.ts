import type { UIMessageChunk } from '../../../claude/types';
import type { CodexAppServerClient } from '../app-server-client';
import { disposeCodexAppServerSession } from '../app-server-registry';
import type { ChunkQueue } from '../chunk-queue';
import { codexHostPermissionDeduper } from '../codex-host-permissions';
import { clearCodexLiveTurn } from '../codex-live-turn';

export type CodexTurnIdentity = {
  threadId?: string;
  turnId?: string;
};

type AbortContext = {
  cwd: string;
  credentialId: string;
  sessionKey?: string;
};

export function clearCodexTurnState(
  sessionKey: string | undefined,
  identity: CodexTurnIdentity,
): void {
  clearCodexLiveTurn(sessionKey, identity.turnId);
  if (identity.threadId && identity.turnId) {
    codexHostPermissionDeduper.clearTurn(identity.threadId, identity.turnId);
  }
}

export function createCodexAbortHandler(
  context: AbortContext,
  client: CodexAppServerClient,
  queue: ChunkQueue,
  identity: CodexTurnIdentity,
): () => void {
  return () => {
    clearCodexTurnState(context.sessionKey, identity);
    if (identity.threadId && identity.turnId) {
      client
        .sendRequest('turn/interrupt', {
          threadId: identity.threadId,
          turnId: identity.turnId,
        })
        .catch(() => {});
    }
    queue.finish();
    if (context.sessionKey) {
      disposeCodexAppServerSession(context.cwd, context.credentialId, context.sessionKey);
    }
  };
}

export async function* drainCodexTurnChunks(
  queue: ChunkQueue,
  signal: AbortSignal,
): AsyncGenerator<UIMessageChunk, void, undefined> {
  for await (const chunk of queue.drain()) {
    if (signal.aborted) return;
    yield chunk;
  }
}
