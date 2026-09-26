import { describe, expect, it } from 'vitest';
import { buildFileTree } from './build-file-tree';

describe('buildFileTree', () => {
  it('nests files under their parent folders', () => {
    const tree = buildFileTree([
      { path: 'src/index.ts', type: 'file' },
      { path: 'src/lib/util.ts', type: 'file' },
    ]);

    expect(tree).toEqual([
      expect.objectContaining({
        id: 'src',
        name: 'src',
        type: 'folder',
        children: expect.arrayContaining([
          expect.objectContaining({ id: 'src/index.ts', name: 'index.ts', type: 'file' }),
          expect.objectContaining({
            id: 'src/lib',
            name: 'lib',
            type: 'folder',
            children: [expect.objectContaining({ id: 'src/lib/util.ts', name: 'util.ts' })],
          }),
        ]),
      }),
    ]);
  });

  it('sorts folders before files, then alphabetically within each group', () => {
    const tree = buildFileTree([
      { path: 'zebra.ts', type: 'file' },
      { path: 'apple.ts', type: 'file' },
      { path: 'lib/nested.ts', type: 'file' },
    ]);

    expect(tree.map((node) => node.name)).toEqual(['lib', 'apple.ts', 'zebra.ts']);
  });

  it('carries gitStatus onto the leaf entry only', () => {
    const tree = buildFileTree([{ path: 'src/index.ts', type: 'file', gitStatus: 'modified' }]);

    const srcFolder = tree[0];
    expect(srcFolder.gitStatus).toBeUndefined();
    expect(srcFolder.children?.[0].gitStatus).toBe('modified');
  });

  it('propagates isGitIgnored from the matching entry, including intermediate folders', () => {
    const tree = buildFileTree([
      { path: 'node_modules', type: 'folder', isGitIgnored: true },
      { path: 'node_modules/pkg/index.js', type: 'file' },
    ]);

    const nodeModules = tree[0];
    expect(nodeModules.isGitIgnored).toBe(true);
  });

  it('returns an empty array for no entries', () => {
    expect(buildFileTree([])).toEqual([]);
  });
});
