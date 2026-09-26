import { describe, expect, it } from 'vitest';
import { splitUnifiedDiffByFile } from './diff-parser';

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
