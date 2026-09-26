import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scanHooksDirectory } from './hooks';

describe('scanHooksDirectory', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hooks-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('ignores shebang and uses meaningful comment description', async () => {
    const filePath = path.join(tmpDir, 'deploy.sh');
    await fs.writeFile(filePath, '#!/bin/bash\n# Deploys production service\necho "ok"\n');

    const hooks = await scanHooksDirectory(tmpDir, 'user');
    expect(hooks).toHaveLength(1);
    expect(hooks[0].description).toBe('Deploys production service');
  });

  it('uses first comment description when no shebang exists', async () => {
    const filePath = path.join(tmpDir, 'lint.sh');
    await fs.writeFile(filePath, '# Runs lint checks\nbun run lint\n');

    const hooks = await scanHooksDirectory(tmpDir, 'user');
    expect(hooks).toHaveLength(1);
    expect(hooks[0].description).toBe('Runs lint checks');
  });

  it('uses readable fallback for shebang-only scripts', async () => {
    const filePath = path.join(tmpDir, 'prepare.sh');
    await fs.writeFile(filePath, '#!/usr/bin/env bash\necho "prepare"\n');

    const hooks = await scanHooksDirectory(tmpDir, 'user');
    expect(hooks).toHaveLength(1);
    expect(hooks[0].description).toBe('Shell hook (prepare.sh)');
  });

  it('uses readable fallback when there are no comments', async () => {
    const filePath = path.join(tmpDir, 'sync.ts');
    await fs.writeFile(filePath, 'console.log("sync");\n');

    const hooks = await scanHooksDirectory(tmpDir, 'user');
    expect(hooks).toHaveLength(1);
    expect(hooks[0].description).toBe('TypeScript hook (sync.ts)');
  });
});
