import type { SubChatHydrated } from '../../../../db/repos/sub-chats';

export function mapSubChatResponse(subChat: SubChatHydrated) {
  return {
    id: subChat.id,
    name: subChat.name,
    chatId: subChat.chatId,
    sessionId: subChat.sessionId,
    streamId: subChat.streamId,
    mode: subChat.mode,
    messages: JSON.stringify(subChat.messages),
    createdAt: subChat.createdAt,
    updatedAt: subChat.updatedAt,
    additions: subChat.additions ?? 0,
    deletions: subChat.deletions ?? 0,
    fileCount: subChat.fileCount ?? 0,
  };
}
