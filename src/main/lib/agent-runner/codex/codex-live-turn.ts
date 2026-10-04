import log from 'electron-log';
import { ResponseError } from 'vscode-jsonrpc/node';
import type { UIMessageChunk } from '../../claude/types';
import { registerCodexLiveTurnCountReader } from '../../diagnostics/provider-topology';
import type { CodexAppServerClient } from './app-server-client';
import { randomUUID } from 'node:crypto';
import { codexMessageContext } from '../../../../shared/lib/message-markers/message-provenance';
import type { CodexCommandOutputs } from './command-output';

/**
 * The live Codex turn for one sub-chat, published so a STEER can reach it.
 *
 * `runCodexAgent` holds `threadId`/`turnId` in generator-local scope — reachable from its own abort
 * listener (which is how `turn/interrupt` works) but from nowhere else. Steering arrives from
 * outside that generator, on a tRPC call, so the ids have to be published somewhere addressable by
 * sub-chat. This registry is that seam and nothing more: the runner owns the lifetime, registering
 * once the turn is open and clearing it in the same `finally` that disposes the subscription.
 */
export type CodexLiveTurn = {
  client: CodexAppServerClient;
  hasFlowProvenance?: boolean;
  threadId: string;
  turnId: string;
  /** The turn's own chunk sink, so a delivered steer can leave a marker in the assistant message it
   * joined. Codex turns have no ClaudeTurnContext, so they cannot share the Claude emitter. */
  pushChunk: (chunk: UIMessageChunk) => void;
  /**
   * Whether this turn is parked on a host approval prompt, where it reaches no next sampling loop
   * and a steer would buffer invisibly. Codex approvals are answered inside the runner's own
   * handler and never reach Claude's `pendingToolApprovals`, so the Claude-side guard is blind here.
   *
   * A predicate over the RUNNER's own per-turn counter rather than a registry beside this one:
   * the count then shares this entry's identity and lifetime exactly, so a turn cannot read, clear,
   * or strand a sibling turn's approvals — and a successor on the same sub-chat starts clean.
   */
  hasOpenApproval: () => boolean;
  /** Its running commands' output so far, read while the user watches one run. */
  commandOutputs: CodexCommandOutputs;
};

const liveTurns = new Map<string, CodexLiveTurn>();
registerCodexLiveTurnCountReader(() => liveTurns.size);

/** `turn/steer` support is a property of the BINARY, not the chat — an older codex answers
 * method-not-found. Probed once per client and cached, so a steer against an old binary costs one
 * failed round trip for the whole session rather than one per attempt. */
const steerSupport = new WeakMap<CodexAppServerClient, boolean>();

/** No-ops without an addressable sub-chat or turn id: that turn simply stays unsteerable, and the
 * guard lives here so the turn generator stays branch-free. */
export function setCodexLiveTurn(
  subChatId: string | undefined,
  turn: Omit<CodexLiveTurn, 'turnId'> & { turnId: string | undefined },
): void {
  if (!subChatId || !turn.turnId) return;
  liveTurns.set(subChatId, { ...turn, turnId: turn.turnId });
}

/**
 * Identity-guarded clear: only drops the entry when it still describes THIS turn. A turn ending
 * after the next one on the same sub-chat already registered would otherwise delete its successor's
 * entry and silently make that turn unsteerable.
 */
export function clearCodexLiveTurn(
  subChatId: string | undefined,
  turnId: string | undefined,
): void {
  if (!subChatId || !turnId) return;
  if (liveTurns.get(subChatId)?.turnId === turnId) liveTurns.delete(subChatId);
}

export function getCodexLiveTurn(subChatId: string): CodexLiveTurn | undefined {
  return liveTurns.get(subChatId);
}

/** A codex too old to know the method — distinct from a live turn REFUSING the steer. */
function isMethodNotFound(err: unknown): boolean {
  return err instanceof ResponseError && err.code === -32601;
}

export type CodexSteerOutcome = 'delivered' | 'not-steerable' | 'unsupported';

/**
 * Splice `text` into this sub-chat's running Codex turn via `turn/steer`, which (unlike
 * `turn/interrupt`) never touches the turn's cancellation token — the buffered input is drained at
 * the top of the next sampling loop.
 *
 * `expectedTurnId` is a required precondition on the wire: codex rejects the call when the active
 * turn is not the one we think it is, which is what keeps a steer from landing on a turn the user
 * never saw. Review and compaction turns reject steering outright; both refusals surface here as
 * `not-steerable` so the caller queues the message instead.
 */
export async function steerCodexTurn(subChatId: string, text: string): Promise<CodexSteerOutcome> {
  const live = liveTurns.get(subChatId);
  if (!live) return 'not-steerable';
  // `turn/steer` validates only `expectedTurnId`, so a turn parked on an approval prompt would
  // ACCEPT and buffer a steer that nothing can read until a human answers. Refuse, so the caller
  // queues it instead of it sitting invisible.
  if (live.hasOpenApproval()) return 'not-steerable';
  if (steerSupport.get(live.client) === false) return 'unsupported';

  try {
    await live.client.sendRequest('turn/steer', {
      threadId: live.threadId,
      expectedTurnId: live.turnId,
      input: [{ type: 'text', text }],
      ...(live.hasFlowProvenance && {
        additionalContext: codexMessageContext({
          v: 1,
          delivery_id: randomUUID(),
          source: 'person',
          kind: 'steer',
        }),
      }),
    });
    steerSupport.set(live.client, true);
    return 'delivered';
  } catch (err) {
    if (isMethodNotFound(err)) {
      steerSupport.set(live.client, false);
      log.info(`[Codex] turn/steer unsupported by this binary — steering disabled for the session`);
      return 'unsupported';
    }
    // Everything else is a live turn declining THIS steer: a turn-id mismatch (the turn moved on),
    // no active turn (it just ended), or a non-steerable kind (review / compaction).
    log.info(`[Codex] turn/steer declined for ${subChatId}: ${String(err)}`);
    return 'not-steerable';
  }
}

/**
 * Leave the steer's trace in the transcript of the turn it joined, and only that turn. Best-effort:
 * a lost marker is cosmetic — the message itself is with the agent either way — but a marker on the
 * WRONG turn misreports what that turn was told.
 */
export function emitCodexSteerMarker(
  subChatId: string,
  /** The turn that ACCEPTED the steer, pinned by the caller before its `turn/steer` round trip. */
  turnId: string,
  chunk: UIMessageChunk,
): void {
  const live = liveTurns.get(subChatId);
  // Identity-guarded for the same reason the Claude path re-checks `currentTurn`: the steer RPC is a
  // round trip, so the accepting turn can finish and a successor register under this sub-chat before
  // we get here. Pushing then would credit "You steered" to a turn the user never steered.
  if (live?.turnId !== turnId) return;
  live.pushChunk(chunk);
}

/** Test-only: drop all entries so test order doesn't matter. */
export function __resetCodexLiveTurnsForTest(): void {
  liveTurns.clear();
}
