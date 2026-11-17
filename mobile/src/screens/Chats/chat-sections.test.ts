import { describe, expect, it } from 'vitest';
import type { MobileChatSummary } from '@frink/shared/types/remote/mobile';
import { chatSections, recentSections } from './chat-sections';

const chat = (id: string, projectId: string | null, projectName = 'frink'): MobileChatSummary => ({
  id,
  name: id,
  projectId,
  projectName,
  activity: 'idle',
  kind: 'chat',
  lastActiveAt: new Date().toISOString(),
});

describe('recentSections', () => {
  it('groups by local calendar day and orders actual activity across projects', () => {
    const now = new Date(2026, 9, 5, 0, 15);
    const recent = {
      ...chat('recent', 'p1'),
      lastActiveAt: new Date(2026, 9, 5, 0, 10).toISOString(),
    };
    const yesterday = {
      ...chat('yesterday', 'p2'),
      lastActiveAt: new Date(2026, 9, 4, 23, 59).toISOString(),
    };
    const older = { ...chat('older', 'p1'), lastActiveAt: new Date(2026, 9, 4, 9).toISOString() };
    const source = [older, recent, yesterday];
    const sections = recentSections(source, now);
    expect(sections.map(({ title, data }) => [title, data.map(({ id }) => id)])).toEqual([
      ['Today', ['recent']],
      ['Yesterday', ['yesterday', 'older']],
    ]);
    expect(source.map(({ id }) => id)).toEqual(['older', 'recent', 'yesterday']);
  });

  it('keeps older calendar dates separate and includes the year for older years', () => {
    const now = new Date(2026, 0, 2, 12);
    const old = { ...chat('old', null), lastActiveAt: new Date(2025, 11, 30, 12).toISOString() };
    const sections = recentSections([old], now);
    expect(sections[0].title).toBe(
      new Date(old.lastActiveAt).toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      }),
    );
    expect(sections[0].data).toEqual([old]);
    expect(recentSections([], now)).toEqual([]);
  });
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
