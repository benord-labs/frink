import { describe, expect, it } from 'vitest';
import { buildFileLinkLabels, buildFileLinkSuffixByPath, scopePath } from './file-link-scope';

describe('buildFileLinkSuffixByPath', () => {
  it('gives same-name files at least two parent folders', () => {
    expect(
      buildFileLinkSuffixByPath(['src/x/a/index.ts', 'src/x/b/index.ts', 'src/main.ts']),
    ).toEqual(
      new Map([
        ['src/x/a/index.ts', 'x/a'],
        ['src/x/b/index.ts', 'x/b'],
      ]),
    );
  });

  it('goes as deep as it takes to tell them apart', () => {
    expect(buildFileLinkSuffixByPath(['a/x/y/z/f.ts', 'b/x/y/z/f.ts'])).toEqual(
      new Map([
        ['a/x/y/z/f.ts', 'a/x/y/z'],
        ['b/x/y/z/f.ts', 'b/x/y/z'],
      ]),
    );
  });

  it('stops at the folders a path has, and gives a file at the top none', () => {
    expect(buildFileLinkSuffixByPath(['src/index.ts', 'index.ts', 'lib/deep/index.ts'])).toEqual(
      new Map([
        ['src/index.ts', 'src'],
        ['lib/deep/index.ts', 'lib/deep'],
      ]),
    );
  });

  it('labels nothing when the same file is named twice', () => {
    expect(buildFileLinkSuffixByPath(['src/a.ts', 'src/a.ts'])).toEqual(new Map());
  });
});

describe('scopePath', () => {
  it('compares paths with `/`, without `./`, and relative to the chat folder', () => {
    expect(scopePath('./src/a.ts', '/repo')).toBe('src/a.ts');
    expect(scopePath('/repo/src/a.ts', '/repo/')).toBe('src/a.ts');
    expect(scopePath('src\\a.ts', undefined)).toBe('src/a.ts');
    expect(scopePath('/elsewhere/a.ts', '/repo')).toBe('/elsewhere/a.ts');
    expect(scopePath('~/notes/a.md', '/repo')).toBe('~/notes/a.md');
  });
});

describe('buildFileLinkLabels', () => {
  it('places bare names and labels same-name files across paths and placed names', () => {
    const labels = buildFileLinkLabels(
      ['./src/a/index.ts', '/repo/src/a/index.ts', 'src/main.ts', 'index.ts', 'gone.ts'],
      { 'index.ts': 'lib/b/index.ts', 'gone.ts': null },
      '/repo',
    );

    expect(labels.resolve('index.ts')).toBe('lib/b/index.ts');
    expect(labels.resolve('gone.ts')).toBeUndefined();
    expect(labels.suffixFor('/repo/src/a/index.ts')).toBe('src/a');
    expect(labels.suffixFor('src/a/index.ts')).toBe('src/a');
    expect(labels.suffixFor('lib/b/index.ts')).toBe('lib/b');
    expect(labels.suffixFor('src/main.ts')).toBeUndefined();
  });

  // Agents often name a file by path, then by name alone; both badges are the same file.
  it('labels nothing when a placed name is a file the reply also names by path', () => {
    const labels = buildFileLinkLabels(
      ['src/a/index.ts', 'index.ts'],
      { 'index.ts': 'src/a/index.ts' },
      '/repo',
    );
    expect(labels.suffixFor('src/a/index.ts')).toBeUndefined();
  });

  it('places nothing before the lookup answers', () => {
    const labels = buildFileLinkLabels(['index.ts'], undefined, '/repo');
    expect(labels.resolve('index.ts')).toBeUndefined();
  });
});
