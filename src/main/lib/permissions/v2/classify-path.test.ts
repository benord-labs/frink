import * as nodeFs from 'node:fs';
import * as nodeOs from 'node:os';
import * as nodePath from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { classifyPath } from './classify-path';

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) nodeFs.rmSync(dir, { recursive: true, force: true });
  }
});

function mkTempProject(): string {
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'classify-path-'));
  tempRoots.push(dir);
  return nodeFs.realpathSync.native(dir);
}

describe('classifyPath', () => {
  it('returns "in-current-project" for a path inside the project root', () => {
    const root = mkTempProject();
    const file = nodePath.join(root, 'src', 'a.ts');
    nodeFs.mkdirSync(nodePath.dirname(file), { recursive: true });
    nodeFs.writeFileSync(file, '');
    expect(classifyPath(file, root)).toBe('in-current-project');
  });

  it('returns "outside" for a path outside the project root', () => {
    const root = mkTempProject();
    const sibling = mkTempProject();
    const file = nodePath.join(sibling, 'foo.ts');
    nodeFs.writeFileSync(file, '');
    expect(classifyPath(file, root)).toBe('outside');
  });

  it('returns "outside" when projectRoot is empty', () => {
    expect(classifyPath('/some/path.ts', '')).toBe('outside');
  });

  it('classifies symlink-in-resolving-out as "outside" (realpath traversal)', () => {
    const root = mkTempProject();
    const external = mkTempProject();
    const externalFile = nodePath.join(external, 'secret.txt');
    nodeFs.writeFileSync(externalFile, '');
    const link = nodePath.join(root, 'link-to-external');
    nodeFs.symlinkSync(externalFile, link);
    expect(classifyPath(link, root)).toBe('outside');
  });

  it('classifies symlink-out-resolving-in as "in-current-project" (realpath traversal)', () => {
    const root = mkTempProject();
    const realFile = nodePath.join(root, 'real.ts');
    nodeFs.writeFileSync(realFile, '');
    const externalParent = mkTempProject();
    const link = nodePath.join(externalParent, 'link-into-project');
    nodeFs.symlinkSync(realFile, link);
    expect(classifyPath(link, root)).toBe('in-current-project');
  });

  it('falls back gracefully when file does not exist (ENOENT) — relies on lexical containment', () => {
    const root = mkTempProject();
    const nonexistent = nodePath.join(root, 'does', 'not', 'exist.ts');
    expect(classifyPath(nonexistent, root)).toBe('in-current-project');
  });

  it('classifies project-root itself as "in-current-project"', () => {
    const root = mkTempProject();
    expect(classifyPath(root, root)).toBe('in-current-project');
  });

  it('handles relative path inputs (resolved against projectRoot)', () => {
    const root = mkTempProject();
    nodeFs.writeFileSync(nodePath.join(root, 'x.ts'), '');
    expect(classifyPath('x.ts', root)).toBe('in-current-project');
  });
});
