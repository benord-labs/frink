import { describe, expect, it } from 'vitest';
import type { OpenFile } from '@/lib/code-editor/state';
import { arrangeTabsByProject, groupFilesByProject } from './group-files-by-project';

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

describe('arrangeTabsByProject', () => {
  it('draws the tabs of one project in one row, in the order they were opened', () => {
    const files = [file('src/b.ts', '/work/api'), file('src/a.ts', '/work/api')];

    expect(arrangeTabsByProject(files)).toEqual({ groups: null, order: files });
  });

  // Opened a.ts from web, then x.ts from api, then b.ts from web: the bar reads [web a b][api x].
  it('groups the tabs of two projects, and cycles through them in the order the bar draws', () => {
    const [a, x, b] = [
      file('src/a.ts', '/work/web'),
      file('src/x.ts', '/work/api'),
      file('src/b.ts', '/work/web'),
    ];

    const { groups, order } = arrangeTabsByProject([a, x, b]);

    expect(groups?.map((group) => [group.projectName, group.files])).toEqual([
      ['web', [a, b]],
      ['api', [x]],
    ]);
    expect(order).toEqual([a, b, x]);
  });

  it('groups settings or flow tabs apart from a project', () => {
    const { groups } = arrangeTabsByProject([file('Settings'), file('src/a.ts', '/work/api')]);

    expect(groups?.map((group) => group.projectName)).toEqual(['Files', 'api']);
  });
});
