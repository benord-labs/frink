import { describe, expect, it } from 'vitest';
import { recentProjectsFirst } from './recent-projects';

const projects = [
  { id: 'a', name: 'Alpha', lastActiveAt: null },
  { id: 'b', name: 'Beta', lastActiveAt: null },
  { id: 'c', name: 'Gamma', lastActiveAt: null },
  { id: 'd', name: 'Delta', lastActiveAt: null },
];
const summary = { projectName: null, lastActiveAt: '2026-09-29T00:00:00Z', activity: 'idle', kind: 'chat' } as const;

describe('recentProjectsFirst', () => {
  it('orders projects by their newest chat and keeps the rest in place', () => {
    const chats = [
      { ...summary, id: '1', name: 'Latest', projectId: 'c' },
      { ...summary, id: '2', name: 'Loose', projectId: null },
      { ...summary, id: '3', name: 'Older', projectId: 'a' },
      { ...summary, id: '4', name: 'Oldest', projectId: 'c' },
    ];
    expect(recentProjectsFirst(projects, chats).map((project) => project.id)).toEqual([
      'c',
      'a',
      'b',
      'd',
    ]);
  });

  it('keeps the computer order before chats load', () => {
    expect(recentProjectsFirst(projects)).toEqual(projects);
  });
});
