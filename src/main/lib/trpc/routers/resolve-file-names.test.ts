import { describe, expect, it } from 'vitest';
import { router } from '../index';
import { resolveFileNames, resolveNamesProcedure } from './resolve-file-names';

type Entry = { path: string; type: 'file' | 'folder' };

const entries: Entry[] = [
  { path: 'src/socket.ts', type: 'file' },
  { path: 'src/a/index.ts', type: 'file' },
  { path: 'src/b/index.ts', type: 'file' },
  { path: 'docs/notes.md', type: 'folder' },
];

describe('resolveFileNames', () => {
  it('names the only file with that name, and nothing when none or several match', () => {
    expect(
      resolveFileNames(entries, ['socket.ts', 'index.ts', 'missing.ts', 'notes.md', 'Socket.ts']),
    ).toEqual({
      'socket.ts': 'src/socket.ts',
      'index.ts': null,
      'missing.ts': null,
      'notes.md': null,
      'Socket.ts': null,
    });
  });

  it('reads Windows paths and answers with `/`', () => {
    const windows: Entry[] = [{ path: 'src\\main\\socket.ts', type: 'file' }];

    expect(resolveFileNames(windows, ['socket.ts'])).toEqual({ 'socket.ts': 'src/main/socket.ts' });
  });
});

describe('files.resolveNames', () => {
  const listed: string[] = [];
  const caller = router({
    resolveNames: resolveNamesProcedure(async (projectPath) => {
      listed.push(projectPath);
      return entries;
    }),
  }).createCaller({ getWindow: () => null });

  it("resolves names against the project's listing", async () => {
    await expect(
      caller.resolveNames({ projectPath: '/repo', names: ['socket.ts', 'index.ts'] }),
    ).resolves.toEqual({ 'socket.ts': 'src/socket.ts', 'index.ts': null });
    expect(listed).toEqual(['/repo']);
  });

  it('refuses more names than a reply looks up', async () => {
    const names = Array.from({ length: 201 }, (_, index) => `f${index}.ts`);

    await expect(caller.resolveNames({ projectPath: '/repo', names })).rejects.toThrow();
    await expect(
      caller.resolveNames({ projectPath: '/repo', names: names.slice(0, 200) }),
    ).resolves.toMatchObject({ 'f0.ts': null });
  });
});
