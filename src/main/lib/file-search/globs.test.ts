import { describe, expect, it } from 'vitest';
import { compileGlobs, splitGlobList } from './globs';

const matches = (globs: string, path: string) => compileGlobs(globs).some((re) => re.test(path));

describe('splitGlobList', () => {
  it('splits on commas but keeps brace alternatives whole', () => {
    expect(splitGlobList(' src , *.{ts,tsx},, docs ')).toEqual(['src', '*.{ts,tsx}', 'docs']);
  });
});

describe('compileGlobs', () => {
  it('matches a slash-free pattern at any depth, and a folder name covers its contents', () => {
    expect(matches('*.ts', 'a/b/c.ts')).toBe(true);
    expect(matches('gen', 'src/gen/x.ts')).toBe(true);
    expect(matches('gen', 'src/generated.ts')).toBe(false);
  });

  it('anchors patterns with a slash or a leading slash at the project root', () => {
    expect(matches('src/*.ts', 'src/a.ts')).toBe(true);
    expect(matches('src/*.ts', 'lib/src/a.ts')).toBe(false);
    expect(matches('/top.ts', 'top.ts')).toBe(true);
    expect(matches('/top.ts', 'sub/top.ts')).toBe(false);
  });

  it('reads Windows-style typing the same way', () => {
    expect(matches('.\\src\\*.ts', 'src/a.ts')).toBe(true);
  });

  it('turns a pattern picomatch cannot read into one that matches nothing, so it never widens a search', () => {
    // An include list that compiled to no regexes would mean "every file".
    expect(compileGlobs('[z-a]')).not.toEqual([]);
    expect(matches('[z-a]', 'src/a.ts')).toBe(false);
  });

  it('reads a leading ! as part of the name, never as negation', () => {
    expect(matches('!src/**', 'lib/a.ts')).toBe(false);
    expect(matches('!gen', 'src/!gen/a.ts')).toBe(true);
  });

  it('splits on every comma when a `{` is never closed', () => {
    expect(splitGlobList('src{, *.ts')).toEqual(['src{', '*.ts']);
    expect(matches('gen, {tmp, docs', 'docs/a.md')).toBe(true);
  });

  it('reads `.` and `./` as the project root, so they match every path', () => {
    expect(matches('.', 'a/b.ts')).toBe(true);
    expect(matches('src, ./', 'docs/a.md')).toBe(true);
  });

  it('compiles an empty list to no filters', () => {
    expect(compileGlobs('  ,  ')).toEqual([]);
  });
});
