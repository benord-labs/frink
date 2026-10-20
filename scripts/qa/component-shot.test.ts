import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { main } from './component-shot';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const runDirs = () =>
  readdirSync(tmpdir()).filter((name) => name.startsWith('frink-component-shot-'));

describe('component-shot', () => {
  let out: string;
  afterEach(() => rmSync(out, { recursive: true, force: true }));

  // The real pipeline: base-tree extract, one Vite server per side, a browser and clean-up.
  it('screenshots a component at the base and in the working tree, then leaves nothing behind', async () => {
    out = mkdtempSync(join(tmpdir(), 'component-shot-test-'));
    const before = runDirs();

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
    expect(runDirs()).toEqual(before);
    expect(existsSync(join(process.cwd(), 'node_modules', 'react'))).toBe(true);
  }, 180_000);
});
