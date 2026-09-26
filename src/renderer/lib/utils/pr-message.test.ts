import { describe, expect, it } from 'vitest';
import {
  generateCommitMessage,
  generateFixConflictsMessage,
  generateMergePrMessage,
} from './pr-message';

const CONTEXT = { branch: 'feature', baseBranch: 'main', uncommittedCount: 3, hasUpstream: true };

describe('generateCommitMessage', () => {
  it('asks for a local commit only', () => {
    const message = generateCommitMessage(CONTEXT);
    expect(message).toContain('3 uncommitted changes on branch feature');
    expect(message).toContain('Do not push');
  });

  it('says there is nothing to commit on a clean branch', () => {
    expect(generateCommitMessage({ ...CONTEXT, uncommittedCount: 0 })).toContain(
      'already committed',
    );
  });
});

describe('generateMergePrMessage', () => {
  it('checks mergeability before a squash merge', () => {
    const message = generateMergePrMessage(CONTEXT);
    expect(message).toContain('origin/main');
    expect(message.indexOf('gh pr view')).toBeLessThan(message.indexOf('gh pr merge --squash'));
  });
});

describe('generateFixConflictsMessage', () => {
  it('merges the base branch into the PR branch', () => {
    expect(generateFixConflictsMessage(CONTEXT)).toContain('Merge origin/main into feature');
  });
});
