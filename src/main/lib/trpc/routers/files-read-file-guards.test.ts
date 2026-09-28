import { execFileSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile as readFileFs,
  rm,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_TEXT_FILE_BYTES } from '../../../../shared/text-file-limits';

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

const isWindows = process.platform === 'win32';

// A device/FIFO never hits EOF and a multi-GB file OOMs main: guard by file type and size,
// never by path (docs/decisions/file-access-registration-gates-removed.md).
describe('filesRouter.readFile guards', () => {
  let dir: string;

  // Cold-importing the router takes several seconds; keep that out of the per-test timeouts
  // that prove a device or FIFO does not hang.
  beforeAll(async () => {
    await import('./files');
  }, 60_000);

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'frink-readfile-guard-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function getCaller() {
    const { filesRouter } = await import('./files');
    return filesRouter.createCaller({ getWindow: () => null });
  }

  it('rejects a directory', async () => {
    const caller = await getCaller();
    const sub = join(dir, 'sub');
    await mkdir(sub);

    await expect(caller.readFile({ filePath: sub })).rejects.toThrow('Not a file');
  });

  it.skipIf(isWindows)(
    'rejects a character device without hanging',
    async () => {
      const caller = await getCaller();

      await expect(caller.readFile({ filePath: '/dev/zero' })).rejects.toThrow('Not a file');
    },
    5_000,
  );

  it.skipIf(isWindows)(
    'rejects a symlink that points at a character device',
    async () => {
      const caller = await getCaller();
      const link = join(dir, 'innocent.txt');
      await symlink('/dev/zero', link);

      await expect(caller.readFile({ filePath: link })).rejects.toThrow('Not a file');
    },
    5_000,
  );

  it.skipIf(isWindows)(
    'rejects a FIFO with no writer without hanging',
    async () => {
      const caller = await getCaller();
      const fifo = join(dir, 'pipe');
      execFileSync('mkfifo', [fifo]);

      await expect(caller.readFile({ filePath: fifo })).rejects.toThrow('Not a file');
    },
    5_000,
  );

  it('rejects a file one byte over the limit with the display message', async () => {
    const caller = await getCaller();
    const big = join(dir, 'big.log');
    await writeFile(big, '');
    await truncate(big, MAX_TEXT_FILE_BYTES + 1);

    await expect(caller.readFile({ filePath: big })).rejects.toThrow(
      'File too large to display (max 10MB)',
    );
  });

  it('does not prefix guard errors with the generic wrapper', async () => {
    const caller = await getCaller();
    const sub = join(dir, 'sub');
    await mkdir(sub);

    await expect(caller.readFile({ filePath: sub })).rejects.not.toThrow(/Failed to read file/);
  });

  it('reads a file exactly at the limit', async () => {
    const caller = await getCaller();
    const edge = join(dir, 'edge.txt');
    await writeFile(edge, Buffer.alloc(MAX_TEXT_FILE_BYTES, 'a'));

    const content = await caller.readFile({ filePath: edge });
    expect(content.length).toBe(MAX_TEXT_FILE_BYTES);
  });

  it('reads an empty file as an empty string', async () => {
    const caller = await getCaller();
    const empty = join(dir, 'empty.txt');
    await writeFile(empty, '');

    await expect(caller.readFile({ filePath: empty })).resolves.toBe('');
  });

  it('decodes exactly like fs.readFile (BOM, CRLF, multi-byte, invalid UTF-8)', async () => {
    const caller = await getCaller();
    const mixed = join(dir, 'mixed.txt');
    const bytes = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('line one\r\nnaïve 🙂 日本語\r\n', 'utf8'),
      Buffer.from([0xff, 0xfe, 0x80]),
    ]);
    await writeFile(mixed, bytes);

    const expected = await readFileFs(mixed, 'utf-8');
    await expect(caller.readFile({ filePath: mixed })).resolves.toBe(expected);
  });

  it('follows a symlink to a regular file', async () => {
    const caller = await getCaller();
    const target = join(dir, 'real.md');
    await writeFile(target, '# real', 'utf8');
    const link = join(dir, 'link.md');
    await symlink(target, link);

    await expect(caller.readFile({ filePath: link })).resolves.toBe('# real');
  });

  it('keeps the existing wrapped message for a missing file', async () => {
    const caller = await getCaller();

    await expect(caller.readFile({ filePath: join(dir, 'missing.txt') })).rejects.toThrow(
      /^Failed to read file: /,
    );
  });
});
