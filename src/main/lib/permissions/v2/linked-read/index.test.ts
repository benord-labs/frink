import * as nodeFs from 'node:fs';
import nodeOs from 'node:os';
import * as nodePath from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { readQuestions } from '../../../agent-runner/path-questions';
import { checkPermission, resetDocsLoader, setDocsLoader } from '../check';
import { EMPTY_DOCS, type ScopedDocs } from '../eval-rules';
import type { LinkedRoot, PermissionRequest, PermissionsDoc } from '../types';
import { applyLinkedRead } from './index';

const none: PermissionsDoc = { allow: [], deny: [], ask: [] };
const NO_RULE = { decision: 'ask', prompt: { reason: 'no-matching-rule' } };
const OUTSIDE = {
  decision: 'ask',
  prompt: { reason: 'no-matching-rule', pathLocation: 'outside' },
};
const SAFETY = { decision: 'deny', reason: { kind: 'safety:path' } };
const home = nodeOs.homedir();

let tmp: string;
let main: string;
let linked: string;
const at = (rel: string): string => nodePath.join(linked, rel);
const link = (path: string, doc: PermissionsDoc | null = none): LinkedRoot => ({
  projectId: 'p2',
  path,
  doc,
});

function request(tool: string, input: object, linkedRoots?: LinkedRoot[]): PermissionRequest {
  return { tool, input, projectId: 'p1', projectPath: main, linkedRoots };
}
const read = (rel: string, roots = [link(linked)]) =>
  checkPermission(request('Read', { file_path: at(rel) }, roots));
const withDocs = (docs: Partial<ScopedDocs>) =>
  setDocsLoader(async () => ({ policy: none, project: none, user: none, ...docs }));

beforeAll(() => {
  tmp = nodeFs.realpathSync(nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'linked-read-')));
  main = nodePath.join(tmp, 'main');
  linked = nodePath.join(tmp, 'linked');
  const files = ['main/a.ts', 'linked/src/a.ts', 'linked/secrets/x', 'linked/.env'];
  const others = ['linked2/a.ts', 'home/.aws/credentials', 'home/notes.txt', 'outside/b.txt'];
  for (const file of [...files, ...others, 'linked/app/(group)/page.tsx']) {
    nodeFs.mkdirSync(nodePath.dirname(nodePath.join(tmp, file)), { recursive: true });
    nodeFs.writeFileSync(nodePath.join(tmp, file), 'x');
  }
  nodeFs.mkdirSync(at('docs'));
  nodeFs.symlinkSync(at('.env'), at('notes.txt'));
  nodeFs.symlinkSync(nodePath.join(tmp, 'home/.aws/credentials'), at('creds'));
  nodeFs.symlinkSync(nodePath.join(tmp, 'outside'), at('out'));
  nodeFs.symlinkSync(at('secrets'), at('docs/s'));
  nodeFs.symlinkSync(nodePath.join(tmp, 'home'), nodePath.join(tmp, 'homelink'));
});
afterAll(() => nodeFs.rmSync(tmp, { recursive: true, force: true }));
afterEach(() => {
  resetDocsLoader();
  vi.restoreAllMocks();
});

describe('applyLinkedRead — allows', () => {
  it.each([
    ['a file inside it', 'src/a.ts'],
    ['the linked folder itself', ''],
    ['a file whose folder name has brackets', 'app/(group)/page.tsx'],
    ['the env template', '.env.example'],
  ])('a Read of %s', async (_, rel) => {
    expect(await read(rel)).toEqual({ decision: 'allow' });
  });

  it('changes nothing with no linked projects', async () => {
    const r = await checkPermission(request('Read', { file_path: at('src/a.ts') }));
    expect(r).toMatchObject(OUTSIDE);
  });
});

describe('applyLinkedRead — after the deny list and every rule', () => {
  it('leaves the deny list in force inside a linked folder', async () => {
    expect(await read('.env')).toMatchObject(SAFETY);
  });

  it.each<[string, () => Partial<ScopedDocs>, object]>([
    [
      "the main project's tool-wide Read grant (set aside outside it)",
      () => ({ project: { ...none, allow: ['Read'] } }),
      { decision: 'allow' },
    ],
    [
      'a user deny rule',
      () => ({ user: { ...none, deny: ['Read'] } }),
      { decision: 'deny', reason: { kind: 'rule:deny', tier: 'user' } },
    ],
    [
      'a user ask rule',
      () => ({ user: { ...none, ask: ['Read'] } }),
      { decision: 'ask', prompt: { reason: 'rule:ask', matchedTier: 'user' } },
    ],
    [
      'a user ask rule under the main project tool-wide Read grant',
      () => ({ project: { ...none, allow: ['Read'] }, user: { ...none, ask: ['Read'] } }),
      { decision: 'ask', prompt: { reason: 'rule:ask', matchedRule: 'Read', matchedTier: 'user' } },
    ],
    [
      'a user ask rule for the linked folder under the main project tool-wide Read grant',
      () => ({
        project: { ...none, allow: ['Read'] },
        user: { ...none, ask: [`Read(${linked}/**)`] },
      }),
      { decision: 'ask', prompt: { reason: 'rule:ask', matchedTier: 'user' } },
    ],
  ])('honours %s', async (_, docs, expected) => {
    withDocs(docs());
    expect(await read('src/a.ts')).toMatchObject(expected);
  });

  it.each(['Edit', 'Write', 'Delete'])('leaves %s in a linked folder asking', async (tool) => {
    const req = request(tool, { file_path: at('src/a.ts') }, [link(linked)]);
    const asked = await checkPermission(req);
    expect(asked).toMatchObject(OUTSIDE);
    expect(applyLinkedRead(asked, req, EMPTY_DOCS)).toBe(asked);
  });
});

describe("applyLinkedRead — the chat's own rules at another spelling of the path", () => {
  // docs/s links to secrets/. Each rule names secrets/ one way; the Read names it another.
  const SPELLINGS: [string, () => string, () => string][] = [
    ['through a link in the folder', () => at('docs/s/x'), () => at('secrets')],
    ['in another letter case', () => nodePath.join(tmp, 'LINKED/secrets/x'), () => at('secrets')],
    [
      'with the folder as the link registers it',
      () => at('docs/s/x'),
      () => nodePath.join(nodeOs.tmpdir(), nodePath.basename(tmp), 'linked/secrets'),
    ],
  ];
  const registered = () => nodePath.join(nodeOs.tmpdir(), nodePath.basename(tmp), 'linked');
  // A case-sensitive disk has no LINKED folder, so that read is not in the link and asks.
  const unlessMissing = (file: string, expected: object) =>
    nodeFs.existsSync(file) ? expected : NO_RULE;

  it.each(SPELLINGS)('a policy deny rule still denies a Read %s', async (_, file, ruled) => {
    withDocs({ policy: { ...none, deny: [`Read(${ruled()}/**)`] } });
    const r = await checkPermission(request('Read', { file_path: file() }, [link(registered())]));
    const denied = { decision: 'deny', reason: { kind: 'rule:deny', tier: 'policy' } };
    expect(r).toMatchObject(unlessMissing(file(), denied));
  });

  it.each(SPELLINGS)('a user ask rule still asks for a Read %s', async (_, file, ruled) => {
    withDocs({ user: { ...none, ask: [`Read(${ruled()}/**)`] } });
    const r = await checkPermission(request('Read', { file_path: file() }, [link(registered())]));
    const asked = { decision: 'ask', prompt: { reason: 'rule:ask', matchedTier: 'user' } };
    expect(r).toMatchObject(unlessMissing(file(), asked));
  });
});

describe('applyLinkedRead — env files ask, as in the chat folder', () => {
  it.each([
    ['an env file off the deny list', 'config/prod.env'],
    ['a named env file off the deny list', 'prod.env.local'],
    ['a search filter that reaches env files', '**/.env*'],
    ['a braced search filter that reaches env files', 'src/*.{env,ts}'],
    ['a bracket search filter that reaches env files', '[.]env'],
  ])('for a Read of %s', async (_, rel) => {
    expect(await read(rel)).toMatchObject(NO_RULE);
  });

  it('asks before a Copilot or Cursor search with an env filter, and lets the search through', async () => {
    const questions = readQuestions(linked, main, '**/.env*') ?? [];
    expect(questions.map(({ input }) => input)).toEqual([
      { file_path: linked },
      { file_path: at('**/.env*') },
    ]);
    const answers = await Promise.all(
      questions.map(({ toolName, input }) =>
        checkPermission(request(toolName, input, [link(linked)])),
      ),
    );
    expect(answers).toMatchObject([{ decision: 'allow' }, NO_RULE]);
  });
});

// Ripgrep searches a file its glob names even when the file is hidden or ignored.
describe("applyLinkedRead — a Grep's file filter", () => {
  const grep = (filter: object) =>
    checkPermission(request('Grep', { pattern: 'x', path: linked, ...filter }, [link(linked)]));

  it.each(['.env', '**/*.key', 'certs/*.pem', '*.{ts,pem}', '*.ts .env', '*.ts,credentials.json'])(
    'denies a search filtered to %j, which names files on the deny list',
    async (glob) => {
      expect(await grep({ glob })).toMatchObject(SAFETY);
    },
  );

  it.each<[string, object]>([
    ['a glob that can reach an env file', { glob: '*.env' }],
    ['a glob for every env file', { glob: '**/.env*' }],
    ['a file type, whose globs Frink cannot see', { type: 'sh' }],
    ['a glob Frink cannot read', { glob: ['*.ts'] }],
    ['a glob with too many spellings to check', { glob: '{a,b}'.repeat(7) }],
  ])('asks for a search filtered by %s', async (_, filter) => {
    expect(await grep(filter)).toMatchObject(NO_RULE);
  });

  it.each(['', '*.ts', '**/*.{ts,tsx}', '!*.key'])(
    'lets a search filtered to %j run',
    async (glob) => {
      expect(await grep({ glob })).toEqual({ decision: 'allow' });
    },
  );

  it('leaves a Glob for key files alone: it lists their names and opens none', async () => {
    const req = request('Glob', { pattern: '**/*.key', path: linked }, [link(linked)]);
    expect(await checkPermission(req)).toEqual({ decision: 'allow' });
  });
});

describe('applyLinkedRead — asks', () => {
  it.each([
    ['a folder symlink that points out', 'out/b.txt'],
    ['a sibling folder whose name starts with the linked one', '../linked2/a.ts'],
  ])('for a Read of %s', async (_, rel) => {
    expect(await read(rel)).toMatchObject(NO_RULE);
  });

  it.each([
    ['a file symlink to a protected file outside the folder', 'creds'],
    ['a file symlink to a protected file inside the folder', 'notes.txt'],
  ])('denies a Read of %s, so Auto review never sees it', async (_, rel) => {
    expect(await read(rel)).toMatchObject(SAFETY);
  });

  it('when the linked project rules could not be loaded', async () => {
    expect(await read('src/a.ts', [link(linked, null)])).toMatchObject(NO_RULE);
  });

  it.each([
    ['Glob', { pattern: '*.ts' }],
    ['Grep', { pattern: 'x' }],
  ])('for a %s when the linked project rules could not be loaded', async (tool, input) => {
    const req = request(tool, { ...input, path: linked }, [link(linked, null)]);
    expect(await checkPermission(req)).toMatchObject(NO_RULE);
  });

  it('for a link whose folder is not an absolute path (never the app folder)', async () => {
    const file_path = nodePath.join(process.cwd(), 'package.json');
    const req = request('Read', { file_path }, [link(''), link('.')]);
    expect(await checkPermission(req)).toMatchObject(NO_RULE);
  });

  it('for a Glob that climbs out of the folder', async () => {
    const req = request('Glob', { pattern: '../../**', path: linked }, [link(linked)]);
    expect(await checkPermission(req)).toMatchObject(NO_RULE);
  });

  it('for a Glob whose pattern alone points into the folder (it searches the chat folder)', async () => {
    const req = request('Glob', { pattern: `${linked}/**/*.ts` }, [link(linked)]);
    expect(await checkPermission(req)).toMatchObject(NO_RULE);
  });

  it.each([
    ['Grep', { pattern: 'KEY', path: home }],
    ['Read', { file_path: home }],
  ])('for a %s of a linked folder holding ~/.ssh', async (tool, input) => {
    expect(await checkPermission(request(tool, input, [link(home)]))).toMatchObject(NO_RULE);
  });

  it('for a Read in a linked folder that has since become a link to home', async () => {
    const roots = [link(nodePath.join(tmp, 'homelink'))];
    const req = () =>
      request('Read', { file_path: nodePath.join(tmp, 'homelink/notes.txt') }, roots);
    expect(await checkPermission(req())).toEqual({ decision: 'allow' });
    vi.spyOn(nodeOs, 'homedir').mockReturnValue(nodePath.join(tmp, 'home'));
    expect(await checkPermission(req())).toMatchObject(NO_RULE);
  });
});

describe("applyLinkedRead — the linked project's own rules", () => {
  const LINKED_RULE = {
    allow: { decision: 'allow' },
    ask: {
      decision: 'ask',
      prompt: {
        reason: 'rule:ask',
        matchedTier: 'project',
        matchedProjectId: 'p2',
        suggestedRules: [],
      },
    },
    deny: { decision: 'deny', reason: { kind: 'rule:deny', tier: 'project', projectId: 'p2' } },
  } as const;

  // docs/s links to secrets/: both the written and the resolved path are matched.
  it.each<[Partial<PermissionsDoc>, string, keyof typeof LINKED_RULE]>([
    [{ deny: ['Read(secrets/**)'] }, 'secrets/x', 'deny'],
    [{ deny: ['Read(secrets/**)'] }, 'src/a.ts', 'allow'],
    [{ deny: ['Read(secrets/**)'] }, 'docs/s/x', 'deny'],
    [{ deny: ['Read(docs/**)'] }, 'docs/s/x', 'deny'],
    [{ ask: ['Read(src/**)'] }, 'src/a.ts', 'ask'],
    [{ deny: ['Read'] }, 'src/a.ts', 'deny'],
  ])('%j makes a Read of %s %s', async (rules, rel, expected) => {
    expect(await read(rel, [link(linked, { ...none, ...rules })])).toMatchObject(
      LINKED_RULE[expected],
    );
  });

  it.each<[string, Partial<PermissionsDoc>, keyof typeof LINKED_RULE]>([
    ['Glob', { deny: ['Glob'] }, 'deny'],
    ['Grep', { deny: ['Grep'] }, 'deny'],
    ['Grep', { ask: ['Grep'] }, 'ask'],
  ])('a %s of the folder with %j is %s', async (tool, rules, expected) => {
    const req = request(tool, { pattern: 'x', path: linked }, [
      link(linked, { ...none, ...rules }),
    ]);
    expect(await checkPermission(req)).toMatchObject(LINKED_RULE[expected]);
  });

  // A search, or a Read of a folder, reads the files a path rule names inside it.
  it.each<[string, string, Partial<PermissionsDoc>, keyof typeof LINKED_RULE | 'none']>([
    ['Read', '', { deny: ['Read(**)'] }, 'none'],
    ['Grep', '', { deny: ['Read(secrets/**)'] }, 'none'],
    ['Glob', '', { ask: ['Read'] }, 'none'],
    ['Grep', 'src', { deny: ['Read(secrets/**)'] }, 'allow'],
  ])('a %s of the folder at %j with %j is %s', async (tool, rel, rules, expected) => {
    const input = tool === 'Read' ? { file_path: at(rel) } : { pattern: 'x', path: at(rel) };
    const req = request(tool, input, [link(linked, { ...none, ...rules })]);
    const r = await checkPermission(req);
    expect(r).toMatchObject(expected === 'none' ? NO_RULE : LINKED_RULE[expected]);
  });

  it('keeps an outer linked project deny rule for a folder linked inside it', async () => {
    const roots = [link(linked, { ...none, deny: ['Read(src/**)'] }), link(at('src'))];
    expect(await read('src/a.ts', roots)).toMatchObject(LINKED_RULE.deny);
  });
});
