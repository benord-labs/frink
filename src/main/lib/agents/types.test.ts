import { describe, expect, it } from 'vitest';
import {
  deriveSourceFromPath,
  getIdeDirPriority,
  IDE_DIRS_PRIORITY,
  isUniversalPath,
} from './types';

/**
 * A Frink worktree path contains `/.frink/` AND the resource's own tool dir, so these fixtures pin
 * that `deriveSourceFromPath` tests `.frink` LAST.
 */
const worktree = (dir: string) =>
  `/Users/b/.frink/worktrees/frink/husky-solstice/${dir}/agents/a.md`;
const winWorktree = (dir: string) =>
  `C:\\Users\\b\\.frink\\worktrees\\frink\\husky-solstice\\${dir}\\agents\\a.md`;

describe('deriveSourceFromPath — tool precedence', () => {
  // Reordering these checks so `.frink` wins would misclassify every project resource in a
  // worktree, showing the wrong tool on every Settings row.
  it('a project .claude resource inside a Frink worktree is claude-code, not frink', () => {
    expect(deriveSourceFromPath(worktree('.claude'))).toBe('claude-code');
  });

  it('a project .cursor resource inside a Frink worktree is cursor, not frink', () => {
    expect(deriveSourceFromPath(worktree('.cursor'))).toBe('cursor');
  });

  it('a global resource under ~/.frink is frink when no tool dir is present', () => {
    expect(deriveSourceFromPath('/Users/b/.frink/agents/a.md')).toBe('frink');
  });
});

describe('deriveSourceFromPath — Windows separators', () => {
  // Frink ships mac, win and linux builds, so both separator styles reach this function.
  it.each([
    ['.cursor', 'cursor'],
    ['.claude', 'claude-code'],
  ] as const)('classifies a backslash %s path as %s', (dir, expected) => {
    expect(deriveSourceFromPath(`C:\\Users\\b\\${dir}\\agents\\a.md`)).toBe(expected);
  });

  it('applies the same precedence to backslash paths inside a Frink worktree', () => {
    expect(deriveSourceFromPath(winWorktree('.claude'))).toBe('claude-code');
    expect(deriveSourceFromPath(winWorktree('.cursor'))).toBe('cursor');
  });

  it('classifies a backslash .frink path as frink', () => {
    expect(deriveSourceFromPath('C:\\Users\\b\\.frink\\agents\\a.md')).toBe('frink');
  });
});

describe('deriveSourceFromPath — unrecognized paths', () => {
  it('falls back to claude-code when no tool dir is present', () => {
    expect(deriveSourceFromPath('/tmp/scratch/agents/a.md')).toBe('claude-code');
  });

  it('falls back to claude-code for the empty path', () => {
    expect(deriveSourceFromPath('')).toBe('claude-code');
  });

  it('does not match a tool dir that is only a name fragment', () => {
    // `/my.cursor/` and `/.cursorrules/` must not read as the `.cursor` tool dir.
    expect(deriveSourceFromPath('/Users/b/my.cursor/agents/a.md')).toBe('claude-code');
    expect(deriveSourceFromPath('/Users/b/.cursorrules/agents/a.md')).toBe('claude-code');
  });
});

describe('getIdeDirPriority', () => {
  it('puts the project CLI its own dir first', () => {
    expect(getIdeDirPriority('cursor')[0]).toBe('.cursor');
    expect(getIdeDirPriority('claude-code')[0]).toBe('.claude');
  });

  it('falls back to the global order when the project CLI is unknown', () => {
    expect(getIdeDirPriority(undefined)).toEqual(IDE_DIRS_PRIORITY);
    expect(getIdeDirPriority(undefined)[0]).toBe('.frink');
  });

  // Each variant must REORDER the same three dirs, never drop one: a missing dir silently
  // stops discovery of every resource that lives there for that CLI.
  it('every variant returns the same set of dirs, only reordered', () => {
    const expected = [...IDE_DIRS_PRIORITY].sort();
    for (const cliType of ['cursor', 'claude-code', undefined] as const) {
      expect([...getIdeDirPriority(cliType)].sort()).toEqual(expected);
    }
  });
});

describe('isUniversalPath', () => {
  it('detects the universal home with either separator style', () => {
    expect(isUniversalPath('/Users/b/.agents/skills/x/SKILL.md')).toBe(true);
    expect(isUniversalPath('C:\\Users\\b\\.agents\\skills\\x\\SKILL.md')).toBe(true);
  });

  it('does not match a directory that merely contains the name', () => {
    // Guards against simplifying the check to `includes('.agents')`, which would treat these
    // as the universal home and wrongly mark the resource as following the user across tools.
    expect(isUniversalPath('/Users/b/my.agents/skills/x/SKILL.md')).toBe(false);
    expect(isUniversalPath('/Users/b/.agents.bak/skills/x/SKILL.md')).toBe(false);
  });

  it('does not match a tool dir that is not the universal home', () => {
    expect(isUniversalPath('/Users/b/.claude/skills/x/SKILL.md')).toBe(false);
  });
});
