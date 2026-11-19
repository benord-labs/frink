import { describe, expect, it } from 'vitest';
import {
  asEntryOfParent,
  findProjectForPath,
  isRealProjectPath,
  pathsOverlap,
} from './project-paths';

const projects = [
  { id: 'root', path: '/' },
  { id: 'group', path: 'virtual://folders/1' },
  { id: 'work', path: '/w/' },
  { id: 'app', path: '/w/app' },
  { id: 'lib', path: '/w/app/packages/lib' },
  { id: 'win', path: 'C:\\Code\\Api' },
];

describe('findProjectForPath', () => {
  it.each([
    ['/w/app/packages/lib/a.ts', 'lib'],
    ['/w/app/src/a.ts', 'app'],
    ['/w/app', 'app'],
    ['/w/app/', 'app'],
    ['/w/app-api/x.ts', 'work'],
    ['c:/code/api/src/a.ts', 'win'],
  ])('finds %s in project %s', (file, id) => {
    expect(findProjectForPath(file, projects)?.id).toBe(id);
  });

  it.each([
    ['a path outside every project, past the root and the virtual one', '/tmp/a.ts', projects],
    ['a relative path', 'w/app/a.ts', projects],
    ['an empty registry', '/w/app/a.ts', []],
  ])('finds nothing for %s', (_, file, registry) => {
    expect(findProjectForPath(file, registry)).toBeNull();
  });
});

describe('isRealProjectPath', () => {
  it.each([
    ['/w/app', true],
    ['virtual://folders/1', false],
    ['', false],
    [null, false],
  ])('takes %j for a folder on disk: %s', (projectPath, real) => {
    expect(isRealProjectPath(projectPath)).toBe(real);
  });
});

describe('pathsOverlap', () => {
  it.each([
    ['/w/app', '/w/app/', true],
    ['/w/app/src', '/w/app', true],
    ['/w/app', '/w/app/src', true],
    ['/w/app', '/w/app-api', false],
    ['C:\\Code', 'c:/code/api', true],
  ])('%s and %s overlap: %s', (a, b, overlap) => {
    expect(pathsOverlap(a, b)).toBe(overlap);
  });
});

describe('asEntryOfParent', () => {
  it.each([
    ['/w/api', { projectPath: '/w/', relativePath: 'api' }],
    ['/w/api/', { projectPath: '/w/', relativePath: 'api' }],
    ['C:\\Code\\Api', { projectPath: 'C:/Code/', relativePath: 'Api' }],
  ])('reads %s as an entry of the folder that holds it', (folder, entry) => {
    expect(asEntryOfParent(folder)).toEqual(entry);
  });
});
