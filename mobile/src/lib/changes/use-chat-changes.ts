import { useEffect, useState } from 'react';
import { useConnection } from '../connection';
import { askChanges, nextAnswer, ownAnswer, type ChangesAnswer } from './ask';

/**
 * Asks once for a chat's changes whenever `enabled` turns on or `revision` moves; it never polls.
 * An answer is shown only for the computer and chat it was asked about.
 */
export function useChatChanges(
  chatId: string | undefined,
  { summaryOnly = false, enabled = true, revision = 0 } = {},
) {
  const { connection, request } = useConnection();
  const [answer, setAnswer] = useState<ChangesAnswer>();
  const key = `${connection?.deviceId}\n${chatId}\n${summaryOnly}`;
  useEffect(() => {
    if (!enabled || !connection || !chatId) return;
    return askChanges(
      (signal) => request({ type: 'chatChanges', chatId, summaryOnly }, signal, connection),
      (next) => setAnswer((old) => nextAnswer(old, key, next)),
    );
  }, [key, enabled, revision]);
  return ownAnswer(answer, key);
}
