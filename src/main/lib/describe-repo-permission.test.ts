import * as nodeFs from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import * as nodeOs from 'node:os';
import * as nodePath from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { allowReadOnlyUnderProject } from './describe-repo-permission';
import { createTempDirRegistry, createTempProjectFile } from './test-utils/temp-project';

const registry = createTempDirRegistry();

afterEach(async () => {
  await registry.cleanup();
});

async function createTempProject(): Promise<{ root: string; filePath: string }> {
  const temp = await createTempProjectFile(registry, 'frink-desc-', 'README.md', '# test\n');
  await nodeFs.promises.mkdir(nodePath.join(temp.root, 'src'), { recursive: true });
  return temp;
}

describe('allowReadOnlyUnderProject', () => {
  it('allows Read/Glob/Grep for in-project paths', async () => {
    const { root } = await createTempProject();
    expect(allowReadOnlyUnderProject(root, 'Read', { file_path: './README.md' }).allowed).toBe(
      true,
    );
    expect(allowReadOnlyUnderProject(root, 'Glob', { path: './src' }).allowed).toBe(true);
    expect(allowReadOnlyUnderProject(root, 'Grep', { directory: './src' }).allowed).toBe(true);
  });

  it('rejects traversal outside project', async () => {
    const { root } = await createTempProject();
    const result = allowReadOnlyUnderProject(root, 'Read', { file_path: '../outside.md' });
    expect(result.allowed).toBe(false);
  });

  it.skipIf(process.platform === 'win32')(
    'rejects symlink inside project that points outside',
    async () => {
      const { root } = await createTempProject();
      const externalRoot = await mkdtemp(nodePath.join(nodeOs.tmpdir(), 'frink-desc-ext-'));
      registry.track(externalRoot);
      const externalFile = nodePath.join(externalRoot, 'secret.md');
      await writeFile(externalFile, 'secret\n', 'utf8');
      const linkedPath = nodePath.join(root, 'linked-secret.md');
      await nodeFs.promises.symlink(externalFile, linkedPath);

      const result = allowReadOnlyUnderProject(root, 'Read', { file_path: linkedPath });
      expect(result.allowed).toBe(false);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'accepts canonical absolute path under symlinked project root',
    async () => {
      const realRoot = await mkdtemp(nodePath.join(nodeOs.tmpdir(), 'frink-desc-real-'));
      registry.track(realRoot);
      const filePath = nodePath.join(realRoot, 'README.md');
      await writeFile(filePath, '# test\n', 'utf8');

      const linkParent = await mkdtemp(nodePath.join(nodeOs.tmpdir(), 'frink-desc-link-'));
      registry.track(linkParent);
      const linkRoot = nodePath.join(linkParent, 'project-link');
      await nodeFs.promises.symlink(realRoot, linkRoot);

      const result = allowReadOnlyUnderProject(linkRoot, 'Read', { file_path: filePath });
      expect(result.allowed).toBe(true);
    },
  );
});
