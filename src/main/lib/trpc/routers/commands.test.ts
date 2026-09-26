import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — drive the filesystem so the case-only rename guard can be exercised
// deterministically regardless of the host filesystem's case sensitivity.
// ---------------------------------------------------------------------------

const fsMock = vi.hoisted(() => ({
  realpath: vi.fn(),
  mkdir: vi.fn(),
  access: vi.fn(),
  stat: vi.fn(),
  writeFile: vi.fn(),
  rename: vi.fn(),
  rmdir: vi.fn(),
  unlink: vi.fn(),
  readFile: vi.fn(),
  readdir: vi.fn(),
}));

vi.mock('node:fs/promises', () => fsMock);
vi.mock('electron-log', () => ({
  default: { warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() },
}));

const ROOT = '/home/u/.frink/commands';
const OLD_PATH = `${ROOT}/deploy.md`;
const VENDOR_PATH = '/home/u/.frink/plugins/vendor/slack/1.2.0/commands/standup.md';

async function callUpdate(input: { path: string; newName?: string; content: string }) {
  const { commandsRouter } = await import('./commands');
  const caller = commandsRouter.createCaller({ getWindow: () => null });
  return caller.update(input);
}

describe('commandsRouter.update — rename collision safety', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // isCommandPath() resolves realpath and checks it sits inside a commands dir.
    fsMock.realpath.mockImplementation(async (p: string) => p);
    fsMock.mkdir.mockResolvedValue(undefined);
    fsMock.writeFile.mockResolvedValue(undefined);
    fsMock.rename.mockResolvedValue(undefined);
    fsMock.rmdir.mockResolvedValue(undefined);
  });

  it('rejects a case-only rename that would clobber a DIFFERENT existing command (case-sensitive FS)', async () => {
    // Case-sensitive FS: deploy.md and Deploy.md are distinct files (different
    // inodes). Renaming deploy -> Deploy must NOT overwrite the existing Deploy.md.
    fsMock.stat.mockImplementation(async (p: string) =>
      p.endsWith('Deploy.md') ? { ino: 2, dev: 1 } : { ino: 1, dev: 1 },
    );

    await expect(
      callUpdate({ path: OLD_PATH, newName: 'Deploy', content: 'body' }),
    ).rejects.toThrow(/already exists/);
    expect(fsMock.rename).not.toHaveBeenCalled();
  });

  it('allows a case-only rename of the SAME file (case-insensitive FS)', async () => {
    // Case-insensitive FS: deploy.md and Deploy.md resolve to the same inode.
    fsMock.stat.mockResolvedValue({ ino: 1, dev: 1 });

    await expect(
      callUpdate({ path: OLD_PATH, newName: 'Deploy', content: 'body' }),
    ).resolves.toEqual({ path: `${ROOT}/Deploy.md` });
    expect(fsMock.rename).toHaveBeenCalledWith(OLD_PATH, `${ROOT}/Deploy.md`);
  });

  it('rejects a rename onto a distinct existing command name', async () => {
    // Different name entirely — newPath exists as a distinct file → reject.
    fsMock.stat.mockImplementation(async (p: string) =>
      p.endsWith('release.md') ? { ino: 2, dev: 1 } : { ino: 1, dev: 1 },
    );
    await expect(
      callUpdate({ path: OLD_PATH, newName: 'release', content: 'body' }),
    ).rejects.toThrow(/already exists/);
    expect(fsMock.rename).not.toHaveBeenCalled();
  });

  it('rejects a path-traversal path', async () => {
    await expect(
      callUpdate({ path: `${ROOT}/../../../etc/passwd`, content: 'body' }),
    ).rejects.toThrow(/Invalid path/);
    expect(fsMock.writeFile).not.toHaveBeenCalled();
  });
});

describe('commandsRouter write mutations on a vendor plugin command (sc-2799)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fsMock.realpath.mockImplementation(async (p: string) => p);
  });

  it('update refuses the read-only vendor template', async () => {
    await expect(callUpdate({ path: VENDOR_PATH, content: 'edited' })).rejects.toThrow(
      'Invalid path',
    );
    expect(fsMock.writeFile).not.toHaveBeenCalled();
  });

  it('delete refuses the read-only vendor template', async () => {
    const { commandsRouter } = await import('./commands');
    const caller = commandsRouter.createCaller({ getWindow: () => null });
    await expect(caller.delete({ path: VENDOR_PATH })).rejects.toThrow('Invalid path');
    expect(fsMock.unlink).not.toHaveBeenCalled();
  });
});
