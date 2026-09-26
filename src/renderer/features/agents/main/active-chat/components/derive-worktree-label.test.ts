import { describe, expect, it } from 'vitest';
import { deriveWorktreeLabel } from './derive-worktree-label';

describe('deriveWorktreeLabel', () => {
  it('returns WT fallback when path is nullish', () => {
    expect(deriveWorktreeLabel(null)).toEqual({ worktreeName: null, worktreeLabel: 'WT' });
    expect(deriveWorktreeLabel(undefined)).toEqual({ worktreeName: null, worktreeLabel: 'WT' });
  });

  it('normalizes Windows separators and returns final segment', () => {
    expect(deriveWorktreeLabel('C:\\tmp\\worktrees\\owners-web\\zonal-manatee-8369af')).toEqual({
      worktreeName: 'zonal-manatee-8369af',
      worktreeLabel: 'WT: zonal-manatee-8369af',
    });
  });

  it('handles trailing slash paths', () => {
    expect(deriveWorktreeLabel('/tmp/worktrees/owners-web/zonal-manatee-8369af/')).toEqual({
      worktreeName: 'zonal-manatee-8369af',
      worktreeLabel: 'WT: zonal-manatee-8369af',
    });
  });

  it('returns final segment for simple unix path', () => {
    expect(deriveWorktreeLabel('/tmp/worktrees/foo')).toEqual({
      worktreeName: 'foo',
      worktreeLabel: 'WT: foo',
    });
  });

  it('uses raw value when no path separator exists', () => {
    expect(deriveWorktreeLabel('worktree-name')).toEqual({
      worktreeName: 'worktree-name',
      worktreeLabel: 'WT: worktree-name',
    });
  });

  it('returns WT fallback when path is empty string', () => {
    expect(deriveWorktreeLabel('')).toEqual({ worktreeName: null, worktreeLabel: 'WT' });
  });

  it('returns WT fallback for slash-only paths', () => {
    expect(deriveWorktreeLabel('/')).toEqual({ worktreeName: null, worktreeLabel: 'WT' });
    expect(deriveWorktreeLabel('////')).toEqual({ worktreeName: null, worktreeLabel: 'WT' });
  });

  it('normalizes mixed separators and trailing slash', () => {
    expect(deriveWorktreeLabel('C:/tmp\\worktrees\\foo/')).toEqual({
      worktreeName: 'foo',
      worktreeLabel: 'WT: foo',
    });
  });

  it('preserves dot-segment names as valid labels', () => {
    expect(deriveWorktreeLabel('.')).toEqual({ worktreeName: '.', worktreeLabel: 'WT: .' });
    expect(deriveWorktreeLabel('..')).toEqual({ worktreeName: '..', worktreeLabel: 'WT: ..' });
  });
});
