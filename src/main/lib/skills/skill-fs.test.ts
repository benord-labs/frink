import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dirHash, dirStatSig } from './skill-fs';

describe('skill-fs', () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-fs-'));
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  describe('dirHash — large assets take the stream path (>256KB)', () => {
    it('is deterministic and reflects CONTENT (not just size) for a streamed file', async () => {
      const big = path.join(tmp, 'big.bin');
      await fs.writeFile(big, Buffer.alloc(300 * 1024, 1)); // over the 256KB stream threshold
      await fs.writeFile(path.join(tmp, 'small.md'), 'hi');
      const first = await dirHash(tmp);
      expect(await dirHash(tmp)).toBe(first); // stable across the stream path
      await fs.writeFile(big, Buffer.alloc(300 * 1024, 2)); // SAME size, different bytes
      expect(await dirHash(tmp)).not.toBe(first); // stream-hash read the content, not the size
    });
  });

  describe('dirStatSig', () => {
    it('is stable across calls and changes when a file grows', async () => {
      await fs.writeFile(path.join(tmp, 'a.md'), 'one');
      const sig = await dirStatSig(tmp);
      expect(await dirStatSig(tmp)).toBe(sig);
      await fs.writeFile(path.join(tmp, 'a.md'), 'one-and-bigger'); // size change
      expect(await dirStatSig(tmp)).not.toBe(sig);
    });

    it('honours the exclude set', async () => {
      await fs.writeFile(path.join(tmp, 'a.md'), 'x');
      await fs.writeFile(path.join(tmp, '.marker'), 'm');
      expect(await dirStatSig(tmp)).not.toBe(await dirStatSig(tmp, new Set(['.marker'])));
    });
  });
});
