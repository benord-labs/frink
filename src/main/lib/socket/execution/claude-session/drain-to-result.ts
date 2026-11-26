import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ClaudeSession } from '../../claude-session-registry';
import { noteSessionFrame } from './loaded-check';

/** Advance the shared generator to the caller's own boundary (or its end) WITHOUT
 * emitting — used to realign after an `onMessage` error so the next turn doesn't inherit
 * this turn's leftover messages. Best-effort: if the query itself is dead, there is
 * nothing left to align. */
export async function drainToResult(
  session: ClaudeSession,
  isBoundary: (m: SDKMessage) => boolean,
): Promise<void> {
  try {
    while (true) {
      const { value, done } = await session.query.next();
      if (done) return;
      // Error-realignment drains would otherwise swallow a task's terminal notification.
      if (!session.loop.closeExpected) noteSessionFrame(session, value);
      if (isBoundary(value)) return;
    }
  } catch {
    // query died mid-drain — no further messages to align.
  }
}

/**
 * Null when the caller ended the turn on purpose (plan halt, question park), not a dead query.
 * An unexpected throw or result-less done is a dead query: evict so the next turn recreates.
 */
export async function nextTurnMessage(session: ClaudeSession): Promise<SDKMessage | null> {
  let step: IteratorResult<SDKMessage, void>;
  try {
    step = await session.query.next();
  } catch (err) {
    if (session.interruptExpected) return null;
    session.evict();
    throw err;
  }
  if (step.done) {
    if (session.interruptExpected) return null;
    session.evict();
    throw new Error(
      `runTurn: query for ${session.subChatId} ended before the turn produced a result`,
    );
  }
  // Roster writes stop at the wait-over latch: a fresh session for the same chat may own the
  // roster by then, and a drain frame would resurrect its spinner on a finished chat.
  if (!session.loop.closeExpected) noteSessionFrame(session, step.value);
  return step.value;
}
