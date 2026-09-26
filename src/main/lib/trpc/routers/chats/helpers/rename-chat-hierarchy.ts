import type { getDatabase } from '../../../../db';
import { updateChat as updateChatLocal } from '../../../../db/repos/chats';
import {
  getSubChatById as getSubChatByIdLocal,
  listSubChatsByChat,
  pickOldestSubChat,
  renameSubChat as renameSubChatLocal,
} from '../../../../db/repos/sub-chats';
import { broadcastChatNameUpdated } from './name-generation-async';

type RenameTarget =
  | { kind: 'chat'; id: string; name: string }
  | { kind: 'sub-chat'; id: string; name: string };

export async function renameChatHierarchy(
  db: ReturnType<typeof getDatabase>,
  target: RenameTarget,
) {
  if (target.kind === 'chat') {
    const chat = await updateChatLocal(db, target.id, { name: target.name });
    if (!chat) return { kind: 'chat' as const, value: null };

    const oldest = pickOldestSubChat(await listSubChatsByChat(db, target.id));
    if (oldest) {
      await renameSubChatLocal(db, oldest.id, target.name);
      broadcastChatNameUpdated(target.id, oldest.id, target.name);
    }
    return { kind: 'chat' as const, value: chat };
  }

  await renameSubChatLocal(db, target.id, target.name);
  const subChat = await getSubChatByIdLocal(db, target.id);
  if (!subChat) return { kind: 'sub-chat' as const, value: null };

  const oldest = pickOldestSubChat(await listSubChatsByChat(db, subChat.chatId));
  if (oldest?.id === target.id) {
    await updateChatLocal(db, subChat.chatId, { name: target.name });
    broadcastChatNameUpdated(subChat.chatId, target.id, target.name);
  }
  return { kind: 'sub-chat' as const, value: subChat };
}
