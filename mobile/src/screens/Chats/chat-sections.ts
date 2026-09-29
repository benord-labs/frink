import type { MobileChatSummary } from '../../../../src/shared/types/remote/mobile';
import { dateBucket, type DateBucket } from '../../lib/status';

export type ChatSection = { title: DateBucket; data: MobileChatSummary[] };

/** Groups the newest-first chat list by the day it was last active, keeping the server's order. */
export function chatSections(chats: MobileChatSummary[], now = new Date()): ChatSection[] {
  const sections: ChatSection[] = [];
  for (const chat of chats) {
    const title = dateBucket(chat.lastActiveAt, now);
    const section = sections.find((candidate) => candidate.title === title);
    if (section) section.data.push(chat);
    else sections.push({ title, data: [chat] });
  }
  return sections;
}

/** Line two of a row: what it is first ("Chat" or "Flow"), then where it works. */
export function chatSubtitle(chat: Pick<MobileChatSummary, 'projectName' | 'kind'>): string {
  return [chat.kind === 'flow' ? 'Flow' : 'Chat', chat.projectName].filter(Boolean).join(' · ');
}
