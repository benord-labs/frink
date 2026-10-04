import type { MobileChatSummary } from '@frink/shared/types/remote/mobile';
export type ChatSection = {
  key: string;
  title: string;
  projectId: string | null;
  data: MobileChatSummary[];
};

/** Projects and their chats keep the server's newest-first order. */
export function chatSections(chats: MobileChatSummary[]): ChatSection[] {
  const sections = new Map<string | null, ChatSection>();
  for (const chat of chats) {
    let section = sections.get(chat.projectId);
    if (!section) {
      section = {
        key: JSON.stringify(chat.projectId),
        title: chat.projectName ?? 'Other chats',
        projectId: chat.projectId,
        data: [],
      };
      sections.set(chat.projectId, section);
    }
    section.data.push(chat);
  }
  return [...sections.values()];
}
