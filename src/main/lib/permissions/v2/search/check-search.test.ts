import * as nodeFs from 'node:fs';
import * as nodeOs from 'node:os';
import * as nodePath from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkSearch, type SearchContext } from './check-search';
import { EMPTY_DOCS, type ScopedDocs } from '../eval-rules';
import type { PermissionsDoc } from '../types';

const noRules: PermissionsDoc = { allow: [], deny: [], ask: [] };
const home = nodeOs.homedir();

let tmp: string;
let project: string;
let outside: string;

beforeAll(() => {
  // realpath: macOS tmpdir is a /var → /private/var symlink.
  tmp = nodeFs.realpathSync(nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'check-search-')));
  project = nodePath.join(tmp, 'project');
  outside = nodePath.join(tmp, 'outside');
  nodeFs.mkdirSync(nodePath.join(project, 'src'), { recursive: true });
  nodeFs.mkdirSync(nodePath.join(project, '.aws'), { recursive: true });
  nodeFs.mkdirSync(outside, { recursive: true });
  nodeFs.mkdirSync(nodePath.join(tmp, 'secret', '.ssh'), { recursive: true });
  nodeFs.symlinkSync(nodePath.join(tmp, 'secret', '.ssh'), nodePath.join(project, 'keys'));
  nodeFs.symlinkSync(outside, nodePath.join(project, 'escape'));
});

afterAll(() => {
  nodeFs.rmSync(tmp, { recursive: true, force: true });
});

const ctx = (overrides: Partial<SearchContext> = {}): SearchContext => ({
  projectId: 'p1',
  skillsDirRoots: [],
  ...overrides,
});

const docsWith = (scope: keyof ScopedDocs, doc: Partial<PermissionsDoc>): ScopedDocs => ({
  ...EMPTY_DOCS,
  [scope]: { ...noRules, ...doc },
});

describe('checkSearch — tier-1c on the search root', () => {
  it('denies Grep rooted at ~/.ssh (tilde form)', async () => {
    const r = await checkSearch(
      { pattern: 'PRIVATE KEY', path: '~/.ssh' },
      EMPTY_DOCS,
      project,
      'Grep',
      ctx(),
    );
    expect(r).toMatchObject({
      decision: 'deny',
      reason: { kind: 'safety:path', path: nodePath.join(home, '.ssh') },
    });
  });

  it('denies a bare project-local .aws dir root (dir-glob needs the child probe)', async () => {
    const r = await checkSearch(
      { pattern: 'secret', path: '.aws' },
      EMPTY_DOCS,
      project,
      'Grep',
      ctx(),
    );
    expect(r).toMatchObject({ decision: 'deny', reason: { kind: 'safety:path' } });
  });

  it('denies an in-project symlink whose target is a .ssh dir', async () => {
    const r = await checkSearch({ pattern: 'x', path: 'keys' }, EMPTY_DOCS, project, 'Grep', ctx());
    expect(r).toMatchObject({ decision: 'deny', reason: { kind: 'safety:path' } });
  });

  it('denies a .env.example root that is a symlink to .env (resolved asynchronously)', async () => {
    nodeFs.writeFileSync(nodePath.join(project, '.env'), 'SECRET=1');
    nodeFs.symlinkSync(nodePath.join(project, '.env'), nodePath.join(project, '.env.example'));
    const r = await checkSearch(
      { pattern: 'SECRET', path: '.env.example' },
      EMPTY_DOCS,
      project,
      'Grep',
      ctx(),
    );
    expect(r).toMatchObject({ decision: 'deny', reason: { kind: 'safety:path' } });
  });

  it('allows a genuine in-project .env.example template', async () => {
    nodeFs.writeFileSync(nodePath.join(project, 'src', '.env.example'), 'KEY=');
    const r = await checkSearch(
      { pattern: 'KEY', path: 'src/.env.example' },
      EMPTY_DOCS,
      project,
      'Grep',
      ctx(),
    );
    expect(r).toEqual({ decision: 'allow' });
  });

  it('denies a differently-cased protected root where the filesystem folds case', async () => {
    const original = process.platform;
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    try {
      const r = await checkSearch(
        { pattern: 'x', path: '.AWS' },
        EMPTY_DOCS,
        project,
        'Grep',
        ctx(),
      );
      expect(r).toMatchObject({ decision: 'deny', reason: { kind: 'safety:path' } });
    } finally {
      Object.defineProperty(process, 'platform', { value: original });
    }
  });

  it('tier-1c wins over a policy allow rule', async () => {
    const docs = docsWith('policy', { allow: ['Grep'] });
    const r = await checkSearch({ pattern: 'x', path: '~/.aws' }, docs, project, 'Grep', ctx());
    expect(r).toMatchObject({ decision: 'deny', reason: { kind: 'safety:path' } });
  });
});

describe('checkSearch — roots that contain a denied dir', () => {
  it('asks for a Grep rooted at ~ even with a user tool-wide allow', async () => {
    const docs = docsWith('user', { allow: ['Grep'] });
    const r = await checkSearch(
      { pattern: 'BEGIN PRIVATE KEY', path: '~' },
      docs,
      project,
      'Grep',
      ctx(),
    );
    expect(r).toMatchObject({
      decision: 'ask',
      prompt: { pathLocation: 'outside', suggestedRules: [] },
    });
  });

  it('asks for a Grep rooted at the filesystem root', async () => {
    const r = await checkSearch({ pattern: 'x', path: '/' }, EMPTY_DOCS, project, 'Grep', ctx());
    expect(r).toMatchObject({ decision: 'ask' });
  });

  it('a deny rule still denies a home-spanning root', async () => {
    const docs = docsWith('user', { deny: ['Grep'] });
    const r = await checkSearch({ pattern: 'x', path: '~' }, docs, project, 'Grep', ctx());
    expect(r).toMatchObject({ decision: 'deny', reason: { kind: 'rule:deny' } });
  });

  it('general chat (no project row, projectPath = home, no path) asks instead of allowing', async () => {
    const r = await checkSearch(
      { pattern: 'PRIVATE KEY' },
      EMPTY_DOCS,
      home,
      'Grep',
      ctx({ projectId: '' }),
    );
    expect(r).toMatchObject({ decision: 'ask' });
  });
});

describe('checkSearch — project containment', () => {
  it('allows an in-project search with no path (today’s prompt-free UX)', async () => {
    expect(await checkSearch({ pattern: 'foo' }, EMPTY_DOCS, project, 'Grep', ctx())).toEqual({
      decision: 'allow',
    });
  });

  it('allows an in-project relative path', async () => {
    expect(
      await checkSearch({ pattern: 'foo', path: 'src' }, EMPTY_DOCS, project, 'Grep', ctx()),
    ).toEqual({
      decision: 'allow',
    });
  });

  it('does not treat the project as in-project when no project row matched', async () => {
    const r = await checkSearch(
      { pattern: 'foo', path: 'src' },
      EMPTY_DOCS,
      project,
      'Grep',
      ctx({ projectId: '' }),
    );
    expect(r).toMatchObject({ decision: 'ask' });
  });

  it('asks for an outside root with no rules, offering no persistent rule', async () => {
    const r = await checkSearch(
      { pattern: 'foo', path: outside },
      EMPTY_DOCS,
      project,
      'Grep',
      ctx(),
    );
    expect(r).toMatchObject({
      decision: 'ask',
      prompt: {
        tool: 'Grep',
        reason: 'no-matching-rule',
        pathLocation: 'outside',
        suggestedRules: [],
      },
    });
  });

  it('asks for `..` traversal out of the project', async () => {
    const r = await checkSearch(
      { pattern: 'foo', path: '../outside' },
      EMPTY_DOCS,
      project,
      'Grep',
      ctx(),
    );
    expect(r).toMatchObject({ decision: 'ask', prompt: { pathLocation: 'outside' } });
  });

  it('asks for an in-project symlink that escapes to an outside dir', async () => {
    const r = await checkSearch(
      { pattern: 'foo', path: 'escape' },
      EMPTY_DOCS,
      project,
      'Grep',
      ctx(),
    );
    expect(r).toMatchObject({ decision: 'ask', prompt: { pathLocation: 'outside' } });
  });

  it('asks for an in-project root reached through a symlink that stays in the project', async () => {
    nodeFs.symlinkSync(nodePath.join(project, 'src'), nodePath.join(project, 'src-link'));
    const r = await checkSearch(
      { pattern: 'x', path: 'src-link' },
      EMPTY_DOCS,
      project,
      'Grep',
      ctx(),
    );
    expect(r).toMatchObject({ decision: 'ask', prompt: { pathLocation: 'in-current-project' } });
  });

  it('allows a symlink-free in-project root even when the project path itself is a symlink', async () => {
    const alias = nodePath.join(tmp, 'project-alias');
    nodeFs.symlinkSync(project, alias);
    expect(
      await checkSearch({ pattern: 'x', path: 'src' }, EMPTY_DOCS, alias, 'Grep', ctx()),
    ).toEqual({ decision: 'allow' });
  });

  it('an explicit project ask rule prompts even inside the project', async () => {
    const docs = docsWith('project', { ask: ['Grep'] });
    const r = await checkSearch({ pattern: 'foo' }, docs, project, 'Grep', ctx());
    expect(r).toMatchObject({
      decision: 'ask',
      prompt: { reason: 'rule:ask', matchedRule: 'Grep' },
    });
  });
});

describe('checkSearch — rules', () => {
  it('honours a path-scoped deny rule inside the project', async () => {
    const docs = docsWith('project', { deny: ['Grep(src/**)'] });
    const r = await checkSearch({ pattern: 'foo', path: 'src/lib' }, docs, project, 'Grep', ctx());
    expect(r).toMatchObject({
      decision: 'deny',
      reason: { kind: 'rule:deny', rule: 'Grep(src/**)' },
    });
  });

  it('an in-project dir whose name starts with `..` still matches project-relative rules', async () => {
    nodeFs.mkdirSync(nodePath.join(project, '..cache'), { recursive: true });
    const docs = docsWith('project', { deny: ['Grep(..cache)'] });
    const r = await checkSearch({ pattern: 'x', path: '..cache' }, docs, project, 'Grep', ctx());
    expect(r).toMatchObject({
      decision: 'deny',
      reason: { kind: 'rule:deny', rule: 'Grep(..cache)' },
    });
  });

  it('denies a Glob whose escaped `..` prefix lands in a .ssh dir', async () => {
    const r = await checkSearch(
      { pattern: '\\.\\./secret/.ssh/*' },
      EMPTY_DOCS,
      project,
      'Glob',
      ctx(),
    );
    expect(r).toMatchObject({ decision: 'deny', reason: { kind: 'safety:path' } });
  });

  it('honours a path-scoped absolute allow rule for an outside root', async () => {
    const docs = docsWith('user', { allow: [`Grep(${outside}/**)`] });
    const r = await checkSearch(
      { pattern: 'foo', path: nodePath.join(outside, 'sub') },
      docs,
      project,
      'Grep',
      ctx(),
    );
    expect(r).toEqual({ decision: 'allow' });
  });

  it('a path-scoped allow does not follow an in-project symlink out of its scope', async () => {
    const docs = docsWith('user', { allow: ['Grep(escape/**)', 'Grep(escape)'] });
    const r = await checkSearch({ pattern: 'x', path: 'escape' }, docs, project, 'Grep', ctx());
    expect(r).toMatchObject({ decision: 'ask', prompt: { pathLocation: 'outside' } });
  });

  it('a deny rule on the lexical path still denies when it is a symlink elsewhere', async () => {
    const docs = docsWith('project', { deny: ['Grep(escape)'] });
    const r = await checkSearch({ pattern: 'x', path: 'escape' }, docs, project, 'Grep', ctx());
    expect(r).toMatchObject({
      decision: 'deny',
      reason: { kind: 'rule:deny', rule: 'Grep(escape)' },
    });
  });

  it('a deny rule on the resolved target denies a symlinked alias', async () => {
    const docs = docsWith('user', { deny: [`Grep(${outside})`] });
    const r = await checkSearch({ pattern: 'x', path: 'escape' }, docs, project, 'Grep', ctx());
    expect(r).toMatchObject({ decision: 'deny', reason: { kind: 'rule:deny' } });
  });

  it('downgrades a project tool-wide Grep allow on an outside root to ask', async () => {
    const docs = docsWith('project', { allow: ['Grep'] });
    const r = await checkSearch({ pattern: 'foo', path: outside }, docs, project, 'Grep', ctx());
    expect(r).toMatchObject({ decision: 'ask', prompt: { pathLocation: 'outside' } });
  });

  it('keeps a user tool-wide Grep allow on an outside root (machine-wide by definition)', async () => {
    const docs = docsWith('user', { allow: ['Grep'] });
    const r = await checkSearch({ pattern: 'foo', path: outside }, docs, project, 'Grep', ctx());
    expect(r).toEqual({ decision: 'allow' });
  });
});

describe('checkSearch — Glob pattern widening', () => {
  it('denies a Glob whose `..` static prefix lands in a .ssh dir', async () => {
    const r = await checkSearch(
      { pattern: '../secret/.ssh/*' },
      EMPTY_DOCS,
      project,
      'Glob',
      ctx(),
    );
    expect(r).toMatchObject({ decision: 'deny', reason: { kind: 'safety:path' } });
  });

  it('denies a Glob with an absolute pattern into ~/.ssh', async () => {
    const r = await checkSearch({ pattern: `${home}/.ssh/*` }, EMPTY_DOCS, project, 'Glob', ctx());
    expect(r).toMatchObject({ decision: 'deny' });
  });

  it('asks for a Glob that climbs with `..` after a globstar', async () => {
    const r = await checkSearch({ pattern: '**/../../../*' }, EMPTY_DOCS, project, 'Glob', ctx());
    expect(r).toMatchObject({ decision: 'ask' });
  });

  it('asks for a Glob whose brace alternative names an outside absolute path', async () => {
    const r = await checkSearch({ pattern: '{src,/etc}/**' }, EMPTY_DOCS, project, 'Glob', ctx());
    expect(r).toMatchObject({ decision: 'ask' });
  });

  it('asks for a Glob that spells `..` as a character class', async () => {
    const r = await checkSearch(
      { pattern: '[.][.]/[.][.]/.ssh/**' },
      EMPTY_DOCS,
      project,
      'Glob',
      ctx(),
    );
    expect(r).toMatchObject({ decision: 'ask' });
  });

  it('allows an in-project Glob with extension alternatives', async () => {
    const r = await checkSearch(
      { pattern: 'src/**/*.{ts,tsx}' },
      EMPTY_DOCS,
      project,
      'Glob',
      ctx(),
    );
    expect(r).toEqual({ decision: 'allow' });
  });

  it('asks for an in-project Glob that names a protected dot-path', async () => {
    const r = await checkSearch({ pattern: '**/.ssh/*' }, EMPTY_DOCS, project, 'Glob', ctx());
    expect(r).toMatchObject({ decision: 'ask', prompt: { pathLocation: 'in-current-project' } });
  });

  it('asks for an in-project Grep whose glob filter selects .env files', async () => {
    const r = await checkSearch(
      { pattern: 'KEY', glob: '**/.env*' },
      EMPTY_DOCS,
      project,
      'Grep',
      ctx({}),
    );
    expect(r).toMatchObject({ decision: 'ask' });
  });

  it('a protected-target Glob asks even over a user tool-wide allow', async () => {
    const docs = docsWith('user', { allow: ['Glob'] });
    const r = await checkSearch({ pattern: '**/.aws/*' }, docs, project, 'Glob', ctx());
    expect(r).toMatchObject({ decision: 'ask' });
  });

  it('a negated Glob is not denied as a search into the excluded dir', async () => {
    const r = await checkSearch({ pattern: '!.ssh/**' }, EMPTY_DOCS, project, 'Glob', ctx());
    expect(r).toMatchObject({ decision: 'ask' });
  });

  it('allows an ordinary in-project Glob', async () => {
    expect(
      await checkSearch({ pattern: 'src/**/*.ts' }, EMPTY_DOCS, project, 'Glob', ctx()),
    ).toEqual({
      decision: 'allow',
    });
  });

  it('Grep `glob` is a filter only and cannot widen the root', async () => {
    const r = await checkSearch(
      { pattern: 'x', glob: '/etc/**' },
      EMPTY_DOCS,
      project,
      'Grep',
      ctx(),
    );
    expect(r).toEqual({ decision: 'allow' });
  });
});

describe('checkSearch — host-resolved searchRoot', () => {
  it('uses the host-supplied root over the agent’s input', async () => {
    const r = await checkSearch(
      { pattern: 'x', path: nodePath.join(project, 'src') },
      EMPTY_DOCS,
      project,
      'Grep',
      ctx({ searchRoot: nodePath.join(home, '.ssh') }),
    );
    expect(r).toMatchObject({ decision: 'deny' });
  });

  it('ignores a `search_root` field the agent smuggles into the input', async () => {
    const r = await checkSearch(
      { pattern: 'x', path: '~/.ssh', search_root: project },
      EMPTY_DOCS,
      project,
      'Grep',
      ctx(),
    );
    expect(r).toMatchObject({ decision: 'deny' });
  });
});

describe('checkSearch — app-owned allow-lists', () => {
  let sessionDir: string;
  let skillsRoot: string;

  beforeAll(() => {
    sessionDir = nodePath.join(tmp, 'session');
    nodeFs.mkdirSync(nodePath.join(sessionDir, 'projects', 'slug', 'tool-results'), {
      recursive: true,
    });
    nodeFs.writeFileSync(
      nodePath.join(sessionDir, 'projects', 'slug', 'tool-results', 'r.txt'),
      'x',
    );
    nodeFs.mkdirSync(nodePath.join(sessionDir, 'plans'), { recursive: true });
    nodeFs.writeFileSync(nodePath.join(sessionDir, 'plans', 'plan.md'), 'x');
    skillsRoot = nodePath.join(tmp, 'skills');
    nodeFs.mkdirSync(nodePath.join(skillsRoot, 'shipped'), { recursive: true });
    nodeFs.writeFileSync(nodePath.join(skillsRoot, 'shipped', '.baseline.json'), '{}');
    nodeFs.mkdirSync(nodePath.join(skillsRoot, 'mine'), { recursive: true });
  });

  const sessionCtx = () =>
    ctx({
      sessionDirRoot: sessionDir,
      planDirRoot: nodePath.join(sessionDir, 'plans'),
      skillsDirRoots: [skillsRoot],
    });

  it('allows a Grep over a CLI tool-result spill file', async () => {
    const path = nodePath.join(sessionDir, 'projects', 'slug', 'tool-results', 'r.txt');
    expect(
      await checkSearch({ pattern: 'x', path }, EMPTY_DOCS, project, 'Grep', sessionCtx()),
    ).toEqual({
      decision: 'allow',
    });
  });

  it('asks when a symlink inside tool-results points out of the session dir', async () => {
    const link = nodePath.join(sessionDir, 'projects', 'slug', 'tool-results', 'out');
    nodeFs.symlinkSync(outside, link);
    const r = await checkSearch(
      { pattern: 'x', path: link },
      EMPTY_DOCS,
      project,
      'Grep',
      sessionCtx(),
    );
    expect(r).toMatchObject({ decision: 'ask' });
  });

  it('allows a Grep over the whole plan dir (per-chat app-owned scratch)', async () => {
    const path = nodePath.join(sessionDir, 'plans');
    expect(
      await checkSearch({ pattern: 'x', path }, EMPTY_DOCS, project, 'Grep', sessionCtx()),
    ).toEqual({ decision: 'allow' });
  });

  it('asks for a Grep over a pasted/ look-alike outside the session dir', async () => {
    const path = nodePath.join(tmp, 'pasted');
    nodeFs.mkdirSync(path, { recursive: true });
    const r = await checkSearch({ pattern: 'x', path }, EMPTY_DOCS, project, 'Grep', sessionCtx());
    expect(r).toMatchObject({ decision: 'ask' });
  });

  it('asks for a Grep over the whole session dir (transcripts, shell snapshots)', async () => {
    const r = await checkSearch(
      { pattern: 'x', path: sessionDir },
      EMPTY_DOCS,
      project,
      'Grep',
      sessionCtx(),
    );
    expect(r).toMatchObject({ decision: 'ask' });
  });

  it('asks for a Grep over a transcript project dir', async () => {
    const path = nodePath.join(sessionDir, 'projects', 'slug');
    expect(
      await checkSearch({ pattern: 'x', path }, EMPTY_DOCS, project, 'Grep', sessionCtx()),
    ).toMatchObject({
      decision: 'ask',
    });
  });

  it('allows a Grep over a plan file', async () => {
    const path = nodePath.join(sessionDir, 'plans', 'plan.md');
    expect(
      await checkSearch({ pattern: 'x', path }, EMPTY_DOCS, project, 'Grep', sessionCtx()),
    ).toEqual({
      decision: 'allow',
    });
  });

  it('allows a marker-bearing shipped skill and asks for an unmarked user skill', async () => {
    const shipped = nodePath.join(skillsRoot, 'shipped');
    const mine = nodePath.join(skillsRoot, 'mine');
    expect(
      await checkSearch({ pattern: 'x', path: shipped }, EMPTY_DOCS, project, 'Grep', sessionCtx()),
    ).toEqual({
      decision: 'allow',
    });
    expect(
      await checkSearch({ pattern: 'x', path: mine }, EMPTY_DOCS, project, 'Grep', sessionCtx()),
    ).toMatchObject({
      decision: 'ask',
    });
  });

  it('asks for a Grep over the whole skills root (spans unmarked skills)', async () => {
    const r = await checkSearch(
      { pattern: 'x', path: skillsRoot },
      EMPTY_DOCS,
      project,
      'Grep',
      sessionCtx(),
    );
    expect(r).toMatchObject({ decision: 'ask' });
  });
});
