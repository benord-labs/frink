import { describe, expect, it } from 'vitest';
import { isMarkdownPath } from './markdown-extensions';

describe('isMarkdownPath', () => {
  it('returns true for .md and .mdx case-insensitively', () => {
    expect(isMarkdownPath('README.md')).toBe(true);
    expect(isMarkdownPath('README.MD')).toBe(true);
    expect(isMarkdownPath('docs/guide.mdx')).toBe(true);
    expect(isMarkdownPath('post.MDX')).toBe(true);
  });

  it('returns false for other extensions and paths without extension', () => {
    expect(isMarkdownPath('README.markdown')).toBe(false);
    expect(isMarkdownPath('file.ts')).toBe(false);
    expect(isMarkdownPath('noext')).toBe(false);
    expect(isMarkdownPath('foo.md.backup')).toBe(false);
  });

  it('treats Windows-style paths with backslashes like POSIX for extension', () => {
    expect(isMarkdownPath('C:\\repo\\docs\\guide.md')).toBe(true);
    expect(isMarkdownPath('D:\\app\\README.MDX')).toBe(true);
  });
});
