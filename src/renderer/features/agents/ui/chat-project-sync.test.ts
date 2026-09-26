/* eslint-disable project-structure/folder-structure */
import { describe, expect, it } from 'vitest';
import { resolveChatProjectSync } from './chat-project-sync';

const localProject = {
  id: 'p-1',
  name: 'Frink',
  path: '/repos/frink',
  gitRemoteUrl: 'https://github.com/acme/frink',
  gitProvider: 'github',
  gitOwner: 'acme',
  gitRepo: 'frink',
};

describe('resolveChatProjectSync', () => {
  it('clears when the chat has no project', () => {
    expect(
      resolveChatProjectSync({
        projectId: null,
        projectsLoaded: true,
        resolvedProject: undefined,
        chatProject: null,
      }),
    ).toEqual({ kind: 'clear' });
  });

  it('sets the resolved local project WITH git metadata (warm cache / main path)', () => {
    const decision = resolveChatProjectSync({
      projectId: 'p-1',
      projectsLoaded: true,
      resolvedProject: localProject,
      chatProject: undefined,
    });
    expect(decision).toEqual({
      kind: 'set',
      project: {
        id: 'p-1',
        name: 'Frink',
        path: '/repos/frink',
        gitRemoteUrl: 'https://github.com/acme/frink',
        gitProvider: 'github',
        gitOwner: 'acme',
        gitRepo: 'frink',
      },
    });
  });

  // Cold start: the project list (carrying the icon's git metadata) has not loaded yet.
  it('defers on a miss while the project list is still loading', () => {
    expect(
      resolveChatProjectSync({
        projectId: 'p-1',
        projectsLoaded: false,
        resolvedProject: undefined,
        chatProject: localProject,
      }),
    ).toEqual({ kind: 'defer' });
  });

  // Loaded-but-absent must SETTLE (not defer) so the effect cannot loop. The chat's own
  // git-bearing project is reflected so the icon still shows; validation clears it if truly gone.
  it('settles from the chat project when the list is loaded but the id is absent', () => {
    const decision = resolveChatProjectSync({
      projectId: 'p-1',
      projectsLoaded: true,
      resolvedProject: undefined,
      chatProject: localProject,
    });
    expect(decision).toEqual({ kind: 'set', project: localProject });
  });

  it('clears when the list is loaded, the id is absent, and there is no chat project', () => {
    expect(
      resolveChatProjectSync({
        projectId: 'p-1',
        projectsLoaded: true,
        resolvedProject: undefined,
        chatProject: null,
      }),
    ).toEqual({ kind: 'clear' });
  });

  // Invariant: a project found in the local map must be set even if the list query is mid-flight.
  // (Upstream this combo is unusual, but the branch order is the contract — a found project is
  // never deferred, otherwise its icon would be stuck behind the loading flag.)
  it('sets a resolved project even while the list reports not-loaded (never defers a hit)', () => {
    expect(
      resolveChatProjectSync({
        projectId: 'p-1',
        projectsLoaded: false,
        resolvedProject: localProject,
        chatProject: undefined,
      }),
    ).toEqual({ kind: 'set', project: expect.objectContaining({ id: 'p-1', gitOwner: 'acme' }) });
  });

  // Invariant: the resolved local project wins over the chat's own project copy when both exist.
  it('prefers the resolved local project over the chat project', () => {
    const decision = resolveChatProjectSync({
      projectId: 'p-1',
      projectsLoaded: true,
      resolvedProject: localProject,
      chatProject: { id: 'p-1', name: 'stale', path: '/stale', gitOwner: 'stale-owner' },
    });
    expect(decision).toEqual({ kind: 'set', project: localProject });
  });

  it('normalizes a null gitProvider to null (folder icon, no broken avatar)', () => {
    const nonGit = { id: 'p-2', name: 'plain', path: '/tmp/plain', gitProvider: null };
    const decision = resolveChatProjectSync({
      projectId: 'p-2',
      projectsLoaded: true,
      resolvedProject: nonGit,
      chatProject: undefined,
    });
    expect(decision).toEqual({
      kind: 'set',
      project: {
        id: 'p-2',
        name: 'plain',
        path: '/tmp/plain',
        gitRemoteUrl: undefined,
        gitProvider: null,
        gitOwner: undefined,
        gitRepo: undefined,
      },
    });
  });
});
