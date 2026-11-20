import { describe, expect, it } from 'vitest';
import { splitUnifiedDiffByFile, unquoteGitPath } from './diff-parser';

describe('splitUnifiedDiffByFile — binary file path fallback', () => {
  it('parses paths from diff --git line when ---/+++ headers are absent (binary)', () => {
    const diff = [
      'diff --git a/assets/logo.png b/assets/logo.png',
      'Binary files /dev/null and b/assets/logo.png differ',
    ].join('\n');

    const files = splitUnifiedDiffByFile(diff);
    expect(files).toHaveLength(1);
    expect(files[0].oldPath).toBe('assets/logo.png');
    expect(files[0].newPath).toBe('assets/logo.png');
    expect(files[0].isBinary).toBe(true);
  });

  it('prefers ---/+++ headers over diff --git line when both exist', () => {
    const diff = [
      'diff --git a/src/file.ts b/src/file.ts',
      '--- a/src/file.ts',
      '+++ b/src/file.ts',
      '@@ -1,3 +1,3 @@',
      '-old line',
      '+new line',
      ' context',
    ].join('\n');

    const files = splitUnifiedDiffByFile(diff);
    expect(files).toHaveLength(1);
    expect(files[0].oldPath).toBe('src/file.ts');
    expect(files[0].newPath).toBe('src/file.ts');
    expect(files[0].isBinary).toBe(false);
  });

  it('handles binary file with rename (different old/new paths)', () => {
    const diff = [
      'diff --git a/old-name.png b/new-name.png',
      'similarity index 100%',
      'rename from old-name.png',
      'rename to new-name.png',
      'Binary files a/old-name.png and b/new-name.png differ',
    ].join('\n');

    const files = splitUnifiedDiffByFile(diff);
    expect(files).toHaveLength(1);
    expect(files[0].oldPath).toBe('old-name.png');
    expect(files[0].newPath).toBe('new-name.png');
    expect(files[0].isBinary).toBe(true);
  });
});

describe('splitUnifiedDiffByFile — content lines that look like headers', () => {
  it('counts a removed `-- ` line and an added `++ ` line without reading them as paths', () => {
    const diff = [
      'diff --git a/q.sql b/q.sql',
      '--- a/q.sql',
      '+++ b/q.sql',
      '@@ -1,2 +1,2 @@',
      '-- a comment',
      '+++ a doubled plus',
      ' select 1;',
    ].join('\n');
    expect(splitUnifiedDiffByFile(diff)[0]).toMatchObject({
      oldPath: 'q.sql',
      newPath: 'q.sql',
      additions: 1,
      deletions: 1,
    });
  });

  it('keeps a deleted file named by its header when its first line starts with `-- `', () => {
    const diff = [
      'diff --git a/secrets.sql b/secrets.sql',
      'deleted file mode 100644',
      '--- a/secrets.sql',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '--- note',
      '-password=hunter2',
    ].join('\n');
    expect(splitUnifiedDiffByFile(diff)[0]).toMatchObject({
      oldPath: 'secrets.sql',
      isDeletedFile: true,
      deletions: 2,
    });
  });
});

describe('unquoteGitPath', () => {
  it.each([
    ['"b/caf\\303\\251/server.pem"', 'b/café/server.pem'],
    ['"a/say \\"hi\\".txt"', 'a/say "hi".txt'],
    ['"a/back\\\\slash\\ttab"', 'a/back\\slash\ttab'],
    ['"a/100%.txt"', 'a/100%.txt'],
    ['"a/caf\\351/.env"', 'a/caf\uFFFD/.env'],
    ['a/plain.txt', 'a/plain.txt'],
  ])('reads %s as %s', (raw, path) => {
    expect(unquoteGitPath(raw)).toBe(path);
  });

  it('names a file under a non-ASCII folder by its real path', () => {
    const diff = [
      'diff --git "a/caf\\303\\251/server.pem" "b/caf\\303\\251/server.pem"',
      '--- "a/caf\\303\\251/server.pem"',
      '+++ "b/caf\\303\\251/server.pem"',
      '@@ -1 +1 @@',
      '-A=old',
      '+A=new',
    ].join('\n');
    expect(splitUnifiedDiffByFile(diff)[0]).toMatchObject({
      oldPath: 'café/server.pem',
      newPath: 'café/server.pem',
    });
  });

  it('reads a quoted header for a file with no ---/+++ lines', () => {
    const diff = [
      'diff --git "a/\\346\\227\\245.png" "b/\\346\\227\\245.png"',
      'Binary files "a/\\346\\227\\245.png" and "b/\\346\\227\\245.png" differ',
    ].join('\n');
    expect(splitUnifiedDiffByFile(diff)[0]).toMatchObject({ oldPath: '日.png', newPath: '日.png' });
  });
});
