import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import type { JsonValue } from '../../../../../../shared/types/permissions';
import { stageRegistrationPackage } from '../package-registration';

const temporaryDirectories: string[] = [];
const execFileAsync = promisify(execFile);

async function createPackage(
  manifest: JsonValue,
  entrypoint = 'console.log(JSON.stringify({ ok: true }));',
): Promise<{ packageRoot: string; projectRoot: string; stagingRoot: string }> {
  const projectRoot = await mkdtemp(join(tmpdir(), 'frink-register-package-'));
  temporaryDirectories.push(projectRoot);
  const packageRoot = join(projectRoot, 'folder-name-does-not-matter');
  const stagingRoot = join(projectRoot, 'staging');
  await mkdir(packageRoot);
  await mkdir(stagingRoot);
  await writeFile(join(packageRoot, 'manifest.json'), JSON.stringify(manifest));
  await writeFile(join(packageRoot, 'index.js'), entrypoint);
  return { packageRoot, projectRoot, stagingRoot };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('folder-authored registration package', () => {
  it('derives identity and source from the securely captured manifest', async () => {
    const context = await createPackage({
      name: 'manifest-identity',
      displayName: 'Manifest Identity',
      entrypoint: 'index.js',
    });
    await writeFile(join(context.packageRoot, 'cinder.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const result = await stageRegistrationPackage({
      packagePath: 'folder-name-does-not-matter',
      projectRoot: context.projectRoot,
      stagingRoot: context.stagingRoot,
    });

    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        manifest: expect.objectContaining({ name: 'manifest-identity' }),
        snapshot: expect.objectContaining({ resourcePaths: ['cinder.png'] }),
      }),
    );
  });

  it('accepts and validates every local JavaScript module', async () => {
    const context = await createPackage(
      { name: 'multi-file', entrypoint: 'index.js' },
      "import { value } from './helper.js'; console.log(JSON.stringify({ value }));",
    );
    await writeFile(join(context.packageRoot, 'helper.js'), 'export const value = 42;\n');

    const result = await stageRegistrationPackage({
      packagePath: 'folder-name-does-not-matter',
      projectRoot: context.projectRoot,
      stagingRoot: context.stagingRoot,
    });

    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        snapshot: expect.objectContaining({
          modules: [
            expect.objectContaining({ path: 'helper.js', source: 'export const value = 42;\n' }),
          ],
          resourcePaths: ['helper.js'],
        }),
      }),
    );
  });

  it('runs copied local modules and colocated binary resources as standard ESM', async () => {
    const context = await createPackage(
      { name: 'colocated-resource', entrypoint: 'index.js' },
      [
        "import { readFile } from 'node:fs/promises';",
        "import { resource } from './helper.js';",
        "const image = await readFile(new URL('./cinder.png', import.meta.url));",
        'console.log(JSON.stringify({ resource, bytes: image.byteLength }));',
      ].join('\n'),
    );
    await writeFile(
      join(context.packageRoot, 'helper.js'),
      "export const resource = 'cinder.png';\n",
    );
    await writeFile(join(context.packageRoot, 'cinder.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const result = await stageRegistrationPackage({
      packagePath: 'folder-name-does-not-matter',
      projectRoot: context.projectRoot,
      stagingRoot: context.stagingRoot,
    });
    expect(result.ok).toBe(true);
    await writeFile(join(context.stagingRoot, 'package.json'), '{"type":"module"}\n');

    const execution = await execFileAsync(process.execPath, [
      join(context.stagingRoot, 'index.js'),
    ]);
    expect(JSON.parse(execution.stdout)).toEqual({ resource: 'cinder.png', bytes: 4 });
  });

  it('rejects malformed sibling modules before consent or execution', async () => {
    const context = await createPackage({ name: 'invalid-module', entrypoint: 'index.js' });
    await writeFile(join(context.packageRoot, 'unused.mjs'), 'export const = ;');

    await expect(
      stageRegistrationPackage({
        packagePath: 'folder-name-does-not-matter',
        projectRoot: context.projectRoot,
        stagingRoot: context.stagingRoot,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.stringContaining('unused.mjs'),
      }),
    );
  });

  it('rejects malformed and oversized manifests before package capture', async () => {
    const malformed = await createPackage({
      name: 'node',
      entrypoint: 'index.js',
    });
    await writeFile(join(malformed.packageRoot, 'manifest.json'), '{');
    await expect(
      stageRegistrationPackage({
        packagePath: 'folder-name-does-not-matter',
        projectRoot: malformed.projectRoot,
        stagingRoot: malformed.stagingRoot,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.stringContaining('valid JSON'),
      }),
    );

    const oversized = await createPackage({
      name: 'node',
      entrypoint: 'index.js',
    });
    await writeFile(
      join(oversized.packageRoot, 'manifest.json'),
      Buffer.alloc(100 * 1024 + 1, 0x20),
    );
    await expect(
      stageRegistrationPackage({
        packagePath: 'folder-name-does-not-matter',
        projectRoot: oversized.projectRoot,
        stagingRoot: oversized.stagingRoot,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.stringContaining('100 KiB'),
      }),
    );
  });

  it('rejects a symlink manifest without following it', async () => {
    const context = await createPackage({
      name: 'node',
      entrypoint: 'index.js',
    });
    const external = join(context.projectRoot, 'external.json');
    await writeFile(external, JSON.stringify({ name: 'external', entrypoint: 'index.js' }));
    await rm(join(context.packageRoot, 'manifest.json'));
    await symlink(external, join(context.packageRoot, 'manifest.json'));

    await expect(
      stageRegistrationPackage({
        packagePath: 'folder-name-does-not-matter',
        projectRoot: context.projectRoot,
        stagingRoot: context.stagingRoot,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.stringContaining('symbolic link'),
      }),
    );
  });

  it('rejects entrypoint whitespace instead of installing a differently resolved filename', async () => {
    const context = await createPackage({
      name: 'node',
      entrypoint: ' index.js ',
    });

    await expect(
      stageRegistrationPackage({
        packagePath: 'folder-name-does-not-matter',
        projectRoot: context.projectRoot,
        stagingRoot: context.stagingRoot,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.stringContaining('leading or trailing whitespace'),
      }),
    );
  });
});
