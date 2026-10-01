import log from 'electron-log';
import { getDatabase } from '../../../db';
import { captureMainException } from '../../../sentry/init';

/** Fire-and-forget persist of the first session id a stream announces — a turn that dies
 * mid-stream never reaches the finish-path persist, and Carry on then has no session to resume. */
export function persistEarlySessionId(subChatId: string, sessionId: string): void {
  void import('../../../db/repos/sub-chats')
    .then(({ updateSubChatSession }) => updateSubChatSession(getDatabase(), subChatId, sessionId))
    .catch((err) => {
      log.warn(`[Socket Executor] early session-id persist failed for ${subChatId}:`, err);
      captureMainException(err, { surface: 'early-session-id-persist' });
    });
}
