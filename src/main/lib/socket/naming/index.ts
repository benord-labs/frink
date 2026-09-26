/**
 * Fire-and-forget naming kicked off by a local message send (extracted verbatim from
 * `socket/client.ts#sendMessage`). Never blocks or fails the send.
 *
 * Two independent pipelines: `autoNameSubChat` names the sub-chat (and the parent, when this is
 * the chat's first sub-chat) from its first user message — its null-name guard skips
 * already-named / task / flow chats. Separately, a gitless BUILD project is re-attempted on
 * EVERY user message (abstains on chit-chat) until named; the cap is per sub-chat and
 * `maybeNameBuildProjectFromMessage`'s placeholder gate bounds cross-sub-chat exposure.
 */
import log from 'electron-log';
import { getDatabase } from '../../db';
import { getSubChatById, listSubChatsByChat, pickOldestSubChat } from '../../db/repos/sub-chats';
import {
  autoNameSubChat,
  maybeNameBuildProjectFromMessage,
  shouldReattemptProjectName,
} from '../../trpc/routers/chats/helpers/name-generation-async';

export function runSendSideNaming(input: {
  chatId: string;
  subChatId: string;
  projectId: string;
  userMessageParts?: Array<{ type: string; text?: string }>;
}): void {
  const text = input.userMessageParts?.find((p) => p.type === 'text')?.text ?? '';

  void (async () => {
    try {
      const db = getDatabase();
      const sub = await getSubChatById(db, input.subChatId);
      if (!sub || (sub.name ?? '').trim().length > 0) return;
      if (sub.messages.filter((m) => m.role === 'user').length !== 1) return;
      if (!text) return;
      const subs = await listSubChatsByChat(db, input.chatId);
      // Use the shared picker so "oldest" matches the rename procs deterministically
      // (lexical id tie-break on equal createdAt) — keeps parent.name === oldest sub-chat.
      const oldest = pickOldestSubChat(subs);
      await autoNameSubChat({
        chatId: input.chatId,
        subChatId: input.subChatId,
        projectId: input.projectId || null,
        projectPath: null,
        rawUserMessage: text,
        isFirstSubChat: oldest?.id === input.subChatId,
      });
    } catch (err) {
      log.warn('[Socket] auto-name failed:', err);
    }
  })();

  void (async () => {
    try {
      const sub = await getSubChatById(getDatabase(), input.subChatId);
      if (!sub) return;
      const userMsgCount = sub.messages.filter((m) => m.role === 'user').length;
      if (!shouldReattemptProjectName(userMsgCount)) return;
      if (!text) return;
      await maybeNameBuildProjectFromMessage(input.projectId || null, text);
    } catch (err) {
      log.warn('[Socket] build-project naming failed:', err);
    }
  })();
}
