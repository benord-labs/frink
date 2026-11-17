import { chmod, mkdir, mkdtemp, open, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CodexApprovalCheck } from '../codex/codex-approvals';
import type { ApprovalOutcome, CodexApprovalRequest } from '../codex/codex-events';
import type { JsonValue } from '../path-questions';
import { CURSOR_RIPGREP } from './cursor-test-fixtures';
import { CURSOR_TOOL_NAMES, type CursorHookAnswer, createCursorGate } from './index';

let root = '';
let cwd = '';
let home = '';
let realHome = '';
let outside = '';
let asset = '';

beforeAll(async () => {
  // Spaces in every folder, as in macOS's Application Support folder.
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'cursor gate ')));
  // The chat folder sits one level down, so a glob that steps up once stays clear of the home.
  [cwd, home, realHome, outside] = ['work/chat folder', 'private home', 'real home', 'outside'].map(
    (name) => path.join(root, name),
  );
  asset = path.join(home, '.cursor', 'projects', 'p', 'assets', 'shot.png');
  await mkdir(path.dirname(asset), { recursive: true });
  await mkdir(path.join(home, '.cursor', 'projects', 'p', 'agent-tools'), { recursive: true });
  await mkdir(path.join(realHome, '.cursor', 'sdk'), { recursive: true });
  await mkdir(cwd, { recursive: true });
  await mkdir(path.join(outside, 'assets'), { recursive: true });
  await symlink(outside, path.join(home, '.cursor', 'projects', 'linked'));
  await writeFile(path.join(outside, 'target.png'), 'x');
  await symlink(
    path.join(outside, 'target.png'),
    path.join(home, '.cursor', 'projects', 'p', 'assets', 'link.png'),
  );
});
afterAll(() => rm(root, { recursive: true, force: true }));

const VERSION = '1.0.0';
const ALLOW_ALL: ApprovalOutcome = { allowed: true };
const DENIED: ApprovalOutcome = { allowed: false, message: 'User denied permission' };
const CANT_CHECK = "Frink can't check this tool yet, so it didn't run.";
const CANT_PATH = "Frink can't check this path, so it didn't run.";
const CHANGED = 'Cursor changed how it asks Frink, so Frink stopped it.';
const ALLOW = { permission: 'allow' };
const deny = (user_message: string) => ({ permission: 'deny', user_message });

const bash = (command: string) => ({ toolName: 'Bash', input: { command } });
const edit = (file: string) => ({ toolName: 'Edit', input: { file_path: file } });
const read = (file: string) => ({ toolName: 'Read', input: { file_path: file } });
const ENV_GLOBS = [
  '*.env',
  '.env*',
  '**/.env',
  '.env.prod*',
  '.e?v',
  '[.]env',
  '{.env,a}',
  '*.{env,ts}',
  'config/.env',
  '?env',
  '.ENV',
  'config*.env.local',
  'api.env.d/*.json',
  '.e*.x',
  '*env.local',
];
// Filters that only leave files out; ripgrep never un-hides or un-ignores a file for one.
const EXCLUSIONS = ['!node_modules', '!**/dist/**', '!*.md', '!{a,b}', '!../x', '!.env*'];
/** A glob call as the hook sees it: a Grep for nothing that returns file names only. */
const LISTING = { pattern: '', glob: '**/*', output_mode: 'files_with_matches' };

/** A hook body as Cursor sends it, with the extra fields it always carries. */
const pre = (tool_name: string, tool_input: JsonValue, tool_use_id = 'u1') => ({
  hook_event_name: 'preToolUse',
  cursor_version: VERSION,
  model: 'default',
  workspace_roots: [cwd],
  cwd: '',
  tool_name,
  tool_input,
  tool_use_id,
});
const shellExec = (command: string, tool_use_id: string) => ({
  hook_event_name: 'beforeShellExecution',
  cursor_version: VERSION,
  command,
  cwd: '',
  sandbox: false,
  tool_use_id,
});
const SUBMIT = { hook_event_name: 'beforeSubmitPrompt', cursor_version: VERSION, prompt: 'hi' };

function testGate(
  answer: (request: CodexApprovalRequest) => ApprovalOutcome,
  folder = cwd,
  ripgrep = CURSOR_RIPGREP,
) {
  const asked: CodexApprovalRequest[] = [];
  const stops: string[] = [];
  const turn = new AbortController();
  const checkApproval: CodexApprovalCheck = async (request) => {
    asked.push(request);
    return answer(request);
  };
  const gate = createCursorGate({
    cwd: folder,
    home,
    realHome,
    ripgrep,
    hookVersions: [VERSION],
    checkApproval,
    turnOver: turn.signal,
    onStop: (reason) => stops.push(reason),
  });
  const decideText = async (body: string): Promise<CursorHookAnswer> => {
    const output = await gate.answer(body);
    // Frink never answers ask, which would run the tool.
    expect([ALLOW, { continue: true }, deny(expect.any(String))]).toContainEqual(output);
    return output;
  };
  const decide = (body: JsonValue) => decideText(JSON.stringify(body));
  return { gate, asked, stops, turn, decide, decideText };
}

describe('the questions each recorded Cursor hook call asks', () => {
  it('maps shell, write, delete and outside reads to Bash, Edit and Read', async () => {
    const { asked, decide } = testGate(() => ALLOW_ALL);
    const shell = { command: 'echo x > p-allow.txt', cwd: '', timeout: 30000 };
    const written = path.join(outside, 'outside-write.txt');
    expect(await decide(pre('Shell', shell))).toEqual(ALLOW);
    expect(await decide(pre('Write', { file_path: written, content: 'hi' }))).toEqual(ALLOW);
    expect(await decide(pre('Write', JSON.stringify({ file_path: 'a.txt', content: '' })))).toEqual(
      ALLOW,
    );
    expect(await decide(pre('Delete', { file_path: 'old.txt' }))).toEqual(ALLOW);
    expect(await decide(pre('Read', { file_path: path.join(outside, 'secret.txt') }))).toEqual(
      ALLOW,
    );
    expect(asked).toEqual([
      bash('echo x > p-allow.txt'),
      edit(written),
      edit(path.join(cwd, 'a.txt')),
      edit(path.join(cwd, 'old.txt')),
      read(path.join(outside, 'secret.txt')),
    ]);
  });

  it('reads, searches and lints inside the folder without a question', async () => {
    const { asked, decide } = testGate(() => DENIED);
    expect(await decide(pre('Read', { file_path: path.join(cwd, 'direct.txt') }))).toEqual(ALLOW);
    expect(await decide(pre('ReadLints', { file_path: 'hello.txt' }))).toEqual(ALLOW);
    const glob = {
      pattern: '',
      file_path: cwd,
      glob: '**/*.txt',
      output_mode: 'files_with_matches',
    };
    expect(await decide(pre('Grep', glob))).toEqual(ALLOW);
    expect(await decide(pre('Grep', { pattern: 'hello', file_path: cwd }))).toEqual(ALLOW);
    expect(await decide(pre('Grep', { pattern: 'x', glob: '*.{json,md}' }))).toEqual(ALLOW);
    expect(asked).toEqual([]);
  });

  it('asks before a search that would follow a link out of the folder, and not for one that stays in', async () => {
    const linked = path.join(root, 'work', 'linked chat');
    await mkdir(path.join(linked, 'src', 'lib'), { recursive: true });
    await writeFile(path.join(linked, 'src', 'lib', 'a.ts'), 'key');
    await symlink(path.join(linked, 'src', 'lib'), path.join(linked, 'src', 'inner'));
    await symlink(outside, path.join(linked, 'outside link'));
    // A chain: chained/a leads to other, whose b leads outside; via is a link to other.
    await mkdir(path.join(linked, 'other'));
    await mkdir(path.join(linked, 'chained'));
    await symlink(outside, path.join(linked, 'other', 'b'));
    await symlink(path.join(linked, 'other'), path.join(linked, 'chained', 'a'));
    await symlink(path.join(linked, 'other'), path.join(linked, 'via'));
    await symlink(linked, path.join(root, 'work', 'chat link'));
    const { asked, decide } = testGate(() => DENIED, linked);
    const viaLink = testGate(() => DENIED, path.join(root, 'work', 'chat link'));

    for (const file_path of [linked, 'chained', 'via']) {
      expect(await decide(pre('Grep', { pattern: 'key', file_path }))).toEqual(
        deny(DENIED.message),
      );
    }
    expect(await decide(pre('Grep', { pattern: 'key', glob: '**/*' }))).toEqual(
      deny(DENIED.message),
    );
    expect(await viaLink.decide(pre('Grep', { pattern: 'key' }))).toEqual(deny(DENIED.message));
    expect(await decide(pre('Grep', { pattern: 'key', file_path: 'src' }))).toEqual(ALLOW);
    expect(await decide(pre('Grep', { pattern: 'key', file_path: 'missing' }))).toEqual(ALLOW);
    // The glob can open an env file, which is asked first and denied.
    const envGlob = read(path.join(linked, '**/*'));
    expect([...asked, ...viaLink.asked]).toEqual([
      ...Array(3).fill(read(outside)),
      envGlob,
      read(outside),
    ]);
  });

  it('asks Read for an env file in the folder, a read outside it, and a glob that steps up', async () => {
    const { asked, decide } = testGate(() => DENIED);
    expect(await decide(pre('Read', { file_path: '.env' }))).toEqual(deny(DENIED.message));
    expect(await decide(pre('Read', { file_path: '/etc/hosts' }))).toEqual(deny(DENIED.message));
    expect(await decide(pre('Grep', { pattern: 'x', glob: '../*' }))).toEqual(deny(DENIED.message));
    expect(asked).toEqual([
      read(path.join(cwd, '.env')),
      read('/etc/hosts'),
      read(path.dirname(cwd)),
    ]);
  });

  it('asks Read before a search whose glob can open an env file, but not before a file listing', async () => {
    const { asked, decide } = testGate(() => DENIED);
    for (const glob of ENV_GLOBS) {
      const search = pre('Grep', { pattern: 'KEY', file_path: cwd, glob });
      expect(await decide(search)).toEqual(deny(DENIED.message));
      const listing = { ...LISTING, glob };
      expect(await decide(pre('Grep', listing))).toEqual(ALLOW);
    }
    const dump = pre('Grep', { pattern: '', glob: '*.env', output_mode: 'content' });
    expect(await decide(dump)).toEqual(deny(DENIED.message));
    for (const glob of ['*.ts', '**/*.{ts,tsx}', 'src/**/*.json', '.env.example', ...EXCLUSIONS]) {
      expect(await decide(pre('Grep', { pattern: 'KEY', glob }))).toEqual(ALLOW);
    }
    expect(await decide(pre('Grep', { pattern: 'KEY', glob: '{*.env,!x}' }))).toEqual(
      deny(DENIED.message),
    );
    expect(await decide(pre('Grep', { pattern: 'KEY', glob: '!(x)' }))).toEqual(deny(CANT_CHECK));
    const notes = { pattern: 'KEY', file_path: path.join(cwd, 'Notes (2024)'), glob: '*.md' };
    expect(await decide(pre('Grep', notes))).toEqual(ALLOW);
    expect(asked).toEqual([
      ...ENV_GLOBS.map((glob) => read(path.join(cwd, glob))),
      read(path.join(cwd, '*.env')),
      read(path.join(cwd, '{*.env,!x}')),
    ]);
  });

  it('runs a shell in the folder, and refuses one started anywhere else', async () => {
    const { asked, decide } = testGate(() => ALLOW_ALL);
    expect(await decide(pre('Shell', { command: 'ls', cwd: path.join(cwd, 'src') }))).toEqual(
      ALLOW,
    );
    expect(await decide(pre('Shell', { command: 'ls', cwd: 'src' }))).toEqual(deny(CANT_PATH));
    expect(await decide(pre('Shell', { command: 'ls', cwd: outside }))).toEqual(deny(CANT_PATH));
    expect(asked).toEqual([bash('ls')]);
  });
});

describe('a search through links', () => {
  const UNCHECKED =
    "Frink couldn't check where this search's links lead, so it didn't run it. Try a smaller folder.";
  let base = '';
  let shared = '';

  beforeAll(async () => {
    base = path.join(root, 'links');
    shared = path.join(base, 'shared');
    await mkdir(path.join(shared, 'deep'), { recursive: true });
    await writeFile(path.join(shared, 'deep', 'note.txt'), 'MARK');
  });

  /** A project with these links in it, each leading to a folder beside it that holds a file. */
  async function project(name: string, links: Record<string, string>, files = {}) {
    const dir = path.join(base, name);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'in.txt'), 'MARK');
    for (const [file, text] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
      await writeFile(path.join(dir, file), String(text));
    }
    for (const [link, target] of Object.entries(links)) {
      await mkdir(path.dirname(path.join(dir, link)), { recursive: true });
      await mkdir(path.join(base, target), { recursive: true });
      await writeFile(path.join(base, target, 'out.txt'), 'MARK');
      await symlink(path.join(base, target), path.join(dir, link));
    }
    return dir;
  }

  /** A stand-in for ripgrep that lists these files, relative to the searched folder. */
  async function listing(name: string, files: string[]) {
    const script = path.join(base, `${name} rg`);
    await writeFile(script, `#!/bin/sh\nprintf '${files.map((file) => `${file}\\0`).join('')}'\n`);
    await chmod(script, 0o755);
    return script;
  }

  it('asks nothing for a whole worktree whose outside links git ignores, unless a glob un-ignores them', async () => {
    // A worktree's .git file names its folder in the main repo, whose info/exclude applies.
    const gitDir = path.join(base, 'main repo', '.git');
    await mkdir(path.join(gitDir, 'info'), { recursive: true });
    await mkdir(path.join(gitDir, 'worktrees', 'wt'), { recursive: true });
    await writeFile(path.join(gitDir, 'info', 'exclude'), '/.local/\n/docs/decisions\n');
    await writeFile(path.join(gitDir, 'worktrees', 'wt', 'commondir'), '../..\n');
    const wt = await project(
      'wt',
      {
        '.local/tools': 'overlay a',
        '.local/hooks': 'overlay a/hooks',
        'docs/decisions': 'overlay b',
        '.fallow': 'overlay b/fallow',
        'cloned-projects': 'overlay c',
      },
      {
        '.git': `gitdir: ${path.join(gitDir, 'worktrees', 'wt')}\n`,
        '.gitignore': '.fallow\ncloned-projects\n',
      },
    );
    const { asked, decide } = testGate(() => DENIED, wt);
    expect(await decide(pre('Grep', { pattern: 'MARK' }))).toEqual(ALLOW);
    expect(await decide(pre('Grep', { pattern: 'MARK', file_path: wt, glob: '*.txt' }))).toEqual(
      ALLOW,
    );
    expect(asked).toEqual([]);
    // A glob filter overrides ripgrep's ignore files, so these links are walked and asked.
    const globbed = testGate(() => ALLOW_ALL, wt);
    expect(await globbed.decide(pre('Grep', { pattern: 'MARK', glob: '**/*' }))).toEqual(ALLOW);
    const overlays = ['overlay a', 'overlay b', 'overlay c'].map((t) => read(path.join(base, t)));
    expect(globbed.asked).toEqual([read(path.join(wt, '**/*')), ...overlays]);
  });

  it('asks one Read for the real target of a link it walks, once per target, nested ones folded', async () => {
    const dir = await project('open', {
      open: 'target one',
      again: 'target one',
      'sub/nested': 'target one/inner',
      file: 'target two',
    });
    const { asked, decide } = testGate(() => ALLOW_ALL, dir);
    expect(await decide(pre('Grep', { pattern: 'MARK' }))).toEqual(ALLOW);
    expect(asked).toEqual(['target one', 'target two'].map((t) => read(path.join(base, t))));
  });

  it('walks the whole searched folder when the glob only excludes or steps out', async () => {
    const dir = await project('excluding', { ext: 'excluded target' });
    for (const glob of ['!../x', '!{../a,b}']) {
      const { asked, decide } = testGate(() => ALLOW_ALL, dir);
      expect(await decide(pre('Grep', { pattern: 'MARK', glob }))).toEqual(ALLOW);
      expect(asked).toContainEqual(read(path.join(base, 'excluded target')));
    }
  });

  it('records no allow for a link target, so a later unasked read of it still trips', async () => {
    const dir = await project('stale', { ext: 'stale target' });
    const { gate, decide } = testGate(() => ALLOW_ALL, dir);
    expect(await decide(pre('Grep', { pattern: 'MARK' }))).toEqual(ALLOW);
    const target = path.join(base, 'stale target');
    const ok = { status: 'success', value: {} };
    expect(gate.actedUnasked({ name: 'read', args: { path: target }, result: ok })).toBe(true);
  });

  it('asks for an ignored link that a .ignore file un-ignores', async () => {
    const dir = await project(
      'unignored',
      { hidden: 'hidden target', kept: 'kept target' },
      { '.git/HEAD': '', '.gitignore': 'hidden\nkept\n', '.ignore': '!hidden\n' },
    );
    const { asked, decide } = testGate(() => DENIED, dir);
    expect(await decide(pre('Grep', { pattern: 'MARK' }))).toEqual(deny(DENIED.message));
    expect(asked).toEqual([read(path.join(base, 'hidden target'))]);
  });

  it('asks for a link only the user’s global git ignore hides, which Cursor’s search never reads', async () => {
    const dir = await project('global', { hidden: 'global target' }, { '.git/HEAD': '' });
    const config = path.join(base, 'config home');
    await mkdir(path.join(config, 'git'), { recursive: true });
    await writeFile(path.join(config, 'git', 'ignore'), 'hidden\n');
    vi.stubEnv('HOME', config);
    vi.stubEnv('XDG_CONFIG_HOME', config);
    try {
      const { asked, decide } = testGate(() => DENIED, dir);
      expect(await decide(pre('Grep', { pattern: 'MARK' }))).toEqual(deny(DENIED.message));
      expect(asked).toEqual([read(path.join(base, 'global target'))]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('asks for every place a chain of links reaches, and refuses one that reaches ~/.cursor', async () => {
    const dir = await project('chain', { tools: 'chain first' });
    const kept = await project('chain kept', { tools: 'kept first' });
    await mkdir(path.join(base, 'chain second'));
    await writeFile(path.join(base, 'chain second', 'key.txt'), 'MARK');
    await symlink(path.join(base, 'chain second'), path.join(base, 'chain first', 'cfg'));
    await writeFile(path.join(realHome, '.cursor', 'sdk', 'auth.json'), '{}');
    await symlink(path.join(realHome, '.cursor'), path.join(base, 'kept first', 'cfg'));
    const { asked, decide } = testGate(() => ALLOW_ALL, dir);
    expect(await decide(pre('Grep', { pattern: 'MARK' }))).toEqual(ALLOW);
    expect(asked).toEqual(['chain first', 'chain second'].map((t) => read(path.join(base, t))));
    const second = testGate(() => ALLOW_ALL, kept);
    expect(await second.decide(pre('Grep', { pattern: 'MARK' }))).toEqual(deny(CANT_PATH));
    expect(second.asked).toEqual([]);
  });

  it('refuses a search of a path outside the folder, which Cursor would run over the folder', async () => {
    const dir = await project('clamped', { linked: 'clamped target' });
    const { asked, decide } = testGate(() => ALLOW_ALL, dir);
    for (const file_path of [path.join(base, 'shared'), '../shared', path.join(base, 'nowhere')]) {
      expect(await decide(pre('Grep', { pattern: 'MARK', file_path }))).toEqual(
        deny("Cursor's search only looks inside the chat's folder, so Frink didn't run it."),
      );
    }
    expect(asked).toEqual([]);
  });

  it('skips a listed file that is gone by the time its links are checked', async () => {
    const dir = await project('gone', {});
    const ripgrep = await listing('gone', ['gone.txt', 'in.txt']);
    const { asked, decide } = testGate(() => DENIED, dir, ripgrep);
    expect(await decide(pre('Grep', { pattern: 'MARK' }))).toEqual(ALLOW);
    expect(asked).toEqual([]);
  });

  it('asks nothing for a file listing, which returns names only', async () => {
    const dir = await project('listing', { open: 'listed target' });
    const { asked, decide } = testGate(() => DENIED, dir);
    expect(await decide(pre('Grep', LISTING))).toEqual(ALLOW);
    expect(await decide(pre('Grep', { ...LISTING, glob: '**/out.txt', file_path: dir }))).toEqual(
      ALLOW,
    );
    expect(asked).toEqual([]);
    // Names of the files that match a pattern still come from their contents.
    const matching = { pattern: 'MARK', output_mode: 'files_with_matches' };
    expect(await decide(pre('Grep', matching))).toEqual(deny(DENIED.message));
    expect(asked).toEqual([read(path.join(base, 'listed target'))]);
  });

  it('refuses as before when ripgrep is missing or too slow', async () => {
    const dir = await project('slow', {});
    const slow = path.join(base, 'slow rg');
    await writeFile(slow, '#!/bin/sh\nexec /bin/sleep 30\n');
    await chmod(slow, 0o755);
    for (const ripgrep of [path.join(base, 'no rg'), slow]) {
      const { asked, decide } = testGate(() => ALLOW_ALL, dir, ripgrep);
      expect(await decide(pre('Grep', { pattern: 'MARK' }))).toEqual(deny(UNCHECKED));
      expect(asked).toEqual([]);
    }
  }, 10_000);

  it.runIf(process.platform === 'linux')('refuses a walk through a link into /proc', async () => {
    const dir = await project('proc', {});
    await symlink(`/proc/self/root${shared}`, path.join(dir, 'proc'));
    const { asked, decide } = testGate(() => ALLOW_ALL, dir);
    expect(await decide(pre('Grep', { pattern: 'MARK' }))).toEqual(deny(CANT_PATH));
    expect(asked).toEqual([]);
  });

  it('refuses a walk through a /proc link that Frink itself resolves to nothing', async () => {
    const dir = await project('cwd', {});
    await symlink('/proc/self/cwd/..', path.join(dir, 'up'));
    const ripgrep = await listing('cwd', ['up/sibling/secret.txt']);
    const { asked, decide } = testGate(() => ALLOW_ALL, dir, ripgrep);
    expect(await decide(pre('Grep', { pattern: 'MARK' }))).toEqual(deny(CANT_PATH));
    expect(asked).toEqual([]);
  });

  it('refuses a walk into /dev/fd even when another link reaches a folder above it', async () => {
    const dir = await project('fd', {});
    await symlink('/dev/fd', path.join(dir, 'fds'));
    await symlink(base, path.join(dir, 'above'));
    const opened = await open(path.join(dir, 'in.txt'));
    try {
      const ripgrep = await listing('fd', [`fds/${opened.fd}`, 'above/shared/deep/note.txt']);
      const { asked, decide } = testGate(() => ALLOW_ALL, dir, ripgrep);
      expect(await decide(pre('Grep', { pattern: 'MARK' }))).toEqual(deny(CANT_PATH));
      expect(asked).toEqual([]);
    } finally {
      await opened.close();
    }
  });
});

describe('the path rule', () => {
  const forms = ['file:///x', 'FILE:/x', '~/x', '~', '@x', ' /etc/passwd', 'https://x'];
  const calls = (form: string) => [
    pre('Read', { file_path: form }),
    pre('Write', { file_path: form, content: 'x' }),
    pre('Delete', { file_path: form }),
    pre('Grep', { pattern: 'x', file_path: form }),
    pre('Grep', { pattern: 'x', glob: form }),
    pre('Shell', { command: 'ls', cwd: form }),
  ];

  it.each(forms)('refuses %j before asking anything', async (form) => {
    const { asked, decide } = testGate(() => ALLOW_ALL);
    for (const call of calls(form)) expect(await decide(call)).toEqual(deny(CANT_PATH));
    expect(asked).toEqual([]);
  });
});

describe("Cursor's own files", () => {
  it('refuses reads and writes in the private home', async () => {
    const { asked, decide } = testGate(() => ALLOW_ALL);
    const hooks = path.join(home, '.cursor', 'hooks.json');
    expect(await decide(pre('Read', { file_path: path.join(home, '.zshenv') }))).toEqual(
      deny(CANT_PATH),
    );
    expect(await decide(pre('Write', { file_path: hooks, content: '{}' }))).toEqual(
      deny(CANT_PATH),
    );
    expect(await decide(pre('Delete', { file_path: hooks }))).toEqual(deny(CANT_PATH));
    expect(await decide(pre('Grep', { pattern: 'x', file_path: path.dirname(home) }))).toEqual(
      deny(CANT_PATH),
    );
    expect(asked).toEqual([]);
  });

  it('refuses reads under the real ~/.cursor, even from a chat folder that holds it', async () => {
    const auth = path.join(realHome, '.cursor', 'sdk', 'auth.json');
    for (const folder of [cwd, realHome]) {
      const { asked, decide } = testGate(() => ALLOW_ALL, folder);
      expect(await decide(pre('Read', { file_path: auth }))).toEqual(deny(CANT_PATH));
      expect(await decide(pre('Grep', { pattern: 'key', file_path: realHome }))).toEqual(
        deny(CANT_PATH),
      );
      expect(asked).toEqual([]);
    }
  });

  it('refuses a search of the whole disk, which holds both', async () => {
    const { asked, decide } = testGate(() => ALLOW_ALL);
    expect(await decide(pre('Grep', { pattern: 'key', file_path: '/' }))).toEqual(deny(CANT_PATH));
    expect(await decide(pre('Grep', { pattern: 'key', glob: '/**/auth.json' }))).toEqual(
      deny(CANT_PATH),
    );
    expect(asked).toEqual([]);
  });

  it('refuses a new file reached through a link in the chat folder', async () => {
    const folder = path.join(root, 'linked chat');
    await mkdir(folder);
    await symlink(path.join(realHome, '.cursor'), path.join(folder, 'cursor'));
    const { asked, decide } = testGate(() => ALLOW_ALL, folder);
    expect(await decide(pre('Write', { file_path: 'cursor/hooks.json', content: '{}' }))).toEqual(
      deny(CANT_PATH),
    );
    await writeFile(path.join(realHome, '.cursor', 'sdk', 'auth.json'), '{}');
    expect(await decide(pre('Grep', { pattern: 'key' }))).toEqual(deny(CANT_PATH));
    expect(asked).toEqual([]);
  });

  // macOS spells one folder several ways: through its data volume, and in any letter case.
  it.runIf(process.platform === 'darwin')('refuses every macOS spelling of them', async () => {
    const { asked, decide } = testGate(() => ALLOW_ALL);
    const data = (file: string) => path.join('/System/Volumes/Data', file);
    const auth = data(path.join(realHome, '.cursor', 'sdk', 'auth.json'));
    expect(await decide(pre('Read', { file_path: auth }))).toEqual(deny(CANT_PATH));
    expect(await decide(pre('Grep', { pattern: 'key', file_path: data(realHome) }))).toEqual(
      deny(CANT_PATH),
    );
    for (const file of [
      data(path.join(home, '.zshenv')),
      path.join(realHome, '.CURSOR', 'new.json'),
      path.join(home.toUpperCase(), '.cursor', 'hooks2.json'),
    ]) {
      expect(await decide(pre('Write', { file_path: file, content: '' }))).toEqual(deny(CANT_PATH));
    }
    expect(asked).toEqual([]);
  });

  // Each process reads these its own way, so Frink refuses them rather than judge them.
  it('refuses every process-relative spelling of them', async () => {
    const { asked, decide } = testGate(() => ALLOW_ALL);
    const auth = path.join(realHome, '.cursor', 'sdk', 'auth.json');
    await writeFile(auth, '{}');
    const opened = await open(auth);
    try {
      for (const file of [
        `/proc/self/root${auth}`,
        `/proc/self/fd/${opened.fd}`,
        `/dev/fd/${opened.fd}`,
        `/DEV/fd/${opened.fd}`,
      ]) {
        expect(await decide(pre('Read', { file_path: file }))).toEqual(deny(CANT_PATH));
      }
    } finally {
      await opened.close();
    }
    const zshenv = `/proc/self/root${path.join(home, '.zshenv')}`;
    expect(await decide(pre('Write', { file_path: zshenv, content: '' }))).toEqual(deny(CANT_PATH));
    expect(asked).toEqual([]);
  });

  it('lets Cursor save and read its own image and tool files without a question', async () => {
    const { asked, decide } = testGate(() => DENIED);
    const tools = path.join(home, '.cursor', 'projects', 'p', 'agent-tools', 'out.txt');
    expect(await decide(pre('Write', { file_path: asset, content: '' }, ''))).toEqual(ALLOW);
    expect(await decide(pre('Write', JSON.stringify({ file_path: tools, content: 'x' })))).toEqual(
      ALLOW,
    );
    expect(await decide(pre('Read', { file_path: asset }))).toEqual(ALLOW);
    expect(asked).toEqual([]);
  });

  it('refuses an asset path with a link on the way or a link at the end', async () => {
    const { asked, decide } = testGate(() => ALLOW_ALL);
    const viaLink = path.join(home, '.cursor', 'projects', 'linked', 'assets', 'shot.png');
    const linked = path.join(path.dirname(asset), 'link.png');
    expect(await decide(pre('Write', { file_path: viaLink, content: '' }))).toEqual(
      deny(CANT_PATH),
    );
    expect(await decide(pre('Write', { file_path: linked, content: '' }))).toEqual(deny(CANT_PATH));
    expect(await decide(pre('Read', { file_path: linked }))).toEqual(deny(CANT_PATH));
    expect(asked).toEqual([]);
  });
});

describe('calls Frink cannot check', () => {
  it.each([
    ['an MCP tool', pre('MCP:probe_echo', { text: 'mcp-ran' })],
    ['an MCP resource', pre('FetchMcpResource', { server: 's', uri: 's://r' })],
    ['an MCP call', { ...shellExec('node mcp.mjs', 'u9'), hook_event_name: 'beforeMCPExecution' }],
    ['shell input', pre('WriteShellStdin', { shell_id: '1', length: 3 })],
    ['a notebook edit', pre('EditNotebook', { file_path: 'nb.ipynb', new_string: 'x' })],
    ['a listing', pre('List', { file_path: cwd })],
    ['an unknown tool', pre('Fetch', { url: 'https://example.com' })],
    ['a name inherited from Object', pre('toString', {})],
    ['an extra key', pre('Read', { file_path: 'a.txt', follow: true })],
    ['a key the parse drops', pre('Read', JSON.parse('{"file_path":"a","__proto__":{"x":1}}'))],
    ['input that is not JSON', pre('Write', '{"file_path":')],
    ['a blank command', pre('Shell', { command: '  ', cwd: '' })],
    ['an unknown event', { hook_event_name: 'beforeReadFile', cursor_version: VERSION }],
  ])('refuses %s', async (_name, body) => {
    const { asked, decide } = testGate(() => ALLOW_ALL);
    expect(await decide(body)).toEqual(deny(CANT_CHECK));
    expect(asked).toEqual([]);
  });
});

it('refuses a hook body that is not JSON', async () => {
  const { decideText } = testGate(() => ALLOW_ALL);
  expect(await decideText('{"hook_event_name":')).toEqual(deny(CANT_CHECK));
});

describe('the shell re-check', () => {
  it('allows the paired command with no second question, and asks a fresh one otherwise', async () => {
    const { asked, decide } = testGate(() => ALLOW_ALL);
    expect(await decide(pre('Shell', { command: 'ls', cwd: '', timeout: 1 }, 'u1'))).toEqual(ALLOW);
    expect(await decide(shellExec('ls', 'u1'))).toEqual(ALLOW);
    expect(asked).toEqual([bash('ls')]);
    expect(await decide(shellExec('ls', 'u2'))).toEqual(ALLOW);
    expect(await decide(shellExec('ls; rm x', 'u1'))).toEqual(ALLOW);
    expect(asked).toEqual([bash('ls'), bash('ls'), bash('ls; rm x')]);
  });

  it('pairs only the exact command, and never one started outside the folder', async () => {
    const { asked, decide } = testGate(() => ALLOW_ALL);
    expect(await decide(pre('Shell', { command: 'touch a\\ ', cwd: '' }, 'u1'))).toEqual(ALLOW);
    expect(await decide(shellExec('touch a\\', 'u1'))).toEqual(ALLOW);
    expect(await decide(pre('Shell', { command: 'ls', cwd: '' }, 'u2'))).toEqual(ALLOW);
    expect(await decide({ ...shellExec('ls', 'u2'), cwd: '/' })).toEqual(deny(CANT_PATH));
    expect(asked).toEqual([bash('touch a\\ '), bash('touch a\\'), bash('ls')]);
  });

  it('asks again when the command before it was denied', async () => {
    const { asked, decide } = testGate(() => DENIED);
    expect(await decide(pre('Shell', { command: 'ls', cwd: '' }, 'u1'))).toEqual(
      deny(DENIED.message),
    );
    expect(await decide(shellExec('ls', 'u1'))).toEqual(deny(DENIED.message));
    expect(asked).toEqual([bash('ls'), bash('ls')]);
  });
});

describe('every other answer', () => {
  it('marks the canary on the prompt and lets it through', async () => {
    const { gate, decide } = testGate(() => DENIED);
    expect(gate.canarySeen()).toBe(false);
    expect(await decide(SUBMIT)).toEqual({ continue: true });
    expect(gate.canarySeen()).toBe(true);
  });

  it('denies when checking throws or nobody decides', async () => {
    const throwing = testGate(() => {
      throw new Error('store closed');
    });
    expect(await throwing.decide(pre('Shell', { command: 'ls', cwd: '' }))).toEqual(
      deny("Frink couldn't check this step, so it didn't run."),
    );
    const undecided = testGate(() => ({ allowed: null }));
    expect(await undecided.decide(pre('Shell', { command: 'ls', cwd: '' }))).toEqual(
      deny("Frink couldn't check this step, so it didn't run."),
    );
  });

  it('denies every call once the turn is over, even one asked before it ended', async () => {
    const ended = testGate(() => ALLOW_ALL);
    ended.turn.abort();
    expect(await ended.decide(pre('Read', { file_path: 'a.txt' }))).toEqual(
      deny("This turn has ended, so Frink didn't run this step."),
    );
    const late = testGate(() => {
      late.turn.abort();
      return ALLOW_ALL;
    });
    expect(await late.decide(pre('Shell', { command: 'ls', cwd: '' }))).toEqual(
      deny("This turn has ended, so Frink didn't run this step."),
    );
  });

  it('stops the turn when Cursor speaks a hook version Frink has not tested', async () => {
    const { asked, stops, decide } = testGate(() => ALLOW_ALL);
    const newer = { ...pre('Read', { file_path: 'a.txt' }), cursor_version: '2.0.0' };
    expect(await decide(newer)).toEqual(deny(CHANGED));
    expect(await decide({ ...SUBMIT, cursor_version: '2.0.0' })).toEqual(deny(CHANGED));
    expect(await decide(pre('Read', { file_path: '/etc/hosts' }))).toEqual(deny(CHANGED));
    expect(stops).toEqual([CHANGED, CHANGED, CHANGED]);
    expect(asked).toEqual([]);
  });

  it('denies when stopping the turn throws', async () => {
    const gate = createCursorGate({
      cwd,
      home,
      realHome,
      ripgrep: CURSOR_RIPGREP,
      hookVersions: [VERSION],
      checkApproval: async () => ALLOW_ALL,
      turnOver: new AbortController().signal,
      onStop: () => {
        throw new Error('runner gone');
      },
    });
    const newer = { ...pre('Read', { file_path: 'a.txt' }), cursor_version: '2.0.0' };
    expect(await gate.answer(JSON.stringify(newer))).toEqual(
      deny("Frink couldn't check this step, so it didn't run."),
    );
  });
});

const OK = { status: 'success', value: {} };
const FAILED = { status: 'error', error: { message: 'denied' } };

describe('the stop on an unasked action', () => {
  it('trips on a successful call that was never allowed, but not on one that failed', () => {
    const { gate } = testGate(() => ALLOW_ALL);
    expect(gate.actedUnasked({ name: 'shell', args: { command: 'touch m' }, result: FAILED })).toBe(
      false,
    );
    expect(gate.actedUnasked({ name: 'shell', args: { command: 'touch m' }, result: OK })).toBe(
      true,
    );
  });

  it('uses up one allow per run, so a second identical command trips once', async () => {
    const { gate, decide } = testGate(() => ALLOW_ALL);
    await decide(pre('Shell', { command: 'ls', cwd: '' }));
    const ran = { name: 'shell', args: { command: 'ls', timeout: 30000 }, result: OK };
    expect(gate.actedUnasked(ran)).toBe(false);
    expect(gate.actedUnasked(ran)).toBe(true);
  });

  it('lets an allowed run that failed use up its allow, so a later unasked rerun trips', async () => {
    const { gate, decide } = testGate(() => ALLOW_ALL);
    await decide(pre('Shell', { command: 'rm x', cwd: '' }));
    const call = { name: 'shell', args: { command: 'rm x' } };
    expect(gate.actedUnasked({ ...call, result: FAILED })).toBe(false);
    expect(gate.actedUnasked({ ...call, result: OK })).toBe(true);
  });

  it('matches edits, deletes and outside reads by path', async () => {
    const { gate, decide } = testGate(() => ALLOW_ALL);
    const secret = path.join(outside, 'secret.txt');
    await decide(pre('Write', { file_path: 'a.txt', content: 'x' }));
    await decide(pre('Delete', { file_path: 'b.txt' }));
    await decide(pre('Read', { file_path: secret }));
    await decide(pre('Write', { file_path: asset, content: '' }));
    expect(gate.actedUnasked({ name: 'edit', args: { path: 'a.txt' }, result: OK })).toBe(false);
    expect(gate.actedUnasked({ name: 'delete', args: { path: 'b.txt' }, result: OK })).toBe(false);
    expect(gate.actedUnasked({ name: 'read', args: { path: secret }, result: OK })).toBe(false);
    expect(gate.actedUnasked({ name: 'edit', args: { path: asset }, result: OK })).toBe(false);
    expect(gate.actedUnasked({ name: 'edit', args: { path: 'a.txt' }, result: OK })).toBe(true);
    expect(gate.actedUnasked({ name: 'read', args: { path: secret }, result: OK })).toBe(true);
  });

  it('matches a search whose glob can open an env file, and never trips on a file listing', async () => {
    const { gate, decide } = testGate(() => ALLOW_ALL);
    await decide(pre('Grep', { pattern: 'KEY', file_path: cwd, glob: '*.env' }));
    const ran = { name: 'grep', args: { pattern: 'KEY', path: cwd, glob: '*.env' }, result: OK };
    expect(gate.actedUnasked(ran)).toBe(false);
    expect(gate.actedUnasked(ran)).toBe(true);
    const listed = { globPattern: '**/.env', targetDirectory: cwd };
    expect(gate.actedUnasked({ name: 'glob', args: listed, result: OK })).toBe(false);
  });

  it('never trips on a read, search or lint inside the folder, or on todos', () => {
    const { gate } = testGate(() => ALLOW_ALL);
    const calls: [string, object][] = [
      ['read', { path: 'README.md' }],
      ['grep', { path: cwd, pattern: 'x', offset: 0 }],
      ['grep', { path: cwd, pattern: 'x', glob: '!node_modules' }],
      ['glob', { globPattern: '**/*', targetDirectory: cwd }],
      ['readLints', { paths: ['src/a.ts'] }],
      ['updateTodos', { todos: [] }],
      ['readTodos', {}],
    ];
    for (const [name, args] of calls) {
      expect(gate.actedUnasked({ name, args, result: OK })).toBe(false);
    }
  });

  it('trips on MCP, a searched read outside, and any tool outside the allowlist', () => {
    const { gate } = testGate(() => ALLOW_ALL);
    for (const name of ['mcp', 'webFetch', 'task', 'ls', 'toString']) {
      expect(gate.actedUnasked({ name, args: {}, result: OK })).toBe(true);
    }
    expect(
      gate.actedUnasked({ name: 'grep', args: { path: '/etc', pattern: 'x' }, result: OK }),
    ).toBe(true);
  });

  it('offers Cursor only the tools the gate maps', () => {
    expect(CURSOR_TOOL_NAMES).toEqual([
      'shell',
      'read',
      'edit',
      'delete',
      'grep',
      'glob',
      'readLints',
      'updateTodos',
      'readTodos',
    ]);
  });
});
