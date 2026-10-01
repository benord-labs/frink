import { describe, expect, it } from 'vitest';
import type { MobileChatSummary } from '@frink/shared/types/remote/mobile';
import { chatSections, chatSubtitle } from './chat-sections';

const now = new Date(2026, 8, 29, 15, 0);
const chat = (id: string, lastActiveAt: Date): MobileChatSummary => ({
  id,
  name: id,
  projectId: 'p',
  projectName: 'frink',
  activity: 'idle',
  kind: 'chat',
  lastActiveAt: lastActiveAt.toISOString(),
});

describe('chatSections', () => {
  it('buckets newest-first chats by calendar day, in order', () => {
    const sections = chatSections(
      [
        chat('a', new Date(2026, 8, 29, 9)),
        chat('b', new Date(2026, 8, 28, 23)),
        chat('c', new Date(2026, 8, 25)),
        chat('d', new Date(2026, 7, 1)),
        chat('e', new Date(2026, 6, 1)),
      ],
      now,
    );
    expect(sections.map((section) => [section.title, section.data.map((row) => row.id)])).toEqual([
      ['Today', ['a']],
      ['Yesterday', ['b']],
      ['Previous 7 days', ['c']],
      ['Older', ['d', 'e']],
    ]);
  });

  it('returns no sections for no chats', () => {
    expect(chatSections([], now)).toEqual([]);
  });
});

describe('chatSubtitle', () => {
  it('leads with the kind, then the project when there is one', () => {
    expect(chatSubtitle({ projectName: 'frink', kind: 'chat' })).toBe('Chat · frink');
    expect(chatSubtitle({ projectName: 'frink', kind: 'flow' })).toBe('Flow · frink');
    expect(chatSubtitle({ projectName: null, kind: 'flow' })).toBe('Flow');
    expect(chatSubtitle({ projectName: null, kind: 'chat' })).toBe('Chat');
  });
});
