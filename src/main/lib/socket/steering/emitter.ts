import type { UIMessageChunk } from '../../claude/types';
import type { ClaudeTurnContext } from '../claude-turn-context';
import { createTurnChunkEmitter } from '../claude-turn-context';
import type { MessagePart } from '../client';
import { sendStreamChunkDirect } from '../client';

/**
 * Write a chunk into the assistant message the turn is ALREADY streaming.
 *
 * Built on demand from `session.currentTurn` rather than armed by the executor: the turn context
 * already carries everything an emitter needs (`msgId`, `nextMessageIndex`, `lastCollectedChunks`),
 * so the executor needs no knowledge of steering at all. Reuses the emitter AskUserQuestion streams
 * through, so a marker lands as an ordinary part of that same message — never a second one, which
 * would make one turn render as two end-of-turn treatments (live-run-observer-lane).
 *
 * Takes the PINNED turn rather than re-reading `session.currentTurn`: the caller captures it before
 * its DB await and drops the marker if the session has since moved on. Losing a marker is a cosmetic
 * gap; attaching one to a turn the user never steered would misreport what the agent was told.
 */
export function emitSteerMarker(
  turn: ClaudeTurnContext,
  chatId: string,
  subChatId: string,
  chunk: UIMessageChunk,
): void {
  const liveParts: MessagePart[] = [];
  createTurnChunkEmitter({
    turn,
    liveParts,
    chatId,
    subChatId,
    sendChunk: sendStreamChunkDirect,
  })(chunk);
}
