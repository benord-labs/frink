import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getPath: () => tmpdir(),
  },
  BrowserWindow: {
    getAllWindows: () => [],
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString(),
  },
}));

describe('filesRouter.searchContent', () => {
  let projectPath: string;

  beforeEach(async () => {
    projectPath = await mkdtemp(join(tmpdir(), 'frink-files-search-'));
  });

  afterEach(async () => {
    await rm(projectPath, { recursive: true, force: true });
  });

  it('returns line matches with file paths and line numbers', async () => {
    await writeFile(join(projectPath, 'a.ts'), 'first line\nneedle match here\nlast line', 'utf8');
    await writeFile(join(projectPath, 'b.ts'), 'needle again', 'utf8');

    const { filesRouter } = await import('./files');
    const caller = filesRouter.createCaller({ getWindow: () => null });
    const result = await caller.searchContent({
      projectPath,
      query: 'needle',
      limit: 20,
      matchCase: false,
      wholeWord: false,
      useRegex: false,
    });

    expect(result.invalidRegex).toBe(false);
    expect(result.matches.length).toBe(2);
    expect(result.matches[0]).toMatchObject({
      filePath: 'a.ts',
      lineNumber: 2,
      startColumn: 1,
      endColumn: 7,
    });
    expect(result.matches[1]).toMatchObject({
      filePath: 'b.ts',
      lineNumber: 1,
      startColumn: 1,
      endColumn: 7,
    });
  });

  it('respects ignore directories and global result limit', async () => {
    await mkdir(join(projectPath, '.git'), { recursive: true });
    await writeFile(join(projectPath, '.git', 'ignored.txt'), 'needle in git dir', 'utf8');
    await writeFile(join(projectPath, 'one.ts'), 'needle 1\nneedle 2\nneedle 3', 'utf8');
    await writeFile(join(projectPath, 'two.ts'), 'needle 4', 'utf8');

    const { filesRouter } = await import('./files');
    const caller = filesRouter.createCaller({ getWindow: () => null });
    const result = await caller.searchContent({
      projectPath,
      query: 'needle',
      limit: 2,
      matchCase: false,
      wholeWord: false,
      useRegex: false,
    });

    expect(result.invalidRegex).toBe(false);
    expect(result.matches).toHaveLength(2);
    expect(result.matches.every((item) => item.filePath !== '.git/ignored.txt')).toBe(true);
  });

  it('skips large files over content search size cap', async () => {
    const largeLine = 'x'.repeat(600_000);
    await writeFile(join(projectPath, 'large.ts'), `${largeLine}\nneedle`, 'utf8');
    await writeFile(join(projectPath, 'small.ts'), 'needle in small file', 'utf8');

    const { filesRouter } = await import('./files');
    const caller = filesRouter.createCaller({ getWindow: () => null });
    const result = await caller.searchContent({
      projectPath,
      query: 'needle',
      limit: 20,
      matchCase: false,
      wholeWord: false,
      useRegex: false,
    });

    expect(result.invalidRegex).toBe(false);
    expect(result.matches.some((item) => item.filePath === 'large.ts')).toBe(false);
    expect(result.matches.some((item) => item.filePath === 'small.ts')).toBe(true);
  });

  it('skips binary-like files containing null bytes', async () => {
    await writeFile(join(projectPath, 'binary.ts'), 'abc\u0000needle', 'utf8');
    await writeFile(join(projectPath, 'text.ts'), 'needle in text file', 'utf8');

    const { filesRouter } = await import('./files');
    const caller = filesRouter.createCaller({ getWindow: () => null });
    const result = await caller.searchContent({
      projectPath,
      query: 'needle',
      limit: 20,
      matchCase: false,
      wholeWord: false,
      useRegex: false,
    });

    expect(result.invalidRegex).toBe(false);
    expect(result.matches.some((item) => item.filePath === 'binary.ts')).toBe(false);
    expect(result.matches.some((item) => item.filePath === 'text.ts')).toBe(true);
  });

  it('supports matchCase and wholeWord options', async () => {
    await writeFile(
      join(projectPath, 'case.ts'),
      'React react reactHooks\nconst react = 1;',
      'utf8',
    );

    const { filesRouter } = await import('./files');
    const caller = filesRouter.createCaller({ getWindow: () => null });

    const caseSensitive = await caller.searchContent({
      projectPath,
      query: 'React',
      limit: 20,
      matchCase: true,
      wholeWord: false,
      useRegex: false,
    });
    expect(caseSensitive.invalidRegex).toBe(false);
    expect(caseSensitive.matches).toHaveLength(1);

    const wholeWord = await caller.searchContent({
      projectPath,
      query: 'react',
      limit: 20,
      matchCase: false,
      wholeWord: true,
      useRegex: false,
    });
    expect(wholeWord.invalidRegex).toBe(false);
    expect(wholeWord.matches).toHaveLength(3);
    expect(
      wholeWord.matches.map((match) => [match.lineNumber, match.startColumn, match.endColumn]),
    ).toEqual([
      [1, 1, 6],
      [1, 7, 12],
      [2, 7, 12],
    ]);
  });

  it('supports regex and returns empty on invalid regex', async () => {
    await writeFile(join(projectPath, 'regex.ts'), 'setState\nsetup\nsetSort', 'utf8');

    const { filesRouter } = await import('./files');
    const caller = filesRouter.createCaller({ getWindow: () => null });

    const regexMatches = await caller.searchContent({
      projectPath,
      query: 'set[A-Z]\\w+',
      limit: 20,
      matchCase: true,
      wholeWord: true,
      useRegex: true,
    });
    expect(regexMatches.invalidRegex).toBe(false);
    expect(regexMatches.matches).toHaveLength(2);
    expect(regexMatches.matches[0]).toMatchObject({
      startColumn: 1,
      endColumn: 9,
    });

    const invalidRegex = await caller.searchContent({
      projectPath,
      query: '[abc',
      limit: 20,
      matchCase: false,
      wholeWord: false,
      useRegex: true,
    });
    expect(invalidRegex.invalidRegex).toBe(true);
    expect(invalidRegex.matches).toEqual([]);
  });

  it('returns accurate columns for tab-indented and end-of-line matches', async () => {
    await writeFile(
      join(projectPath, 'columns.ts'),
      '\tconst needle = 1;\nconst done = needle',
      'utf8',
    );

    const { filesRouter } = await import('./files');
    const caller = filesRouter.createCaller({ getWindow: () => null });
    const result = await caller.searchContent({
      projectPath,
      query: 'needle',
      limit: 20,
      matchCase: false,
      wholeWord: false,
      useRegex: false,
    });

    expect(result.invalidRegex).toBe(false);
    expect(result.matches).toHaveLength(2);
    expect(result.matches[0]).toMatchObject({
      filePath: 'columns.ts',
      lineNumber: 1,
      startColumn: 8,
      endColumn: 14,
      lineText: '\tconst needle = 1;',
    });
    expect(result.matches[1]).toMatchObject({
      filePath: 'columns.ts',
      lineNumber: 2,
      startColumn: 14,
      endColumn: 20,
    });
  });

  it('returns accurate columns for multibyte characters', async () => {
    await writeFile(join(projectPath, 'unicode.ts'), 'const emoji = "😀needle";', 'utf8');

    const { filesRouter } = await import('./files');
    const caller = filesRouter.createCaller({ getWindow: () => null });
    const result = await caller.searchContent({
      projectPath,
      query: 'needle',
      limit: 20,
      matchCase: false,
      wholeWord: false,
      useRegex: false,
    });

    expect(result.invalidRegex).toBe(false);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toMatchObject({
      filePath: 'unicode.ts',
      lineNumber: 1,
      startColumn: 18,
      endColumn: 24,
    });
  });

  it('returns every match on the same line (not just first occurrence)', async () => {
    await writeFile(join(projectPath, 'multi.ts'), 'needle x needle y needle', 'utf8');

    const { filesRouter } = await import('./files');
    const caller = filesRouter.createCaller({ getWindow: () => null });
    const result = await caller.searchContent({
      projectPath,
      query: 'needle',
      limit: 20,
      matchCase: false,
      wholeWord: false,
      useRegex: false,
    });

    expect(result.invalidRegex).toBe(false);
    const multiMatches = result.matches.filter((item) => item.filePath === 'multi.ts');
    expect(multiMatches).toHaveLength(3);
    expect(multiMatches.map((item) => [item.startColumn, item.endColumn])).toEqual([
      [1, 7],
      [10, 16],
      [19, 25],
    ]);
  });

  it('keeps far-right matches visible in truncated line previews', async () => {
    const longPrefix = 'x'.repeat(550);
    await writeFile(join(projectPath, 'long-line.ts'), `${longPrefix}needle-tail`, 'utf8');

    const { filesRouter } = await import('./files');
    const caller = filesRouter.createCaller({ getWindow: () => null });
    const result = await caller.searchContent({
      projectPath,
      query: 'needle',
      limit: 20,
      matchCase: false,
      wholeWord: false,
      useRegex: false,
    });

    expect(result.invalidRegex).toBe(false);
    const longLineMatch = result.matches.find((item) => item.filePath === 'long-line.ts');
    expect(longLineMatch).toBeDefined();
    expect(longLineMatch?.lineText.includes('needle-tail')).toBe(true);
  });
});
