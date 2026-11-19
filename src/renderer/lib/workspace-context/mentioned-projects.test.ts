import { describe, expect, it } from 'vitest';
import { findMentionedProjectIds } from './mentioned-projects';

const projects = [
  { id: 'root', path: '/' },
  { id: 'group', path: 'virtual://folders/1' },
  { id: 'app', path: '/a/app' },
  { id: 'lib', path: '/a/app/packages/lib' },
  { id: 'site', path: '/code/My Sites/site/' },
  { id: 'win', path: 'C:\\Code\\Api' },
  { id: 'share', path: '\\\\server\\share\\proj' },
];

describe('findMentionedProjectIds', () => {
  it.each([
    ['a path in text', ['I changed /a/app/src/x.ts and ran the tests.'], ['app']],
    ['a tool input', [JSON.stringify({ file_path: '/a/app/src/x.ts' })], ['app']],
    ['the folder itself, ending a sentence', ['It lives in /a/app.'], ['app']],
    ['the folder itself, in a JSON string', [JSON.stringify({ path: '/a/app' })], ['app']],
    ['the folder itself, before a dash', ['The repo at /a/app—which builds'], ['app']],
    ['the folder itself, before a curly apostrophe', ['In /a/app’s folder'], ['app']],
    ['the folder itself, before a link anchor', ['See /a/app#readme'], ['app']],
    ['a folder with spaces in it', ['See /code/My Sites/site/index.html'], ['site']],
    ['a longer folder name', ['/a/app2/x.ts, /a/app.old/x.ts, /a/app-old and /a/apple'], []],
    ['a nested project, as only the deepest', ['/a/app/packages/lib/src/x.ts'], ['lib']],
    ['a longer name under a nested project', ['/a/app/packages/lib2/x.ts'], ['app']],
    ['both nested projects, each named', ['/a/app/packages/lib/x.ts, /a/app/x.ts'], ['app', 'lib']],
    [
      'a Windows path with escaped backslashes',
      [JSON.stringify({ p: 'C:\\code\\API\\a.ts' })],
      ['win'],
    ],
    ['a Windows path with single backslashes', ['Open C:\\Code\\Api\\a.ts'], ['win']],
    ['a network path', ['Open \\\\server\\share\\proj\\a.ts'], ['share']],
    [
      'a network path with escaped backslashes',
      [JSON.stringify({ p: '\\\\server\\share\\proj\\a.ts' })],
      ['share'],
    ],
    ['bare names', ['Compare app with site, lib and Api'], []],
    ['one project named many times, once', ['/a/app/x.ts', '/a/app/y.ts /a/app'], ['app']],
    ['a path outside every project, past the root and the virtual one', ['/tmp/x.ts'], []],
    ['no texts', [], []],
  ])('finds %s', (_, texts, expected) => {
    expect(findMentionedProjectIds(texts, projects)).toEqual(expected);
  });

  it('finds nothing without projects', () => {
    expect(findMentionedProjectIds(['/a/app/x.ts'], [])).toEqual([]);
  });
});
