import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AcpAgentLaunch } from '../acp-process';
import { launchFromRows } from './launch';
import { OPENCODE_LAUNCH } from './opencode';
import { OPENCODE2_LAUNCH, openCode2Checks } from './opencode2';

/** Stands in for OpenCode 2: prints a version, its sign-ins and its settings sources with a change. */
const FAKE_OPENCODE = `#!/bin/sh
case "$1" in
  --version) printf '%s\\n' "$FAKE_VERSION" ;;
  auth) printf '%s\\n' "\${FAKE_SIGNINS:-[]}" ;;
  api) printf '{"data":%s}\\n' "\${FAKE_SAVED:-[]}" ;;
  debug) exec '${process.execPath}' "$(dirname "$0")/fake-sources.mjs" ;;
esac
`;
const FAKE_SOURCES = `
const content = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT);
const sources = [
  { type: 'directory', path: process.env.XDG_CONFIG_HOME + '/opencode' },
  { type: 'document', info: content },
];
const edit = process.env.FAKE_EDIT;
if (edit === 'remote') sources.unshift({ type: 'document', info: { share: 'manual' } });
if (edit === 'admin') sources.push({ type: 'directory', path: process.env.HOME });
if (edit === 'file') sources[1].path = process.env.HOME + '/opencode.json';
if (edit === 'folder') sources[0].path = process.env.HOME;
if (edit === 'shell') content.shell = '/bin/sh';
if (edit === 'reorder') content.permissions.reverse();
process.stdout.write(edit === 'garbage' ? 'not json' : JSON.stringify(sources));
`;
const UNSAFE =
  "Settings from an organisation, sign-in provider or administrator can change how OpenCode asks for permission, so Frink can't run it safely.";

const rule = (action: string, effect: string, resource = '*') => ({ action, resource, effect });
/** Everything asks except reading tools; environment files ask; subagents, questions and Code Mode are off. */
const RULES = [
  rule('*', 'ask'),
  rule('read', 'allow'),
  rule('read', 'ask', '*.env'),
  rule('read', 'ask', '*.env.*'),
  rule('read', 'allow', '*.env.example'),
  ...['glob', 'grep', 'list', 'skill', 'todowrite'].map((action) => rule(action, 'allow')),
  ...[
    'shell',
    'edit',
    'webfetch',
    'websearch',
    'codesearch',
    'external_directory',
    'doom_loop',
  ].map((action) => rule(action, 'ask')),
  rule('subagent', 'deny'),
  rule('question', 'deny'),
  rule('execute', 'deny'),
];

describe('the OpenCode 2 launch', { timeout: 15_000 }, () => {
  let root = '';
  let bin = '';
  const launches: Omit<AcpAgentLaunch, 'cwd'>[] = [];

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'acp opencode2 '));
    bin = path.join(root, 'bin');
    for (const dir of [bin, path.join(root, 'home'), path.join(root, 'project')]) await mkdir(dir);
    await writeFile(path.join(bin, 'opencode'), FAKE_OPENCODE, { mode: 0o755 });
    await writeFile(path.join(bin, 'fake-sources.mjs'), FAKE_SOURCES);
    vi.stubEnv('FRINK_HOME', path.join(root, 'frink'));
  });
  afterEach(async () => {
    await Promise.all(launches.splice(0).map((launch) => launch.cleanup?.()));
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  async function resolve(extra: Record<string, string> = {}, rows = [OPENCODE2_LAUNCH]) {
    const env = {
      PATH: `${bin}${path.delimiter}/usr/bin${path.delimiter}/bin`,
      HOME: path.join(root, 'home'),
      SHELL: '/bin/sh',
      FAKE_VERSION: 'opencode v2.0.29',
      ...extra,
    };
    const runRoot = path.join(root, 'run root');
    const result = await launchFromRows(rows, path.join(root, 'project'), { runRoot, env });
    if (result.ok) launches.push(result.launch);
    return result;
  }

  it('starts `opencode acp` with its own settings, folders and a data folder only Frink uses', async () => {
    await writeFile(path.join(root, 'project', 'AGENTS.md'), 'House rules\n');
    const result = await resolve();
    if (!result.ok) throw new Error(result.reason);
    const { args, env, signInHint, commandLedger } = result.launch;
    const runDir = path.dirname(commandLedger ?? '');
    const data = path.join(root, 'frink', '.frink', 'opencode', 'data');
    expect(args).toEqual(['acp']);
    expect(signInHint).toBe(
      'XDG_DATA_HOME=$HOME/.frink/opencode/data opencode auth login --standalone',
    );
    expect(env).toMatchObject({
      OPENCODE_DISABLE_PROJECT_CONFIG: '1',
      OPENCODE_DISABLE_AUTOUPDATE: '1',
      OPENCODE_DISABLE_FILEWATCHER: '1',
      XDG_CONFIG_HOME: path.join(runDir, 'config'),
      OPENCODE_TEST_HOME: path.join(runDir, 'home'),
      XDG_DATA_HOME: data,
    });
    expect(env.OPENCODE_SERVER_PASSWORD).toBeUndefined();
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? '')).toEqual({
      permissions: RULES,
      agents: {
        build: { permissions: RULES },
        plan: { permissions: RULES.map((r) => (r.action === 'edit' ? rule('edit', 'deny') : r)) },
      },
      default_agent: 'build',
      share: 'disabled',
      update: 'disable',
      formatter: false,
      lsp: false,
      shell: path.join(runDir, 'shell', 'sh'),
      skills: [],
    });
    const configDir = path.join(runDir, 'config', 'opencode');
    expect(await readFile(path.join(configDir, 'service.json'), 'utf8')).toBe('{"disabled":true}');
    expect(await readFile(path.join(configDir, 'AGENTS.md'), 'utf8')).toBe('House rules\n');
    expect((await stat(data)).mode & 0o777).toBe(0o700);
  });

  it.each([
    ['a sign-in source sends settings, live or kept from before', { FAKE_EDIT: 'remote' }],
    ['an administrator folder is read', { FAKE_EDIT: 'admin' }],
    ['the content comes from a file', { FAKE_EDIT: 'file' }],
    ['another folder is the settings folder', { FAKE_EDIT: 'folder' }],
    ['a setting differs', { FAKE_EDIT: 'shell' }],
    ['the rules are in another order', { FAKE_EDIT: 'reorder' }],
    ['a sign-in is named by a web address', { FAKE_SIGNINS: '[{"id":"https://ai.example.com"}]' }],
    ['the sign-ins cannot be read', { FAKE_SIGNINS: '{"id":"openrouter"}' }],
  ])('refuses to start when %s', async (_, extra) => {
    expect(await resolve(extra)).toEqual({ ok: false, reason: UNSAFE });
  });

  it('refuses to start while OpenCode keeps an "Always allow" answer in Frink’s folder', async () => {
    const data = path.join(root, 'frink', '.frink', 'opencode', 'data');
    expect(await resolve({ FAKE_SAVED: '[{"id":"per_1"}]' })).toEqual({
      ok: false,
      reason: `OpenCode has saved "Always allow" answers in the folder Frink keeps for it, so it wouldn't ask Frink first. Delete ${data}, then try again.`,
    });
  });

  it('starts when the user signed in to a provider of their own', async () => {
    const result = await resolve({ FAKE_SIGNINS: '[{"id":"openrouter","connections":[]}]' });
    expect(result.ok).toBe(true);
  });

  it('refuses to start when it cannot read the settings sources', async () => {
    expect(await resolve({ FAKE_EDIT: 'garbage' })).toEqual({
      ok: false,
      reason: "Frink couldn't check OpenCode's settings, so it didn't start it.",
    });
  });

  it('refuses when an administrator settings file is present, whatever the sources say', async () => {
    const configDir = path.join(root, 'config');
    await mkdir(configDir);
    const sources = JSON.stringify([
      { type: 'directory', path: configDir },
      { type: 'document', info: { share: 'disabled' } },
    ]);
    const passes = (managed: string[]) =>
      openCode2Checks(configDir, '{"share":"disabled"}', root, managed)[0]?.passes({
        stdout: sources,
        stderr: '',
      });
    expect(passes([path.join(root, 'absent')])).toBe(true);
    expect(passes([path.join(root, 'home')])).toBe(false);
  });

  it('is picked by its version beside the 1.19 row, which names a newer one as unchecked', async () => {
    const rows = [OPENCODE_LAUNCH, OPENCODE2_LAUNCH];
    expect(await resolve({}, rows)).toMatchObject({ ok: true, launch: { args: ['acp'] } });
    expect(await resolve({ FAKE_VERSION: 'opencode v2.1.0' }, rows)).toEqual({
      ok: false,
      reason:
        "Frink has checked OpenCode 1.19 and 2.0.29 and later 2.0 releases. You have 2.1.0, which Frink hasn't checked yet. To use OpenCode in Frink now, go back to OpenCode 2.0.",
    });
  });
});
