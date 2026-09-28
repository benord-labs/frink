import { describe, expect, it } from 'vitest';
import { recentProjectsFirst } from './recent-projects';

const projects = [
  { id: 'a', name: 'Alpha' },
  { id: 'b', name: 'Beta' },
  { id: 'c', name: 'Gamma' },
  { id: 'd', name: 'Delta' },
];

describe('recentProjectsFirst', () => {
  it('orders projects by their newest chat and keeps the rest in place', () => {
    const chats = [
      { id: '1', name: 'Latest', projectId: 'c' },
      { id: '2', name: 'Loose', projectId: null },
      { id: '3', name: 'Older', projectId: 'a' },
      { id: '4', name: 'Oldest', projectId: 'c' },
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
