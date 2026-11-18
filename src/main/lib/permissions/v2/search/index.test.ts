import * as nodeFs from 'node:fs';
import * as nodeOs from 'node:os';
import * as nodePath from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
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

  it.each(['**/*.{ts,tsx}', '*.{bak,~}', '**/.*', 'Notes (2024)/*.md', '**/x,/y'])(
    'keeps an in-project Glob pattern that stays in its root prompt-free: %s',
    (pattern) => {
      expect(checkSearch('Glob', { pattern }, EMPTY_DOCS, project)).toEqual({ decision: 'allow' });
    },
  );

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

  it.each([
    '/etc/**',
    '~/.config/**',
    '../**/*.ts',
    'src/../../*',
    '{src,..}/*',
    '{src,/etc}/*',
    '.{.,x}/*',
    '{,.}./*',
    '@(src|/etc)/*',
    '(src|..)/*',
  ])('asks for a Glob pattern that escapes its root: %s', (pattern) => {
    expect(checkSearch('Glob', { pattern }, EMPTY_DOCS, project).decision).toBe('ask');
  });

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

  it('treats a general chat like any project: its home root is the project', () => {
    const home = nodeOs.homedir();
    const sub = nodePath.join(home, 'frink-search-test-not-created');
    expect(checkSearch('Grep', { pattern: 'x', path: sub }, EMPTY_DOCS, home)).toEqual({
      decision: 'allow',
    });
  });

  it('asks for a search whose folder contains a protected folder, in any chat', () => {
    const home = nodeOs.homedir();
    expect(checkSearch('Grep', { pattern: 'PRIVATE KEY' }, EMPTY_DOCS, home).decision).toBe('ask');
    expect(checkSearch('Glob', { pattern: '**/id_*' }, EMPTY_DOCS, home).decision).toBe('ask');
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

describe("checkSearch — the chat's own attachments folder", () => {
  let tmp: string;
  let session: string;
  beforeAll(() => {
    tmp = nodeFs.realpathSync(nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'search-s-')));
    session = nodePath.join(tmp, 'chat-1');
    nodeFs.mkdirSync(nodePath.join(session, 'pasted'), { recursive: true });
    nodeFs.mkdirSync(nodePath.join(tmp, 'chat-2', 'pasted'), { recursive: true });
  });
  afterAll(() => nodeFs.rmSync(tmp, { recursive: true, force: true }));

  it('allows Grep and Glob rooted in pasted/ without a prompt', () => {
    const pasted = nodePath.join(session, 'pasted');
    expect(
      checkSearch('Grep', { pattern: 'x', path: pasted }, EMPTY_DOCS, project, session),
    ).toEqual({ decision: 'allow' });
    expect(
      checkSearch('Glob', { pattern: '**/*.pdf', path: pasted }, EMPTY_DOCS, project, session),
    ).toEqual({ decision: 'allow' });
  });

  it("asks for another chat's folder, the session folder itself, or an escaping pattern", () => {
    const pasted = nodePath.join(session, 'pasted');
    const ask = (tool: 'Glob' | 'Grep', input: { pattern: string; path: string }) =>
      checkSearch(tool, input, EMPTY_DOCS, project, session).decision;
    expect(ask('Grep', { pattern: 'x', path: nodePath.join(tmp, 'chat-2', 'pasted') })).toBe('ask');
    expect(ask('Grep', { pattern: 'x', path: session })).toBe('ask');
    expect(ask('Glob', { pattern: '../**', path: pasted })).toBe('ask');
    expect(checkSearch('Grep', { pattern: 'x', path: pasted }, EMPTY_DOCS, project).decision).toBe(
      'ask',
    );
  });

  it('judges the path as written: .. after a link, or a rooted Glob brace, asks', () => {
    const chat = nodePath.join(tmp, 'chat-3');
    const pasted = nodePath.join(chat, 'pasted');
    nodeFs.mkdirSync(nodePath.join(pasted, 'c'), { recursive: true });
    nodeFs.mkdirSync(nodePath.join(tmp, 'o', 'sub'), { recursive: true });
    nodeFs.mkdirSync(nodePath.join(tmp, 'o', 'c'));
    nodeFs.symlinkSync(nodePath.join(tmp, 'o', 'sub'), nodePath.join(pasted, 'dl'));
    const decide = (tool: 'Glob' | 'Grep', chatDir: string, pattern: string, path: string) =>
      checkSearch(tool, { pattern, path }, EMPTY_DOCS, project, chatDir).decision;
    expect(decide('Grep', chat, 'x', `${pasted}/dl/../c`)).toBe('ask');
    const own = nodePath.join(session, 'pasted');
    expect(decide('Glob', session, '{/etc/*,x}', own)).toBe('ask');
    expect(decide('Glob', session, '*.{pdf,txt}', own)).toBe('allow');
  });

  it("keeps a user's own Grep ask rule for pasted/", () => {
    const input = { pattern: 'x', path: nodePath.join(session, 'pasted') };
    const r = checkSearch('Grep', input, userDocs({ ask: ['Grep'] }), project, session);
    expect(r).toMatchObject({ decision: 'ask', prompt: { reason: 'rule:ask' } });
  });

  it('asks when a file under the searched folder has a second name or is a link', () => {
    const linked = nodePath.join(tmp, 'chat-1', 'pasted-linked');
    nodeFs.mkdirSync(nodePath.join(linked, 'pasted', 'sub'), { recursive: true });
    const outside = nodePath.join(tmp, 'outside.txt');
    nodeFs.writeFileSync(outside, 'secret');
    nodeFs.linkSync(outside, nodePath.join(linked, 'pasted', 'sub', 'hard'));
    const pasted = nodePath.join(linked, 'pasted');
    const grep = (path: string) =>
      checkSearch('Grep', { pattern: 'x', path }, EMPTY_DOCS, project, linked).decision;
    expect(grep(pasted)).toBe('ask');
    expect(grep(nodePath.join(pasted, 'sub', 'hard'))).toBe('ask');
    nodeFs.rmSync(nodePath.join(pasted, 'sub', 'hard'));
    nodeFs.symlinkSync(outside, nodePath.join(pasted, 'sub', 'link'));
    expect(grep(pasted)).toBe('ask');
    nodeFs.symlinkSync(tmp, nodePath.join(pasted, 'dl'));
    expect(grep(nodePath.join(pasted, 'dl', '..'))).toBe('ask');
  });
});

describe('checkSearch — case variants of protected roots', () => {
  const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const withPlatform = (value: NodeJS.Platform): void => {
    Object.defineProperty(process, 'platform', { value, configurable: true });
  };
  afterEach(() => {
    Object.defineProperty(process, 'platform', realPlatform);
  });

  it('darwin: Grep of ~/.SSH is denied (APFS aliases it to ~/.ssh)', () => {
    withPlatform('darwin');
    const r = checkSearch('Grep', { pattern: 'x', path: '~/.SSH' }, EMPTY_DOCS, project);
    expect(r).toMatchObject({ decision: 'deny', reason: { kind: 'safety:path' } });
  });

  it('linux: ~/.SSH is a distinct folder, so no safety deny', () => {
    withPlatform('linux');
    const r = checkSearch('Grep', { pattern: 'x', path: '~/.SSH' }, EMPTY_DOCS, project);
    expect(r).not.toMatchObject({ reason: { kind: 'safety:path' } });
  });
});
