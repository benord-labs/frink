import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ClaudeSession } from '../../claude-session-registry';
import { noteSubagentTaskFrame } from '../../streaming';

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
      if (!session.loop.closeExpected) noteSubagentTaskFrame(session.subChatId, value);
      if (isBoundary(value)) return;
    }
  } catch {
    // query died mid-drain — no further messages to align.
  }
}
