import * as nodeFs from 'node:fs';
import * as nodeOs from 'node:os';
import * as nodePath from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EMPTY_DOCS, type ScopedDocs } from '../eval-rules';
import type { PermissionsDoc } from '../types';
import { checkSearch, searchRoot } from './index';

const none: PermissionsDoc = { allow: [], deny: [], ask: [] };
const userDocs = (doc: Partial<PermissionsDoc>): ScopedDocs => ({
  policy: none,
  project: none,
  user: { ...none, ...doc },
});

let project: string;
beforeAll(() => {
  project = nodeFs.realpathSync(nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'search-')));
  nodeFs.mkdirSync(nodePath.join(project, 'src'));
});
afterAll(() => nodeFs.rmSync(project, { recursive: true, force: true }));

describe('searchRoot', () => {
  it('defaults to the project root and resolves relative and ~ paths', () => {
    expect(searchRoot({}, project)).toBe(project);
    expect(searchRoot({ path: 'src' }, project)).toBe(nodePath.join(project, 'src'));
    expect(searchRoot({ path: '~/.ssh' }, project)).toBe(nodePath.join(nodeOs.homedir(), '.ssh'));
  });
});

describe('checkSearch', () => {
  it('allows in-project searches without a prompt', () => {
    expect(checkSearch('Grep', { pattern: 'foo' }, EMPTY_DOCS, project)).toEqual({
      decision: 'allow',
    });
    expect(checkSearch('Glob', { pattern: '**/*.ts', path: 'src' }, EMPTY_DOCS, project)).toEqual({
      decision: 'allow',
    });
  });

  it('denies a protected folder, as Read does', () => {
    const r = checkSearch('Grep', { pattern: 'PRIVATE KEY', path: '~/.ssh' }, EMPTY_DOCS, project);
    expect(r).toMatchObject({ decision: 'deny', reason: { kind: 'safety:path' } });
  });

  it('asks for a folder outside the project, offering a tool-wide rule', () => {
    const r = checkSearch('Grep', { pattern: 'x', path: '/etc' }, EMPTY_DOCS, project);
    expect(r).toMatchObject({
      decision: 'ask',
      prompt: { tool: 'Grep', suggestedRules: ['Grep'] },
    });
  });

  it('asks for a parent-relative path that leaves the project', () => {
    const r = checkSearch('Grep', { pattern: 'x', path: '..' }, EMPTY_DOCS, project);
    expect(r.decision).toBe('ask');
  });

  it.each(['/etc/**', '~/.config/**', '../**/*.ts', 'src/../../*', '{src,..}/*'])(
    'asks for a Glob pattern that escapes its root: %s',
    (pattern) => {
      expect(checkSearch('Glob', { pattern }, EMPTY_DOCS, project).decision).toBe('ask');
    },
  );

  it('keeps an in-project Glob pattern with dots in names prompt-free', () => {
    const r = checkSearch('Glob', { pattern: 'src/**/*.test..ts' }, EMPTY_DOCS, project);
    expect(r).toEqual({ decision: 'allow' });
  });

  it('asks when a symlink inside the project points outside it', () => {
    const link = nodePath.join(project, 'escape');
    nodeFs.symlinkSync(nodeOs.tmpdir(), link);
    expect(
      checkSearch('Grep', { pattern: 'x', path: 'escape' }, EMPTY_DOCS, project).decision,
    ).toBe('ask');
  });

  it('asks in a general chat, whose project root is the home folder', () => {
    const r = checkSearch('Grep', { pattern: 'x' }, EMPTY_DOCS, nodeOs.homedir());
    expect(r.decision).toBe('ask');
  });

  it('honours a deny rule even inside the project', () => {
    const r = checkSearch('Grep', { pattern: 'x' }, userDocs({ deny: ['Grep'] }), project);
    expect(r).toMatchObject({ decision: 'deny', reason: { kind: 'rule:deny', rule: 'Grep' } });
  });

  it('lets an allow rule grant outside searches', () => {
    const r = checkSearch(
      'Grep',
      { pattern: 'x', path: '/etc' },
      userDocs({ allow: ['Grep'] }),
      project,
    );
    expect(r).toEqual({ decision: 'allow' });
  });
});
