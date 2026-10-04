import { describe, expect, it } from 'vitest';
import { chosenProject, creationChoiceChanged, filterProjects } from './new-chat-options';

const projects = [
  { id: 'a', name: 'frink', lastActiveAt: null },
  { id: 'b', name: 'Marketing-Site', lastActiveAt: null },
  { id: 'c', name: 'billing-api', lastActiveAt: null },
];

describe('creation choice ownership', () => {
  const choice = { projectId: 'a', useWorktree: true, mode: 'agent' as const };
  it('retires an unpublished agent creation when Plan is picked', () => {
    expect(creationChoiceChanged(choice, { ...choice, mode: 'plan' }, false)).toBe(true);
  });
  it('keeps a published chat whose mode can be changed in place', () => {
    expect(creationChoiceChanged(choice, { ...choice, mode: 'plan' }, true)).toBe(false);
  });
  it.each([
    { ...choice, projectId: 'b' },
    { ...choice, useWorktree: false },
  ])('retires even a published chat when its project or work location changes', (next) =>
    expect(creationChoiceChanged(choice, next, true)).toBe(true),
  );
});

describe('filterProjects', () => {
  it('matches names case-insensitively and keeps the order', () => {
    expect(filterProjects(projects, ' SITE ').map((project) => project.id)).toEqual(['b']);
    expect(filterProjects(projects, 'i').map((project) => project.id)).toEqual(['a', 'b', 'c']);
  });

  it('returns everything for an empty query', () => {
    expect(filterProjects(projects, '  ')).toBe(projects);
  });
});

describe('chosenProject', () => {
  it('finds a remembered project that still exists', () => {
    expect(chosenProject(projects, 'c')?.name).toBe('billing-api');
  });

  it('falls back to the most recent project when none is remembered or it was removed', () => {
    expect(chosenProject(projects, 'gone')?.id).toBe('a');
    expect(chosenProject(projects, null)?.id).toBe('a');
  });

  it('waits for the list to load, and has nothing to offer with no projects', () => {
    expect(chosenProject(undefined, 'a')).toBeUndefined();
    expect(chosenProject([], null)).toBeUndefined();
  });
});
