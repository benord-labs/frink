import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { COPILOT_TOOLS, findCopilotAgent, locateCopilotAgent, resolveCopilotLaunch } from './index';

/** Stands in for the Copilot CLI: prints its version line, but only to a stripped environment. */
const FAKE_COPILOT = `#!/bin/sh
[ "$1" = --version ] && [ -z "$COPILOT_ALLOW_ALL" ] && printf '%s\\n' "$FAKE_VERSION" "Run 'copilot update' to check for updates."
`;
const MISSING =
  "Frink can't find GitHub Copilot on this computer. Install it with npm install -g @github/copilot, then try again.";

describe('resolveCopilotLaunch', () => {
  let root = '';
  let home = '';
  let bin = '';
  let configDirectory = '';

  beforeEach(async () => {
    // A space in the path, as in macOS's Application Support folder.
    root = await mkdtemp(path.join(os.tmpdir(), 'copilot launch '));
    home = path.join(root, 'home');
    bin = path.join(root, 'bin');
    configDirectory = path.join(root, 'app data', 'copilot', 'config');
    for (const dir of [home, bin]) await mkdir(dir);
    await writeFile(path.join(bin, 'copilot'), FAKE_COPILOT, { mode: 0o755 });
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  function userEnv(extra: Record<string, string> = {}) {
    return {
      PATH: `${bin}${path.delimiter}/usr/bin${path.delimiter}/bin`,
      HOME: home,
      FAKE_VERSION: 'GitHub Copilot CLI 1.0.96.',
      ...extra,
    };
  }

  const resolve = (extra: Record<string, string> = {}) =>
    resolveCopilotLaunch({ env: userEnv(extra), configDirectory });

  it('starts the installed CLI with its remote features off, Frink’s folder and tool list', async () => {
    expect(await resolve()).toEqual({
      ok: true,
      launch: {
        command: path.join(bin, 'copilot'),
        args: ['--disable-builtin-mcps', '--no-remote', '--no-remote-export'],
        env: { ...userEnv(), COPILOT_DISABLE_LOGIN_SHELL_ENV: '1' },
        configDirectory,
        tools: COPILOT_TOOLS,
        versions: { floor: '1.0.96', below: '1.1.0' },
      },
    });
  });

  it('drops every Copilot variable except the user’s own sign-in routes', async () => {
    const result = await resolve({
      COPILOT_ALLOW_ALL: 'true',
      COPILOT_NEW_ALLOW: '1',
      COPILOT_PROVIDER_BASE_URL: 'http://127.0.0.1:9',
      COPILOT_DISABLE_LOGIN_SHELL_ENV: '0',
      COPILOT_GITHUB_TOKEN: 'the-users-own',
      COPILOT_HOME: path.join(home, 'copilot home'),
    });
    if (!result.ok) throw new Error(result.reason);
    const copilotKeys = Object.keys(result.launch.env).filter((key) => key.startsWith('COPILOT_'));
    expect(copilotKeys.sort()).toEqual([
      'COPILOT_DISABLE_LOGIN_SHELL_ENV',
      'COPILOT_GITHUB_TOKEN',
      'COPILOT_HOME',
    ]);
    expect(result.launch.env.COPILOT_DISABLE_LOGIN_SHELL_ENV).toBe('1');
  });

  it.each([
    ['GitHub Copilot CLI 1.0.96.', true],
    ['GitHub Copilot CLI 1.0.120.', true],
    ['GitHub Copilot CLI 1.0.95.', false],
    ['GitHub Copilot CLI 1.1.0.', false],
    ['1.0.96', false],
    ['Copilot 1.0.96', false],
  ])('version line %s may start: %s', async (version, allowed) => {
    expect((await resolve({ FAKE_VERSION: version })).ok).toBe(allowed);
  });

  it('explains a version Frink has not checked, and one it cannot read', async () => {
    const refused = (version: string) => ({
      ok: false,
      reason: `Frink has checked GitHub Copilot 1.0.96 and later 1.0 releases. You have ${version}, which Frink hasn't checked yet.`,
    });
    for (const version of ['1.1.0', '1.0.95']) {
      expect(await resolve({ FAKE_VERSION: `GitHub Copilot CLI ${version}.` })).toEqual(
        refused(version),
      );
    }
    expect(await resolve({ FAKE_VERSION: 'garbage' })).toEqual({
      ok: false,
      reason:
        "Frink couldn't tell which version of GitHub Copilot you have, so it didn't start it.",
    });
  });

  it('finds the CLI in ~/.local/bin when it is not on PATH, and never on a relative entry', async () => {
    const local = path.join(home, '.local', 'bin');
    await mkdir(local, { recursive: true });
    await writeFile(path.join(local, 'copilot'), FAKE_COPILOT, { mode: 0o755 });
    const relative = path.relative(process.cwd(), bin);
    const result = await resolve({ PATH: `${relative}${path.delimiter}/usr/bin` });
    expect(result).toMatchObject({ ok: true, launch: { command: path.join(local, 'copilot') } });
    await rm(local, { recursive: true });
    expect(await resolve({ PATH: `${relative}${path.delimiter}/usr/bin` })).toEqual({
      ok: false,
      reason: MISSING,
    });
  });

  it('starts an npm install through its link, never the script it points at', async () => {
    // npm links `copilot` to a `.js` loader; given that path, the SDK would run it with Frink itself.
    const npmBin = path.join(root, 'npm', 'bin');
    const loader = path.join(root, 'npm', 'lib', 'npm-loader.js');
    await mkdir(npmBin, { recursive: true });
    await mkdir(path.dirname(loader));
    await writeFile(loader, FAKE_COPILOT, { mode: 0o755 });
    await symlink(loader, path.join(npmBin, 'copilot'));
    const result = await resolve({ PATH: `${npmBin}${path.delimiter}/usr/bin` });
    expect(result).toMatchObject({ ok: true, launch: { command: path.join(npmBin, 'copilot') } });
  });

  it('finds the installed CLI and its version with the same stripped environment', async () => {
    const env = userEnv({ COPILOT_ALLOW_ALL: 'true' });
    const found = { path: path.join(bin, 'copilot'), version: '1.0.96' };
    expect(await findCopilotAgent(env)).toEqual(found);
    expect(await locateCopilotAgent(env)).toBe(found.path);
    const missing = { ...env, PATH: '/usr/bin' };
    expect(await locateCopilotAgent(missing)).toBeUndefined();
    expect(await findCopilotAgent(missing)).toMatchObject({ reason: MISSING });
  });
});
