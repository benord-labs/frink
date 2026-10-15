import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as cursor from '../agent-runner/cursor';
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

  it('finds Cursor through its SDK lookup, without starting it', async () => {
    const locate = vi.spyOn(cursor, 'locateCursorAgent').mockResolvedValue('/sdk/index.js');
    await expect(passthroughDeps.locateAgent('cursor')).resolves.toBe('/sdk/index.js');
    expect(locate).toHaveBeenCalledWith();
  });
});
