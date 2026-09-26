import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { expectedPackageState, hashBytes } from './expected-package-state';
import { readInstalledPackageState } from './installed-package-state';

describe('expectedPackageState', () => {
  it('derives generated and source file state without reading a candidate directory', () => {
    const entrypointBytes = Buffer.from('console.log("ok")');
    const manifestBytes = Buffer.from('{"name":"fixture"}');
    const packageJsonBytes = Buffer.from('{"type":"module"}');
    const moduleBytes = Buffer.from('export const value = 42;');
    const resourceBytes = Buffer.from([0, 1, 2, 3]);

    const result = expectedPackageState({
      entrypoint: 'index.js',
      manifestBytes,
      packageJsonBytes,
      snapshot: {
        digest: 'source-digest',
        entrypointBytes,
        manifestBytes: Buffer.from('{}'),
        modules: [
          {
            path: 'lib/helper.js',
            bytes: moduleBytes.byteLength,
            hash: hashBytes(moduleBytes),
            source: moduleBytes.toString('utf8'),
          },
        ],
        resources: [
          { path: 'assets/cinder.png', bytes: 4, hash: hashBytes(resourceBytes) },
          { path: 'assets.txt', bytes: 4, hash: hashBytes(resourceBytes) },
        ],
        resourcePaths: ['assets/cinder.png', 'assets.txt'],
        sourceManifest: {},
        totalBytes: 20,
      },
    });

    expect(result.files).toEqual([
      { path: 'assets/cinder.png', bytes: 4, hash: hashBytes(resourceBytes) },
      { path: 'assets.txt', bytes: 4, hash: hashBytes(resourceBytes) },
      { path: 'index.js', bytes: entrypointBytes.byteLength, hash: hashBytes(entrypointBytes) },
      { path: 'lib/helper.js', bytes: moduleBytes.byteLength, hash: hashBytes(moduleBytes) },
      { path: 'manifest.json', bytes: manifestBytes.byteLength, hash: hashBytes(manifestBytes) },
      {
        path: 'package.json',
        bytes: packageJsonBytes.byteLength,
        hash: hashBytes(packageJsonBytes),
      },
    ]);
    expect(result.digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('matches the state rehashed from the installed directory traversal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'frink-expected-package-'));
    const entrypointBytes = Buffer.from('console.log("ok")');
    const manifestBytes = Buffer.from('{"name":"fixture"}');
    const packageJsonBytes = Buffer.from('{"type":"module"}');
    const moduleBytes = Buffer.from('export const value = 42;');
    const resourceBytes = Buffer.from([0, 1, 2, 3]);
    const snapshot = {
      digest: 'source-digest',
      entrypointBytes,
      manifestBytes: Buffer.from('{}'),
      modules: [
        {
          path: 'lib/helper.js',
          bytes: moduleBytes.byteLength,
          hash: hashBytes(moduleBytes),
          source: moduleBytes.toString('utf8'),
        },
      ],
      resources: [
        { path: 'assets/cinder.png', bytes: 4, hash: hashBytes(resourceBytes) },
        { path: 'assets.txt', bytes: 4, hash: hashBytes(resourceBytes) },
      ],
      resourcePaths: ['assets/cinder.png', 'assets.txt'],
      sourceManifest: {},
      totalBytes: 20,
    };
    try {
      await mkdir(join(root, 'assets'));
      await mkdir(join(root, 'lib'));
      await Promise.all([
        writeFile(join(root, 'index.js'), entrypointBytes),
        writeFile(join(root, 'manifest.json'), manifestBytes),
        writeFile(join(root, 'package.json'), packageJsonBytes),
        writeFile(join(root, 'lib', 'helper.js'), moduleBytes),
        writeFile(join(root, 'assets', 'cinder.png'), resourceBytes),
        writeFile(join(root, 'assets.txt'), resourceBytes),
      ]);

      expect(await readInstalledPackageState(root)).toEqual(
        expectedPackageState({
          entrypoint: 'index.js',
          manifestBytes,
          packageJsonBytes,
          snapshot,
        }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
