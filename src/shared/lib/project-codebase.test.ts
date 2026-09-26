import { describe, expect, it } from 'vitest';
import { dedupeByCodebase, getProjectCodebaseKey, groupByCodebase } from './project-codebase';

type ProjectLike = {
  id: string;
  name: string;
  git_remote: string | null;
  path: string;
  description: string | null;
};

function project(overrides: Partial<ProjectLike>): ProjectLike {
  return {
    id: overrides.id ?? 'p1',
    name: overrides.name ?? 'project',
    git_remote: overrides.git_remote ?? null,
    path: overrides.path ?? '/tmp/project',
    description: overrides.description ?? null,
  };
}

describe('dedupeByCodebase', () => {
  it('uses alphabetically earliest name as deterministic tie-breaker', () => {
    const items = [
      project({
        id: 'z',
        name: 'zeta-repo',
        git_remote: 'git@github.com:acme/app.git',
        path: '/tmp/a',
      }),
      project({
        id: 'a',
        name: 'alpha-repo',
        git_remote: 'git@github.com:acme/app.git',
        path: '/tmp/b',
      }),
    ];

    const deduped = dedupeByCodebase(
      items,
      (item) => item.git_remote,
      (item) => item.path,
      (item) => item.description,
    );

    expect(deduped).toHaveLength(1);
    expect(deduped[0]?.name).toBe('alpha-repo');
  });

  it('prefers entries with descriptions over entries without descriptions', () => {
    const items = [
      project({
        id: 'no-description',
        name: 'alpha-repo',
        git_remote: 'git@github.com:acme/app.git',
        path: '/tmp/a',
        description: null,
      }),
      project({
        id: 'has-description',
        name: 'zeta-repo',
        git_remote: 'https://github.com/acme/app',
        path: '/tmp/b',
        description: 'Primary project summary',
      }),
    ];

    const deduped = dedupeByCodebase(
      items,
      (item) => item.git_remote,
      (item) => item.path,
      (item) => item.description,
    );

    expect(deduped).toHaveLength(1);
    expect(deduped[0]?.id).toBe('has-description');
  });
});

describe('groupByCodebase', () => {
  it('groups SSH and HTTPS remotes for same repo under one key', () => {
    const items = [
      project({
        id: 'ssh',
        name: 'ssh-remote',
        git_remote: 'git@github.com:acme/app.git',
        path: '/tmp/one',
      }),
      project({
        id: 'https',
        name: 'https-remote',
        git_remote: 'https://github.com/acme/app',
        path: '/tmp/two',
      }),
      project({
        id: 'other',
        name: 'other-repo',
        git_remote: 'https://github.com/acme/other',
        path: '/tmp/three',
      }),
    ];

    const grouped = groupByCodebase(
      items,
      (item) => item.git_remote,
      (item) => item.path,
    );

    expect(grouped.size).toBe(2);
    const sameRepoGroup = grouped.get('github.com/acme/app');
    expect(sameRepoGroup?.map((item) => item.id)).toEqual(['ssh', 'https']);
  });

  it('falls back to path-based keys when git remotes are missing', () => {
    const items = [
      project({ id: 'a', name: 'repo-a', git_remote: null, path: '/tmp/a' }),
      project({ id: 'b', name: 'repo-b', git_remote: null, path: '/tmp/b' }),
    ];

    const grouped = groupByCodebase(
      items,
      (item) => item.git_remote,
      (item) => item.path,
    );

    expect(grouped.size).toBe(2);
    expect(grouped.get('/tmp/a')?.[0]?.id).toBe('a');
    expect(grouped.get('/tmp/b')?.[0]?.id).toBe('b');
  });
});

describe('getProjectCodebaseKey', () => {
  it('normalizes remote keys and falls back to path when remote is absent', () => {
    expect(getProjectCodebaseKey('git@github.com:acme/app.git', '/tmp/a')).toBe(
      'github.com/acme/app',
    );
    expect(getProjectCodebaseKey(null, '/tmp/fallback')).toBe('/tmp/fallback');
  });
});
