import { describe, expect, it } from 'vitest';
import type { FileMentionOption } from './agents-mentions-types';
import {
  followSelection,
  groupMentionOptionsByProject,
  linkedMentionGroups,
  linkedMentionOption,
} from './group-mention-options-by-project';

const ROS = { path: '/w/ros-service', name: 'ros-service' };
const entry = (path: string, type: 'file' | 'folder' = 'file') => ({
  label: path.split('/').pop() ?? path,
  path,
  type,
});
const mainOption = (path: string): FileMentionOption => ({
  id: `file:local:${path}`,
  label: entry(path).label,
  path,
  repository: 'local',
});
const skill = (name: string): FileMentionOption => ({
  id: `skill:${name}`,
  label: name,
  path: '',
  repository: '',
  type: 'skill',
});
const main = (...options: Array<string | FileMentionOption>) => ({
  path: '/w/owners-web',
  name: 'owners-web',
  options: options.map((each) => (typeof each === 'string' ? mainOption(each) : each)),
});
const linked = (root: string, ...paths: string[]) => {
  const project = { path: root, name: root.split('/').pop() ?? root };
  return { ...project, options: paths.map((path) => linkedMentionOption(project, entry(path))) };
};
type Sections = ReturnType<typeof groupMentionOptionsByProject>['sections'];
/** Each section by its title (`Results` for the usual header), then its options' indices */
const outline = (sections: Sections) =>
  sections.flatMap((section) => [
    section.linked ? `${section.name} · linked` : (section.name ?? 'Results'),
    ...section.rows.map((row) => row.index),
  ]);

describe('linkedMentionOption', () => {
  it('names a file by its full path and shows its folder inside the project', () => {
    expect(linkedMentionOption(ROS, entry('src/a.ts'))).toEqual({
      id: 'file:local:/w/ros-service/src/a.ts',
      label: 'a.ts',
      path: '/w/ros-service/src/a.ts',
      repository: 'local',
      truncatedPath: 'src',
      treePath: 'ros-service/src/a.ts',
      project: 'ros-service',
      type: 'file',
    });
    expect(linkedMentionOption(ROS, entry('docs/api', 'folder'))).toMatchObject({
      id: 'folder:local:/w/ros-service/docs/api',
      truncatedPath: 'docs',
      treePath: 'ros-service/docs/api',
    });
  });
});

describe('linkedMentionGroups', () => {
  const roots = [{ path: '/w/Personal and learning/web', name: 'web' }, ROS];
  const results = [
    [entry('src/lib/app.test.ts'), entry('src/app.ts'), entry('docs/learning.md')],
    undefined,
  ];

  it('keeps the results holding every word, best match first, and a project still loading empty', () => {
    const groups = linkedMentionGroups(roots, results, 'app ts');

    expect(
      groups.map(({ name, options }) => [name, options.map((option) => option.label)]),
    ).toEqual([
      ['web', ['app.ts', 'app.test.ts']],
      ['ros-service', []],
    ]);
  });

  it('matches inside the project, so a word only in the folders above it matches nothing', () => {
    expect(linkedMentionGroups(roots, results, 'personal')[0]?.options).toEqual([]);
  });
});

describe('groupMentionOptionsByProject', () => {
  it('leaves the list as it is, under the usual header, when the chat links nothing', () => {
    const { sections, options, keys } = groupMentionOptionsByProject(
      main(skill('review'), 'a.ts'),
      [],
    );
    expect(outline(sections)).toEqual(['Results', 0, 1]);
    expect(options.map((option) => option.id)).toEqual(['skill:review', 'file:local:a.ts']);
    expect(keys).toHaveLength(2);
  });

  it('puts the chat’s own project first, then each linked one in link order', () => {
    const { sections, options } = groupMentionOptionsByProject(main('app.ts'), [
      linked(ROS.path, 'src/app.ts', 'lib/app.ts'),
      linked('/w/billing', 'app.ts'),
    ]);
    expect(outline(sections)).toEqual([
      'owners-web',
      0,
      'ros-service · linked',
      1,
      2,
      'billing · linked',
      3,
    ]);
    expect(options.map((option) => option.path)).toEqual([
      'app.ts',
      '/w/ros-service/src/app.ts',
      '/w/ros-service/lib/app.ts',
      '/w/billing/app.ts',
    ]);
  });

  it('keeps skills, agents, tools and categories under the usual header, above the projects', () => {
    const category: FileMentionOption = { ...skill('Files'), id: 'files', type: 'category' };
    const { sections, options } = groupMentionOptionsByProject(
      main('app.ts', skill('apply'), category),
      [linked(ROS.path, 'app.ts')],
    );
    expect(outline(sections)).toEqual([
      'Results',
      0,
      1,
      'owners-web',
      2,
      'ros-service · linked',
      3,
    ]);
    expect(options.map((option) => option.id)).toEqual([
      'skill:apply',
      'files',
      'file:local:app.ts',
      'file:local:/w/ros-service/app.ts',
    ]);
  });

  it('drops a project with no results, the chat’s own included', () => {
    const { sections } = groupMentionOptionsByProject(main(), [
      linked(ROS.path),
      linked('/w/billing', 'app.ts'),
    ]);
    expect(outline(sections)).toEqual(['billing · linked', 0]);
  });

  it('keeps one relative path in two projects apart, and a file under two nested links', () => {
    const { sections, options, keys } = groupMentionOptionsByProject(main('src/a.ts'), [
      linked(ROS.path, 'src/a.ts'),
      linked(`${ROS.path}/src`, 'a.ts'),
    ]);
    expect(options.map((option) => option.id)).toEqual([
      'file:local:src/a.ts',
      'file:local:/w/ros-service/src/a.ts',
      'file:local:/w/ros-service/src/a.ts',
    ]);
    expect(new Set(keys).size).toBe(keys.length);
    expect(sections.flatMap((section) => section.rows.map((row) => row.key))).toEqual(keys);
  });
});

describe('followSelection', () => {
  it('stays on the selected row when results land above it', () => {
    expect(followSelection(['ros:a', 'ros:b'], ['main:x', 'main:y', 'ros:a', 'ros:b'], 1)).toBe(3);
  });

  it('keeps the same place, inside the list, once the selected row is gone', () => {
    expect(followSelection(['a', 'b', 'c'], ['a', 'c'], 1)).toBe(1);
    expect(followSelection(['a', 'b', 'c'], ['a'], 2)).toBe(0);
  });

  it('leaves the selection as it was while the list is empty', () => {
    expect(followSelection(['a', 'b'], [], 1)).toBe(1);
    expect(followSelection([], ['a', 'b'], 1)).toBe(1);
  });
});
