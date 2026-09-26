import { describe, expect, it } from 'vitest';
import type { ParsedDiffFile } from '../../../../git/diff-parser';
import { buildHeuristicCommitMessage } from './heuristic-commit-message';

type FileOverrides = Partial<ParsedDiffFile> & { newPath: string };

function file(overrides: FileOverrides): ParsedDiffFile {
  return {
    key: `${overrides.oldPath ?? overrides.newPath}->${overrides.newPath}`,
    oldPath: overrides.newPath,
    diffText: '',
    isBinary: false,
    additions: 1,
    deletions: 1,
    isValid: true,
    fileLang: null,
    isNewFile: false,
    isDeletedFile: false,
    ...overrides,
  };
}

function added(newPath: string): ParsedDiffFile {
  return file({ newPath, oldPath: '/dev/null', additions: 5, deletions: 0, isNewFile: true });
}

function removed(oldPath: string): ParsedDiffFile {
  return file({ newPath: '/dev/null', oldPath, additions: 0, deletions: 5, isDeletedFile: true });
}

describe('buildHeuristicCommitMessage', () => {
  describe('file-count boundary', () => {
    it('names the single file', () => {
      expect(buildHeuristicCommitMessage([file({ newPath: 'src/auth.ts' })])).toBe(
        'fix: update auth.ts',
      );
    });

    it('lists exactly three files by name', () => {
      const files = ['src/a.ts', 'src/b.ts', 'src/c.ts'].map((p) => file({ newPath: p }));

      expect(buildHeuristicCommitMessage(files)).toBe('fix: update a.ts, b.ts, c.ts');
    });

    it('switches to a count at four files', () => {
      const files = ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'].map((p) =>
        file({ newPath: p }),
      );

      expect(buildHeuristicCommitMessage(files)).toBe('fix: update 4 files');
    });
  });

  describe('prefix detection', () => {
    it('uses feat when every file is new', () => {
      expect(buildHeuristicCommitMessage([added('src/new.ts')])).toBe('feat: update new.ts');
    });

    it('uses chore when the change is purely deletions', () => {
      expect(buildHeuristicCommitMessage([removed('src/old.ts')])).toBe('chore: update old.ts');
    });

    it('uses test for a spec-only change', () => {
      expect(buildHeuristicCommitMessage([file({ newPath: 'src/auth.spec.ts' })])).toBe(
        'test: update auth.spec.ts',
      );
    });

    it('uses docs for a markdown-only change', () => {
      expect(buildHeuristicCommitMessage([file({ newPath: 'docs/guide.md' })])).toBe(
        'docs: update guide.md',
      );
    });

    it('does not claim test when a config file is also touched', () => {
      const files = [file({ newPath: 'src/a.test.ts' }), file({ newPath: 'tsconfig.json' })];

      expect(buildHeuristicCommitMessage(files)).toBe('fix: update a.test.ts, tsconfig.json');
    });

    it('does not claim feat when the commit both adds and deletes', () => {
      expect(buildHeuristicCommitMessage([added('src/new.ts'), removed('src/old.ts')])).toBe(
        'fix: update new.ts, old.ts',
      );
    });

    it('falls back to chore when no rule matches', () => {
      expect(
        buildHeuristicCommitMessage([file({ newPath: 'src/a.ts', additions: 0, deletions: 0 })]),
      ).toBe('chore: update a.ts');
    });
  });

  describe('path shapes', () => {
    it('takes the leaf name from a deep posix path', () => {
      expect(
        buildHeuristicCommitMessage([
          file({ newPath: 'src/main/lib/trpc/routers/chats/create.ts' }),
        ]),
      ).toBe('fix: update create.ts');
    });

    it('handles a path containing spaces', () => {
      expect(buildHeuristicCommitMessage([file({ newPath: 'src/my component.tsx' })])).toBe(
        'fix: update my component.tsx',
      );
    });

    // Different files sharing a basename collapse to one name; pinned as current behaviour.
    it('collapses same-named files in different directories to a single name', () => {
      const files = [file({ newPath: 'src/a/index.ts' }), file({ newPath: 'src/b/index.ts' })];

      expect(buildHeuristicCommitMessage(files)).toBe('fix: update index.ts');
    });
  });
});
