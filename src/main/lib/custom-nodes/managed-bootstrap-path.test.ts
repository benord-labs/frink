import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';

const electronState = vi.hoisted(() => ({ appPath: '/mock/app', isPackaged: false }));

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return electronState.isPackaged;
    },
    getAppPath: () => electronState.appPath,
  },
}));

const { getManagedCustomNodeBootstrapPath, MANAGED_CUSTOM_NODE_BOOTSTRAP_RESOURCE } =
  await import('./managed-bootstrap-path');

const execFileAsync = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, '../../../../');
const bootstrapPath = join(repoRoot, 'resources', MANAGED_CUSTOM_NODE_BOOTSTRAP_RESOURCE);
const tempDirs: string[] = [];

afterEach(async () => {
  electronState.appPath = '/mock/app';
  electronState.isPackaged = false;
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('managed custom-node bootstrap', () => {
  it('resolves the development and packaged resource paths', () => {
    expect(getManagedCustomNodeBootstrapPath()).toBe(
      join('/mock/app', 'resources', 'custom-nodes', 'managed-bootstrap.mjs'),
    );

    electronState.isPackaged = true;
    const originalResourcesPath = process.resourcesPath;
    Object.defineProperty(process, 'resourcesPath', {
      configurable: true,
      value: '/mock/resources',
    });
    try {
      expect(getManagedCustomNodeBootstrapPath()).toBe(
        join('/mock/resources', 'custom-nodes', 'managed-bootstrap.mjs'),
      );
    } finally {
      Object.defineProperty(process, 'resourcesPath', {
        configurable: true,
        value: originalResourcesPath,
      });
    }
  });

  it('awaits the entrypoint, preserves argv, flushes output, and exits despite live handles', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'frink-managed-bootstrap-'));
    tempDirs.push(dir);
    const entrypoint = join(dir, 'run.mjs');
    await writeFile(
      entrypoint,
      `setInterval(() => {}, 1_000);
await new Promise((resolve) => setTimeout(resolve, 20));
console.log(JSON.stringify({ argv: process.argv.slice(1) }));
`,
      'utf8',
    );

    const payload = '{"repo":"owner/repo"}';
    const result = await execFileAsync(process.execPath, [bootstrapPath, entrypoint, payload], {
      timeout: 2_000,
    });

    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({ argv: [entrypoint, payload] });
  });

  it('is included in packaged extraResources', () => {
    const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
      build?: { extraResources?: Array<{ from?: string; to?: string }> };
    };
    expect(packageJson.build?.extraResources).toContainEqual({
      from: 'resources/custom-nodes/managed-bootstrap.mjs',
      to: 'custom-nodes/managed-bootstrap.mjs',
    });
  });
});
