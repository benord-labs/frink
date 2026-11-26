import crypto from 'node:crypto';
import log from 'electron-log';
import type { ClaudeSession } from '../../../claude-session-registry';
import { sendMessage } from '../../../client';
import { getActiveExecution } from '../../../streaming/execution-registry';
import { ChatBusyError } from '../../send-admission';
import type { ClaudeSessionScope } from '../session-callbacks';

/** The longest session name Claude Code shows in its session list without cutting it. */
const MAX_SESSION_NAME = 64;

/** Names a chat's CLI after the chat, so other sessions can find it by title. Set at spawn: a
 * rename lands at the chat's next CLI, and the name is kept out of the warm-session key. */
export function chatSessionNameEnv(chatName?: string | null): {
  CLAUDE_CODE_SESSION_NAME?: string;
} {
  const title = chatName?.replace(/\s+/g, ' ').trim();
  return title ? { CLAUDE_CODE_SESSION_NAME: title.slice(0, MAX_SESSION_NAME) } : {};
}

/** Ask for an execute to adopt the turn a CLI started on its own (a message from another session).
 * It waits for the chat's current run to end: a self-started turn never supersedes one. */
export async function dispatchSelfStartedTurn(
  session: ClaudeSession,
  scope: ClaudeSessionScope,
): Promise<void> {
  const adoption = session.selfStartedAdoption;
  try {
    while (adoption?.pending) {
      if (getActiveExecution(scope.subChatId)) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        continue;
      }
      // The busy check inside admission is atomic with registration: a send that wins the race
      // is refused here instead of being superseded.
      try {
        await sendMessage(selfStartedSend(scope), { rejectIfBusy: true });
        return;
      } catch (err) {
        if (!(err instanceof ChatBusyError)) throw err;
      }
    }
  } catch (err) {
    log.warn(`[Claude Session] self-started turn not dispatched sub=${scope.subChatId}`, err);
    adoption?.fail('self-turn-undeliverable');
  }
}

function selfStartedSend(scope: ClaudeSessionScope) {
  return {
    chatId: scope.chatId,
    subChatId: scope.subChatId,
    projectId: scope.project?.id ?? '',
    userMessage: { id: crypto.randomUUID(), role: 'user' as const, parts: [] },
    selfStarted: true,
  };
}
