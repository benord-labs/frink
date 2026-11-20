import { describe, expect, it, vi } from 'vitest';
import type { MobileChatChanges } from '../../../../../shared/types/remote/mobile';
import { MobileApiError } from '../errors';
import {
  MAX_ANSWER_BYTES,
  MAX_DIFF_CHARS,
  NO_CHANGES,
  parseHunks,
  projectChatChanges,
  readChatChanges,
} from './changes';

const WORKTREE = '/work/tree';
const answerBytes = (changes: MobileChatChanges) => Buffer.byteLength(JSON.stringify(changes));

function modified(path: string, body: string[]) {
  return [
    `diff --git a/${path} b/${path}`,
    'index 1111111..2222222 100644',
    `--- a/${path}`,
    `+++ b/${path}`,
    ...body,
  ].join('\n');
}

const checkout = modified('src/checkout.ts', [
  '@@ -10,3 +10,4 @@ export function pay() {',
  ' const frame = await waitForFrame();',
  '-await sleep(500);',
  '+await frame.ready();',
  '+await frame.click();',
  ' return frame;',
]);

const added = [
  'diff --git a/docs/notes.md b/docs/notes.md',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/docs/notes.md',
  '@@ -0,0 +1,2 @@',
  '+# Notes',
  '+Ready.',
].join('\n');

/** A file whose single added line is `chars` long. */
const bigFile = (path: string, chars: number) =>
  modified(path, ['@@ -1,0 +1,1 @@', `+${'x'.repeat(chars)}`]);

describe('projectChatChanges', () => {
  it('projects a parsed diff to numbered lines with paths relative to the worktree', () => {
    const changes = projectChatChanges(`${checkout}\n${added}`, WORKTREE);
    expect(changes).toMatchObject({ additions: 4, deletions: 1, truncated: false });
    expect(changes.files.map(({ path, status }) => ({ path, status }))).toEqual([
      { path: 'src/checkout.ts', status: 'modified' },
      { path: 'docs/notes.md', status: 'added' },
    ]);
    expect(changes.files[0]?.hunks).toEqual([
      {
        header: '@@ -10,3 +10,4 @@ export function pay() {',
        lines: [
          { kind: 'ctx', text: 'const frame = await waitForFrame();', oldNo: 10, newNo: 10 },
          { kind: 'del', text: 'await sleep(500);', oldNo: 11 },
          { kind: 'add', text: 'await frame.ready();', newNo: 11 },
          { kind: 'add', text: 'await frame.click();', newNo: 12 },
          { kind: 'ctx', text: 'return frame;', oldNo: 12, newNo: 13 },
        ],
      },
    ]);
  });

  it('answers only the totals when asked for a summary', () => {
    expect(projectChatChanges(`${checkout}\n${added}`, WORKTREE, true)).toEqual({
      additions: 4,
      deletions: 1,
      fileCount: 2,
      files: [],
      truncated: false,
    });
  });

  it('counts a change with no counted lines, such as a binary file, as a changed file', () => {
    const binary =
      'diff --git a/logo.png b/logo.png\nBinary files a/logo.png and b/logo.png differ';
    expect(projectChatChanges(binary, WORKTREE, true)).toMatchObject({
      additions: 0,
      deletions: 0,
      fileCount: 1,
    });
  });

  it('answers zeros for a worktree with no changes', () => {
    expect(projectChatChanges('', WORKTREE)).toEqual(NO_CHANGES);
  });

  it('cuts content at the size cap and says it did', () => {
    const fits = bigFile('src/a.ts', 1000);
    const tooBig = bigFile('src/b.ts', MAX_ANSWER_BYTES);
    const changes = projectChatChanges(`${tooBig}\n${fits}`, WORKTREE);
    expect(changes.truncated).toBe(true);
    expect(changes.files.map((file) => [file.path, file.omitted, file.hunks.length])).toEqual([
      ['src/b.ts', 'size', 0],
      ['src/a.ts', undefined, 1],
    ]);
    expect(answerBytes(changes)).toBeLessThanOrEqual(MAX_ANSWER_BYTES);
  });

  it('keeps the serialized answer under the cap for many short lines that need escaping', () => {
    const body = (index: number) =>
      Array.from({ length: 100 }, (_, line) => (line % 2 ? ' \t"\\"' : `  } // é ${index}`));
    const files = Array.from({ length: 60 }, (_, index) =>
      modified(`src/f${index}.ts`, ['@@ -1200,100 +1200,100 @@', ...body(index)]),
    );
    const changes = projectChatChanges(files.join('\n'), WORKTREE);
    expect(changes.truncated).toBe(true);
    expect(changes.files.some((file) => file.hunks.length > 0)).toBe(true);
    expect(answerBytes(changes)).toBeLessThanOrEqual(MAX_ANSWER_BYTES);
  });

  it('stops listing files once their entries alone fill the cap', () => {
    const many = Array.from({ length: 2000 }, (_, index) => bigFile(`src/f${index}.ts`, 1));
    const changes = projectChatChanges(many.join('\n'), WORKTREE);
    expect(changes.truncated).toBe(true);
    expect(changes.additions).toBe(2000);
    expect(changes.files.length).toBeLessThan(2000);
    expect(changes.fileCount).toBe(2000);
    expect(answerBytes(changes)).toBeLessThanOrEqual(MAX_ANSWER_BYTES);
  });

  it('does not parse a diff too large to parse quickly', () => {
    const huge = bigFile('src/huge.ts', MAX_DIFF_CHARS);
    expect(projectChatChanges(huge, WORKTREE, true)).toEqual({ ...NO_CHANGES, truncated: true });
  });

  it('keeps the content of secret and binary files off the phone', () => {
    const env = modified('.env', ['@@ -1 +1 @@', '-API_KEY=old', '+API_KEY=sk-live-123']);
    const key = modified('deploy/server.pem', ['@@ -0,0 +1 @@', '+-----BEGIN KEY-----']);
    const binary =
      'diff --git a/logo.png b/logo.png\nBinary files a/logo.png and b/logo.png differ';
    const changes = projectChatChanges([env, key, binary].join('\n'), WORKTREE);
    expect(changes.files.map((file) => [file.path, file.omitted, file.hunks])).toEqual([
      ['.env', 'secret', []],
      ['deploy/server.pem', 'secret', []],
      ['logo.png', 'binary', []],
    ]);
    expect(JSON.stringify(changes)).not.toContain('sk-live-123');
  });

  it('keeps a secret off the phone when its folder name is not valid UTF-8', () => {
    const diff = [
      'diff --git "a/caf\\351/.env" "b/caf\\351/.env"',
      '--- "a/caf\\351/.env"',
      '+++ "b/caf\\351/.env"',
      '@@ -1 +1 @@',
      '-A=old',
      '+A=sk-live-997',
    ].join('\n');
    const changes = projectChatChanges(diff, WORKTREE);
    expect(changes.files.map(({ path, omitted, hunks }) => [path, omitted, hunks])).toEqual([
      ['caf\uFFFD/.env', 'secret', []],
    ]);
    expect(JSON.stringify(changes)).not.toContain('sk-live-997');
  });

  it('keeps a secret off the phone when git quotes its path or it is renamed', () => {
    const quoted = [
      'diff --git "a/caf\\303\\251/server.pem" "b/caf\\303\\251/server.pem"',
      '--- "a/caf\\303\\251/server.pem"',
      '+++ "b/caf\\303\\251/server.pem"',
      '@@ -1 +1 @@',
      '-A=old',
      '+A=sk-live-999',
    ].join('\n');
    const renamed = [
      'diff --git a/.env b/notes.txt',
      'rename from .env',
      'rename to notes.txt',
      '--- a/.env',
      '+++ b/notes.txt',
      '@@ -1 +1 @@',
      '-A=old',
      '+A=sk-live-998',
    ].join('\n');
    const changes = projectChatChanges(`${quoted}\n${renamed}`, WORKTREE);
    expect(changes.files.map(({ path, status, omitted }) => [path, status, omitted])).toEqual([
      ['café/server.pem', 'modified', 'secret'],
      ['notes.txt', 'renamed', 'secret'],
    ]);
    expect(JSON.stringify(changes)).not.toContain('sk-live-99');
  });

  it('never sends a path outside the worktree', () => {
    const outside = modified('../other/secret.ts', ['@@ -1 +1 @@', '-a', '+b']);
    const absolute = modified('/etc/hosts', ['@@ -1 +1 @@', '-a', '+b']);
    const changes = projectChatChanges([outside, absolute, checkout].join('\n'), WORKTREE);
    expect(changes.files.map((file) => file.path)).toEqual(['src/checkout.ts']);
    expect(changes.additions).toBe(2);
  });

  it('names a deleted file by its old path and a renamed file by its new one', () => {
    const deleted = [
      'diff --git a/old.ts b/old.ts',
      'deleted file mode 100644',
      '--- a/old.ts',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-gone',
    ].join('\n');
    const renamed = [
      'diff --git a/a.ts b/b.ts',
      'rename from a.ts',
      'rename to b.ts',
      '--- a/a.ts',
      '+++ b/b.ts',
      '@@ -1 +1 @@',
      '-a',
      '+b',
    ].join('\n');
    const changes = projectChatChanges(`${deleted}\n${renamed}`, WORKTREE);
    expect(changes.files.map(({ path, status }) => [path, status])).toEqual([
      ['old.ts', 'deleted'],
      ['b.ts', 'renamed'],
    ]);
  });
});

describe('readChatChanges', () => {
  const chat = { worktreePath: WORKTREE, baseBranch: 'main' };

  it('answers zeros for a chat with no worktree without reading git', async () => {
    const diffOf = vi.fn();
    await expect(
      readChatChanges({ worktreePath: null, baseBranch: null }, false, diffOf),
    ).resolves.toEqual(NO_CHANGES);
    expect(diffOf).not.toHaveBeenCalled();
  });

  it('reads only uncommitted changes', async () => {
    const diffOf = vi.fn().mockResolvedValue({ success: true, diff: checkout });
    await expect(readChatChanges(chat, true, diffOf)).resolves.toMatchObject({ additions: 2 });
    expect(diffOf).toHaveBeenCalledWith(WORKTREE, 'main', { onlyUncommitted: true });
  });

  it('fails rather than showing an unreadable worktree as clean', async () => {
    const diffOf = vi.fn().mockResolvedValue({ success: false, error: 'not a git repository' });
    const read = readChatChanges(chat, false, diffOf);
    await expect(read).rejects.toBeInstanceOf(MobileApiError);
    await expect(read).rejects.toMatchObject({ status: 503 });
  });
});

describe('parseHunks', () => {
  it('skips the no-newline marker without shifting line numbers', () => {
    const [hunk] = parseHunks(
      ['@@ -1 +1 @@', '-a', '\\ No newline at end of file', '+b', ' c'].join('\n'),
    );
    expect(hunk?.lines).toEqual([
      { kind: 'del', text: 'a', oldNo: 1 },
      { kind: 'add', text: 'b', newNo: 1 },
      { kind: 'ctx', text: 'c', oldNo: 2, newNo: 2 },
    ]);
  });
});
