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

/** History follows each chat's last activity, grouped by the phone's local calendar day. */
export function recentSections(chats: MobileChatSummary[], now = new Date()): ChatSection[] {
  const today = now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const sections = new Map<string, ChatSection>();
  const ordered = [...chats].sort(
    (a, b) => Date.parse(b.lastActiveAt) - Date.parse(a.lastActiveAt),
  );
  for (const chat of ordered) {
    const date = new Date(chat.lastActiveAt);
    const key = date.toDateString();
    if (!sections.has(key)) {
      const title =
        key === today
          ? 'Today'
          : key === yesterday.toDateString()
            ? 'Yesterday'
            : date.toLocaleDateString(undefined, {
                month: 'short',
                day: 'numeric',
                year: date.getFullYear() === now.getFullYear() ? undefined : 'numeric',
              });
      sections.set(key, { key, title, projectId: null, data: [] });
    }
    sections.get(key)!.data.push(chat);
  }
  return [...sections.values()];
}
