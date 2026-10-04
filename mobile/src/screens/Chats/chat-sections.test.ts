import { describe, expect, it } from 'vitest';
import type { MobileChatSummary } from '@frink/shared/types/remote/mobile';
import { chatSections } from './chat-sections';

const chat = (id: string, projectId: string | null, projectName = 'frink'): MobileChatSummary => ({
  id,
  name: id,
  projectId,
  projectName,
  activity: 'idle',
  kind: 'chat',
  lastActiveAt: new Date().toISOString(),
});

describe('chatSections', () => {
  it('keeps projects and their chats in newest-first order', () => {
    const sections = chatSections([
      chat('a', 'p2', 'Billing'),
      chat('b', 'p1'),
      chat('c', 'p2', 'Billing'),
    ]);
    expect(sections.map((section) => [section.title, section.data.map((row) => row.id)])).toEqual([
      ['Billing', ['a', 'c']],
      ['frink', ['b']],
    ]);
  });

  it('keeps distinct project ids separate even when names match', () => {
    const sections = chatSections([
      chat('a', 'p1'),
      chat('b', 'p2'),
      { ...chat('c', null), projectName: null },
    ]);
    expect(sections.map((section) => section.projectId)).toEqual(['p1', 'p2', null]);
    expect(new Set(sections.map((section) => section.key)).size).toBe(3);
    expect(sections[2].title).toBe('Other chats');
  });

  it('returns no sections for no chats', () => {
    expect(chatSections([])).toEqual([]);
  });
});
