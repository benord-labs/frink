import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileTooLargeError, NotAFileError, readTextFileBounded } from './read-text-file-bounded';

// The cap applies to bytes actually read, so a file that grows after the caller's stat
// (an active log) still cannot push more than maxBytes into memory.
describe('readTextFileBounded', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'frink-bounded-read-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('rejects content past maxBytes even when no prior size check ran', async () => {
    const file = join(dir, 'grew.log');
    await writeFile(file, 'x'.repeat(101));

    await expect(readTextFileBounded(file, 100)).rejects.toBeInstanceOf(FileTooLargeError);
  });

  it('returns content that is exactly maxBytes', async () => {
    const file = join(dir, 'fits.log');
    await writeFile(file, 'y'.repeat(100));

    await expect(readTextFileBounded(file, 100)).resolves.toBe('y'.repeat(100));
  });

  it('keeps a multi-byte character that straddles the internal read chunks intact', async () => {
    const file = join(dir, 'emoji.txt');
    const text = `${'a'.repeat(3)}🙂${'b'.repeat(3)}`;
    await writeFile(file, text, 'utf8');

    await expect(readTextFileBounded(file, 1024, 4)).resolves.toBe(text);
  });

  // Windows refuses to open() a directory at all, so only POSIX reaches the fstat check.
  it.skipIf(process.platform === 'win32')('rejects a directory with NotAFileError', async () => {
    await expect(readTextFileBounded(dir, 100)).rejects.toBeInstanceOf(NotAFileError);
  });

  it.skipIf(process.platform === 'win32')(
    'rejects a character device opened directly',
    async () => {
      await expect(readTextFileBounded('/dev/zero', 100)).rejects.toBeInstanceOf(NotAFileError);
    },
    5_000,
  );

  // Stands in for a path swapped to a FIFO after the router's stat(): without O_NONBLOCK,
  // open() would block until a writer appeared.
  it.skipIf(process.platform === 'win32')(
    'rejects a FIFO opened directly without waiting for a writer',
    async () => {
      const fifo = join(dir, 'pipe');
      execFileSync('mkfifo', [fifo]);

      await expect(readTextFileBounded(fifo, 100)).rejects.toBeInstanceOf(NotAFileError);
    },
    5_000,
  );
});
