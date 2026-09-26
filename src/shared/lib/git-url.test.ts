import { describe, expect, it } from 'vitest';
import { normalizeGitRemoteUrl } from './git-url';

describe('normalizeGitRemoteUrl', () => {
  it('normalizes known https remotes with and without .git suffix', () => {
    expect(normalizeGitRemoteUrl('https://github.com/org/repo.git')).toBe('github.com/org/repo');
    expect(normalizeGitRemoteUrl('https://github.com/org/repo')).toBe('github.com/org/repo');
    expect(normalizeGitRemoteUrl('https://gitlab.com/org/repo.git')).toBe('gitlab.com/org/repo');
    expect(normalizeGitRemoteUrl('https://gitlab.com/org/repo')).toBe('gitlab.com/org/repo');
    expect(normalizeGitRemoteUrl('https://bitbucket.org/org/repo.git')).toBe(
      'bitbucket.org/org/repo',
    );
    expect(normalizeGitRemoteUrl('https://bitbucket.org/org/repo')).toBe('bitbucket.org/org/repo');
  });

  it('normalizes ssh remotes for known providers', () => {
    expect(normalizeGitRemoteUrl('git@github.com:org/repo.git')).toBe('github.com/org/repo');
    expect(normalizeGitRemoteUrl('git@github.com-work:org/repo.git')).toBe('github.com/org/repo');
    expect(normalizeGitRemoteUrl('git@gitlab.com:org/repo.git')).toBe('gitlab.com/org/repo');
    expect(normalizeGitRemoteUrl('git@bitbucket.org:org/repo.git')).toBe('bitbucket.org/org/repo');
  });

  it('normalizes known provider https/http urls with query and fragment', () => {
    expect(normalizeGitRemoteUrl('https://github.com/org/repo?ref=main')).toBe(
      'github.com/org/repo',
    );
    expect(normalizeGitRemoteUrl('https://github.com/org/repo#readme')).toBe('github.com/org/repo');
    expect(normalizeGitRemoteUrl('http://github.com/org/repo.git')).toBe('github.com/org/repo');
  });

  it('returns trimmed input for empty or whitespace-only values', () => {
    expect(normalizeGitRemoteUrl('')).toBe('');
    expect(normalizeGitRemoteUrl('   ')).toBe('');
  });

  it('returns cleaned original for unknown or malformed inputs', () => {
    expect(normalizeGitRemoteUrl('https://example.com/org/repo.git')).toBe(
      'https://example.com/org/repo',
    );
    expect(normalizeGitRemoteUrl('git@example.com:org/repo.git')).toBe('git@example.com:org/repo');
    expect(normalizeGitRemoteUrl('not-a-url.git')).toBe('not-a-url');
  });
});
