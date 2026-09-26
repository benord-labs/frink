import { describe, expect, it } from 'vitest';
import type { OpenFile } from '@/lib/code-editor/state';
import { groupFilesByProject } from './group-files-by-project';

const file = (path: string, projectPath?: string): OpenFile => ({
  path,
  name: path.split('/').pop() ?? path,
  projectPath,
});

describe('groupFilesByProject', () => {
  it('returns an empty array for no files', () => {
    expect(groupFilesByProject([])).toEqual([]);
  });

  it('groups a single project under its folder name', () => {
    const groups = groupFilesByProject([
      file('/work/api/a.ts', '/work/api'),
      file('/work/api/b.ts', '/work/api'),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ projectPath: '/work/api', projectName: 'api' });
    expect(groups[0]?.files).toHaveLength(2);
  });

  it('groups multiple projects and preserves first-seen order', () => {
    const groups = groupFilesByProject([
      file('/work/web/a.ts', '/work/web'),
      file('/work/api/b.ts', '/work/api'),
      file('/work/web/c.ts', '/work/web'),
    ]);
    expect(groups.map((g) => g.projectName)).toEqual(['web', 'api']);
    expect(groups[0]?.files).toHaveLength(2); // web saw a.ts then c.ts
    expect(groups[1]?.files).toHaveLength(1);
  });

  it('collects files with no projectPath under a "Files" group with undefined path', () => {
    const groups = groupFilesByProject([
      file('/tmp/scratch.ts'),
      file('/work/api/a.ts', '/work/api'),
    ]);
    expect(groups[0]).toMatchObject({ projectPath: undefined, projectName: 'Files' });
    expect(groups[1]).toMatchObject({ projectName: 'api' });
  });
});
