import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { main } from './component-shot';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

describe('component-shot', () => {
  let out: string;
  let temp: string;
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(out, { recursive: true, force: true });
    rmSync(temp, { recursive: true, force: true });
  });

  // The real pipeline: base-tree extract, one Vite server per side, a browser and clean-up.
  it('screenshots a component at the base and in the working tree, then leaves nothing behind', async () => {
    out = mkdtempSync(join(tmpdir(), 'component-shot-test-'));
    // Its own temp dir, so a run from a parallel session cannot change what is left behind.
    temp = mkdtempSync(join(tmpdir(), 'component-shot-tmp-'));
    vi.stubEnv('TMPDIR', temp);

    const code = await main([
      'src/renderer/components/ui/label.tsx',
      'Label',
      '--props',
      '{"children":"Worktree location"}',
      '--base',
      'HEAD',
      '--width',
      '320',
      '--scale',
      '1',
      '--out',
      out,
    ]);

    expect(code).toBe(0);
    for (const png of ['before.png', 'after.png']) {
      expect(readFileSync(join(out, png)).subarray(0, 4)).toEqual(PNG_SIGNATURE);
    }
    expect(readdirSync(temp).filter((name) => name.startsWith('frink-component-shot-'))).toEqual(
      [],
    );
    expect(existsSync(join(process.cwd(), 'node_modules', 'react'))).toBe(true);
  }, 180_000);
});
