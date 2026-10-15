import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { passthroughDeps } from './accounts';

describe('passthroughDeps.locateAgent', () => {
  let bin = '';
  beforeEach(async () => {
    bin = await mkdtemp(path.join(os.tmpdir(), 'locate agent '));
  });
  afterEach(() => rm(bin, { recursive: true, force: true }));

  it('finds each installed agent with its own lookup', async () => {
    await writeFile(path.join(bin, 'copilot'), '#!/bin/sh\n', { mode: 0o755 });
    await writeFile(path.join(bin, 'opencode'), '#!/bin/sh\n', { mode: 0o755 });
    const env = { PATH: bin, HOME: bin };

    await expect(passthroughDeps.locateAgent('copilot', env)).resolves.toBe(
      path.join(bin, 'copilot'),
    );
    await expect(passthroughDeps.locateAgent('opencode', env)).resolves.toBe(
      path.join(bin, 'opencode'),
    );
  });

  it("finds Cursor's SDK where Frink keeps it, without starting it", async () => {
    await expect(passthroughDeps.locateAgent('cursor')).resolves.toMatch(
      /@cursor\/sdk\/dist\/esm\/index\.js$/,
    );
  });
});
