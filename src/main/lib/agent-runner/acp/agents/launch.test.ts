import { access, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AI_PROVIDERS } from '../../../../../shared/lib/ai-providers';
import type { Delivery } from '../../../../../shared/lib/ai-providers/capabilities';
import { LoginShellEnvResolver, setLoginShellEnvResolver } from '../../../platform/login-shell-env';
import type { AcpAgentLaunch } from '../acp-process';
import { findAcpAgent, locateAcpAgent, resolveAcpLaunch } from '../index';
import { LAUNCH_ROWS } from './index';
import {
  type AcpLaunchRow,
  findRowBinary,
  launchFromRows,
  locateRowBinary,
  userEnv,
} from './launch';
import { OPENCODE_LAUNCH } from './opencode';

/** Stands in for OpenCode: prints a version, its accounts, and the effective settings with a change. */
const FAKE_OPENCODE = `#!/bin/sh
case "$1" in
  --version) printf '%s\\n' "$FAKE_VERSION"; echo run >> "\${FAKE_LOG:-/dev/null}" ;;
  console) printf '%s\\n' "$FAKE_ORGS" >&2 ;;
  debug) exec '${process.execPath}' "$(dirname "$0")/fake-settings.mjs" ;;
esac
`;
const FAKE_SETTINGS = `
const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT);
const effective = { ...config, mode: {}, plugin: [], command: {}, username: 'someone' };
const edit = process.env.FAKE_EDIT;
if (edit === 'reorder') {
  const { '*': all, ...rest } = config.permission.read;
  effective.permission = { ...config.permission, read: { ...rest, '*': all } };
}
if (edit === 'mcp') effective.mcp = { remote: { type: 'local', command: ['true'] } };
if (edit === 'shell') effective.shell = '/bin/sh';
if (edit === 'plugin') effective.plugin = ['org-plugin'];
if (edit === 'lsp') effective.lsp = { notes: { command: ['true'], extensions: ['.txt'] } };
if (edit === 'formatter') effective.formatter = { notes: { command: ['true'], extensions: ['.txt'] } };
if (edit === 'schema') effective.$schema = 'https://opencode.ai/config.json';
if (edit === 'username') effective.username = 'someone else';
if (edit === 'slow') await new Promise((done) => setTimeout(done, 30_000));
process.stdout.write(edit === 'garbage' ? 'not json' : JSON.stringify(effective));
`;

/** The proven profile: everything asks except reading tools; subagents and questions are off. */
const PROVEN_PERMISSION = {
  '*': 'ask',
  read: { '*': 'allow', '*.env': 'ask', '*.env.*': 'ask', '*.env.example': 'allow' },
  glob: 'allow',
  grep: 'allow',
  list: 'allow',
  skill: 'allow',
  todowrite: 'allow',
  bash: 'ask',
  edit: 'ask',
  webfetch: 'ask',
  websearch: 'ask',
  codesearch: 'ask',
  external_directory: 'ask',
  doom_loop: 'ask',
  task: 'deny',
  question: 'deny',
};

function isRunning(pid: number): boolean {
  try {
    return process.kill(pid, 0);
  } catch {
    return false;
  }
}

// Each check starts Node, which can take seconds on a busy machine.
describe('resolveAcpLaunch for OpenCode', { timeout: 15_000 }, () => {
  let root = '';
  let home = '';
  let project = '';
  let runRoot = '';
  let bin = '';
  const launches: Omit<AcpAgentLaunch, 'cwd'>[] = [];

  beforeEach(async () => {
    // A space in the path, as in macOS's Application Support folder.
    root = await mkdtemp(path.join(os.tmpdir(), 'acp launch '));
    home = path.join(root, 'home');
    project = path.join(root, 'project');
    runRoot = path.join(root, 'run root');
    bin = path.join(root, 'bin');
    for (const dir of [home, project, bin]) await mkdir(dir);
    await writeFile(path.join(bin, 'opencode'), FAKE_OPENCODE, { mode: 0o755 });
    await writeFile(path.join(bin, 'fake-settings.mjs'), FAKE_SETTINGS);
  });
  afterEach(async () => {
    await Promise.all(launches.splice(0).map((launch) => launch.cleanup?.()));
    await rm(root, { recursive: true, force: true });
  });

  function userEnv(extra: Record<string, string> = {}) {
    return {
      PATH: `${bin}${path.delimiter}/usr/bin${path.delimiter}/bin`,
      HOME: home,
      SHELL: '/bin/sh',
      FAKE_VERSION: '1.19.0',
      FAKE_ORGS: 'No accounts found',
      ...extra,
    };
  }

  async function resolve(extra: Record<string, string> = {}, configRoot?: string) {
    const env = userEnv(extra);
    return resolveAcpLaunch('opencode', project, {
      runRoot,
      env,
      configRoot,
      checkTimeoutMs: 5000,
    });
  }

  async function launched(extra: Record<string, string> = {}, configRoot?: string) {
    const result = await resolve(extra, configRoot);
    if (!result.ok) throw new Error(result.reason);
    launches.push(result.launch);
    return result.launch;
  }

  function configOf(launch: Omit<AcpAgentLaunch, 'cwd'>) {
    return JSON.parse(launch.env.OPENCODE_CONFIG_CONTENT ?? '');
  }

  it('starts the absolute binary in ACP mode with the profile, private folders and shell gate', async () => {
    const launch = await launched();
    expect(launch.command).toBe(path.join(bin, 'opencode'));
    expect(launch.signInHint).toBe('opencode auth login');
    expect(launch.args).toEqual(['acp', '--pure', '--hostname', '127.0.0.1', '--port', '0']);
    const runDir = path.dirname(launch.commandLedger ?? '');
    expect(path.dirname(runDir)).toBe(runRoot);
    expect(launch.env).toMatchObject({
      OPENCODE_DISABLE_PROJECT_CONFIG: '1',
      OPENCODE_DISABLE_AUTOUPDATE: '1',
      XDG_CONFIG_HOME: path.join(runDir, 'config'),
      OPENCODE_TEST_HOME: path.join(runDir, 'home'),
    });
    expect(configOf(launch)).toEqual({
      permission: PROVEN_PERMISSION,
      agent: {
        build: { permission: PROVEN_PERMISSION, options: {} },
        plan: { permission: { ...PROVEN_PERMISSION, edit: 'deny' }, options: {} },
      },
      default_agent: 'build',
      share: 'disabled',
      autoupdate: false,
      formatter: false,
      lsp: false,
      experimental: { continue_loop_on_deny: true },
      shell: path.join(runDir, 'shell', 'sh'),
      instructions: [],
      skills: { paths: [] },
    });
    expect((await stat(path.join(runDir, 'shell', 'sh'))).mode & 0o777).toBe(0o700);
    expect(launch.rules.toolQuestions.bash).toBe('Bash');
  });

  it("drops the user's own OpenCode variables and mints a new password each launch", async () => {
    const hostile = { OPENCODE_PERMISSION: '{"*":"allow"}', OPENCODE_CONFIG_DIR: home };
    const first = await launched(hostile);
    const second = await launched(hostile);
    expect(first.env.OPENCODE_PERMISSION).toBeUndefined();
    expect(first.env.OPENCODE_CONFIG_DIR).toBeUndefined();
    expect(first.env.HOME).toBe(home);
    const password = first.env.OPENCODE_SERVER_PASSWORD ?? '';
    expect(password).toMatch(/^[0-9a-f]{64}$/);
    expect(second.env.OPENCODE_SERVER_PASSWORD).not.toBe(password);
    const script = await readFile(configOf(first).shell, 'utf8');
    expect(script).not.toContain(password);
    expect(script).toContain('unset OPENCODE_SERVER_PASSWORD');
  });

  it("puts the user's own values back for commands, instead of the launch's", async () => {
    const launch = await launched({ XDG_CONFIG_HOME: path.join(home, 'my config') });
    const script = await readFile(configOf(launch).shell, 'utf8');
    expect(script).toContain(`export XDG_CONFIG_HOME='${path.join(home, 'my config')}'`);
    expect(script).toContain('unset OPENCODE_CONFIG_CONTENT');
  });

  it.each([
    ['darwin', 'zsh'],
    ['linux', 'bash'],
  ])(
    'runs a fish user’s commands on %s in %s, the shell OpenCode picks',
    async (platform, shell) => {
      const fish = path.join(bin, 'fish');
      await writeFile(fish, '#!/bin/sh\n', { mode: 0o755 });
      const real = process.platform;
      Object.defineProperty(process, 'platform', { value: platform, configurable: true });
      try {
        const gate = configOf(await launched({ SHELL: fish })).shell;
        expect(path.basename(gate)).toBe(shell);
        expect(await readFile(gate, 'utf8')).toMatch(new RegExp(`exec '/\\S*/${shell}' -c "\\$2"`));
      } finally {
        Object.defineProperty(process, 'platform', { value: real, configurable: true });
      }
    },
  );

  it('follows the project instructions, then the user’s own, as OpenCode would', async () => {
    const other = path.join(root, 'config root');
    await mkdir(other);
    await mkdir(path.join(home, '.claude'));
    await writeFile(path.join(project, 'CLAUDE.md'), 'project claude');
    await writeFile(path.join(other, 'AGENTS.md'), 'root agents');
    await writeFile(path.join(other, 'CLAUDE.md'), 'root claude');
    await writeFile(path.join(home, '.claude', 'CLAUDE.md'), 'user claude');
    expect(configOf(await launched()).instructions).toEqual([
      path.join(project, 'CLAUDE.md'),
      path.join(home, '.claude', 'CLAUDE.md'),
    ]);
    const userAgents = path.join(home, '.config', 'opencode', 'AGENTS.md');
    await mkdir(path.dirname(userAgents), { recursive: true });
    await writeFile(userAgents, 'user agents');
    expect(configOf(await launched({}, other)).instructions).toEqual([
      path.join(other, 'AGENTS.md'),
      userAgents,
    ]);
  });

  it("restores the user's own skill folders", async () => {
    await mkdir(path.join(home, '.agents', 'skills'), { recursive: true });
    expect(configOf(await launched()).skills).toEqual({
      paths: [path.join(home, '.agents', 'skills')],
    });
  });

  it('carries the instructions and skills its capability row says OpenCode gets', async () => {
    await writeFile(path.join(project, 'AGENTS.md'), 'project agents');
    await mkdir(path.join(home, '.agents', 'skills'), { recursive: true });
    const config = configOf(await launched());
    const delivery: Delivery = AI_PROVIDERS.opencode.capabilities.delivery;
    expect({
      instructions: config.instructions.length > 0,
      skills: config.skills.paths.length > 0,
    }).toEqual({
      instructions: delivery.instructions !== 'none',
      skills: delivery.skills !== 'none',
    });
  });

  it.each([
    ['1.19.0', true],
    ['1.19.7', true],
    ['1.18.35', false],
    ['1.20.0', false],
    ['opencode v2.0.28', false],
    ['garbage', false],
  ])('version %s may start: %s', async (version, allowed) => {
    const result = await resolve({ FAKE_VERSION: version });
    expect(result.ok).toBe(allowed);
    if (result.ok) launches.push(result.launch);
  });

  it.each([
    ['1.20.0', '1.20.0', 'To use OpenCode in Frink now, go back to OpenCode 1.19.'],
    ['opencode v2.0.29', '2.0.29', 'To use OpenCode in Frink now, go back to OpenCode 1.19.'],
    ['2.0.29', '2.0.29', 'To use OpenCode in Frink now, go back to OpenCode 1.19.'],
    ['1.18.9', '1.18.9', 'Update OpenCode, then try again.'],
  ])('names the unchecked version %s and how to fix it', async (printed, version, fix) => {
    expect(await resolve({ FAKE_VERSION: printed })).toEqual({
      ok: false,
      reason: `Frink has checked OpenCode 1.19. You have ${version}, which Frink hasn't checked yet. ${fix}`,
    });
  });

  it.each(['garbage', ''])('explains a version it cannot read: %j', async (printed) => {
    expect(await resolve({ FAKE_VERSION: printed })).toEqual({
      ok: false,
      reason: "Frink couldn't tell which version of OpenCode you have, so it didn't start it.",
    });
  });

  it('never runs a project-local copy from a relative PATH entry', async () => {
    const local = path.join(project, 'node_modules', '.bin');
    await mkdir(local, { recursive: true });
    await writeFile(path.join(local, 'opencode'), FAKE_OPENCODE, { mode: 0o755 });
    const result = await resolveAcpLaunch('opencode', project, {
      runRoot,
      // Relative to the test's own folder, so the entry would really resolve if it were used.
      env: {
        ...userEnv(),
        PATH: `${path.relative(process.cwd(), local)}${path.delimiter}/usr/bin`,
      },
    });
    expect(result).toEqual({
      ok: false,
      reason:
        "Frink can't find OpenCode on this computer. Install it with npm install -g opencode-ai@1.19, then try again.",
    });
  });

  it('finds OpenCode in its own install folder when it is not on PATH', async () => {
    const installed = path.join(home, '.opencode', 'bin');
    await mkdir(installed, { recursive: true });
    await writeFile(path.join(installed, 'opencode'), FAKE_OPENCODE, { mode: 0o755 });
    await writeFile(path.join(installed, 'fake-settings.mjs'), FAKE_SETTINGS);
    const launch = await launched({ PATH: '/usr/bin' });
    expect(launch.command).toBe(path.join(installed, 'opencode'));
  });

  it.each(['', 'username'])(
    'runs when the effective settings match the launch (%s)',
    async (edit) => {
      expect((await resolve({ FAKE_EDIT: edit })).ok).toBe(true);
    },
  );

  it.each(['reorder', 'mcp', 'shell', 'plugin', 'lsp', 'formatter', 'schema'])(
    'refuses when merged settings change the rules (%s)',
    async (edit) => {
      expect(await resolve({ FAKE_EDIT: edit })).toEqual({
        ok: false,
        reason:
          "Settings from an organisation, sign-in provider or administrator can change how OpenCode asks for permission, so Frink can't run it safely.",
      });
    },
  );

  it('refuses while OpenCode is signed in to an organisation account', async () => {
    expect(await resolve({ FAKE_ORGS: 'Acme (me@example.com) (active)' })).toMatchObject({
      ok: false,
      reason: expect.stringContaining('Settings from an organisation'),
    });
  });

  it.each(['garbage', 'slow'])('refuses when the settings cannot be read (%s)', async (edit) => {
    expect(await resolve({ FAKE_EDIT: edit })).toEqual({
      ok: false,
      reason: "Frink couldn't check OpenCode's settings, so it didn't start it.",
    });
  });

  it('gives each launch a fresh folder and removes it, and a refused one, afterwards', async () => {
    const first = await launched();
    const second = await launched();
    expect(first.commandLedger).not.toBe(second.commandLedger);
    await first.cleanup?.();
    await expect(access(path.dirname(first.commandLedger ?? ''))).rejects.toThrow();
    await resolve({ FAKE_EDIT: 'mcp' });
    expect(await readdir(runRoot)).toEqual([
      path.basename(path.dirname(second.commandLedger ?? '')),
    ]);
  });

  it("removes a previous run's leftover folders at the first launch", async () => {
    const planted = path.join(runRoot, 'old', 'config', 'opencode', 'tool');
    await mkdir(planted, { recursive: true });
    await writeFile(path.join(planted, 'evil.ts'), 'export default {}');
    const launch = await launched();
    expect(await readdir(runRoot)).toEqual([
      path.basename(path.dirname(launch.commandLedger ?? '')),
    ]);
  });

  it('finds the installed agent and its version without starting a launch', async () => {
    const env = userEnv();
    const found = { path: path.join(bin, 'opencode'), version: '1.19.0' };
    expect(await findRowBinary([OPENCODE_LAUNCH], env)).toEqual(found);
    expect(await locateRowBinary(OPENCODE_LAUNCH, env)).toBe(found.path);
    expect(await findRowBinary([OPENCODE_LAUNCH], { ...env, FAKE_VERSION: '1.20.0' })).toEqual({
      reason:
        "Frink has checked OpenCode 1.19. You have 1.20.0, which Frink hasn't checked yet. To use OpenCode in Frink now, go back to OpenCode 1.19.",
    });
    const missing = { ...env, PATH: '/usr/bin' };
    expect(await locateRowBinary(OPENCODE_LAUNCH, missing)).toBeUndefined();
    expect(await findRowBinary([OPENCODE_LAUNCH], missing)).toEqual({
      reason:
        "Frink can't find OpenCode on this computer. Install it with npm install -g opencode-ai@1.19, then try again.",
      missing: true,
    });
  });

  /** Two versions of one agent; each records when its settings are built and its check runs. */
  function versionRows(ran: string[]): AcpLaunchRow[] {
    const row = (floor: string, below: string): AcpLaunchRow => ({
      ...OPENCODE_LAUNCH,
      versions: { floor, below },
      settings: async (context) => {
        ran.push(`${floor} settings`);
        const { env } = await OPENCODE_LAUNCH.settings(context);
        const passes = () => {
          ran.push(`${floor} check`);
          return true;
        };
        return { env, checks: [{ args: ['console', 'orgs'], passes }] };
      },
    });
    return [row('1.19.0', '1.20.0'), row('2.0.29', '2.1.0')];
  }

  it.each([
    ['1.19.4', '1.19.0'],
    ['opencode v2.0.29', '2.0.29'],
    ['2.0.31', '2.0.29'],
  ])(
    'starts version %s with the row that holds it, reading the version once',
    async (printed, floor) => {
      const ran: string[] = [];
      const log = path.join(root, 'version runs');
      const env = userEnv({ FAKE_VERSION: printed, FAKE_LOG: log });
      const result = await launchFromRows(versionRows(ran), project, { runRoot, env });
      if (result.ok) launches.push(result.launch);
      expect(result.ok).toBe(true);
      expect(ran).toEqual([`${floor} settings`, `${floor} check`]);
      expect(await readFile(log, 'utf8')).toBe('run\n');
    },
  );

  it.each([
    ['2.1.0', 'To use OpenCode in Frink now, go back to OpenCode 2.0.'],
    ['1.20.0', 'Update OpenCode, then try again.'],
    ['1.18.9', 'Update OpenCode, then try again.'],
  ])(
    'names every checked version when no row holds %s, before any settings',
    async (version, fix) => {
      const ran: string[] = [];
      const env = userEnv({ FAKE_VERSION: version });
      expect(await launchFromRows(versionRows(ran), project, { runRoot, env })).toEqual({
        ok: false,
        reason: `Frink has checked OpenCode 1.19 and 2.0.29 and later 2.0 releases. You have ${version}, which Frink hasn't checked yet. ${fix}`,
      });
      expect(ran).toEqual([]);
      await expect(access(runRoot)).rejects.toThrow();
    },
  );

  it('stops a hung check and the program it started when its time is up', async () => {
    const childPid = path.join(root, 'child pid');
    // Like npm's loader, the check waits on the real program it started.
    const hung = `#!/bin/sh\nsleep 30 &\necho $! > "${childPid}"\nwait\n`;
    await writeFile(path.join(bin, 'opencode'), hung, { mode: 0o755 });
    const options = { runRoot, env: userEnv(), checkTimeoutMs: 1000 };
    expect(await launchFromRows([OPENCODE_LAUNCH], project, options)).toEqual({
      ok: false,
      reason: "Frink couldn't tell which version of OpenCode you have, so it didn't start it.",
    });
    const pid = Number(await readFile(childPid, 'utf8'));
    await expect.poll(() => isRunning(pid)).toBe(false);
  });

  it('stops a check that prints without end long before its time is up', async () => {
    await writeFile(path.join(bin, 'opencode'), '#!/bin/sh\nexec yes\n', { mode: 0o755 });
    const options = { runRoot, env: userEnv(), checkTimeoutMs: 60_000 };
    expect(await launchFromRows([OPENCODE_LAUNCH], project, options)).toEqual({
      ok: false,
      reason: "Frink couldn't tell which version of OpenCode you have, so it didn't start it.",
    });
  });

  it('finds a version any row holds', async () => {
    const env = userEnv({ FAKE_VERSION: '2.0.30' });
    expect(await findRowBinary(versionRows([]), env)).toEqual({
      path: path.join(bin, 'opencode'),
      version: '2.0.30',
    });
  });

  it('starts every version of an agent from the same install, read the same way', () => {
    const shared = ({
      name,
      binary,
      fallbacks,
      versionPattern,
      installHint,
      envPrefix,
    }: AcpLaunchRow) => ({ name, binary, fallbacks, versionPattern, installHint, envPrefix });
    for (const rows of LAUNCH_ROWS.values()) {
      for (const row of rows) expect(shared(row)).toEqual(shared(rows[0]));
    }
  });

  it("lists an agent's checked versions oldest first, with no version in two rows", () => {
    const rank = (version: string) => {
      expect(version).toMatch(/^\d+\.\d+\.\d+$/);
      return version.split('.').reduce((total, part) => total * 1000 + Number(part), 0);
    };
    for (const rows of LAUNCH_ROWS.values()) {
      rows.forEach(({ versions }, index) => {
        expect(rank(versions.floor)).toBeLessThan(rank(versions.below));
        if (index)
          expect(rank(rows[index - 1].versions.below)).toBeLessThanOrEqual(rank(versions.floor));
      });
    }
  });

  it('refuses an agent it has no launch for', async () => {
    for (const id of ['copilot', 'grok', 'constructor']) {
      expect(await resolveAcpLaunch(id, project, { runRoot })).toEqual({
        ok: false,
        reason: "Frink can't start this agent yet.",
      });
      expect(await findAcpAgent(id)).toEqual({ reason: "Frink can't start this agent yet." });
      expect(await locateAcpAgent(id)).toBeUndefined();
    }
  });
});

describe('userEnv', () => {
  const desktop = {
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
    XDG_RUNTIME_DIR: '/run/user/1000',
    DISPLAY: ':0',
    WAYLAND_DISPLAY: 'wayland-0',
  };

  async function loginShellPrints(env: Record<string, string>) {
    const resolver = new LoginShellEnvResolver({
      spawnShell: async () => ({ ok: true, env }),
      extendPath: (current) => current ?? '',
    });
    setLoginShellEnvResolver(resolver);
    await resolver.resolve();
  }

  beforeEach(() => vi.stubEnv('PATH', '/usr/bin:/bin'));
  afterEach(() => vi.unstubAllEnvs());

  it("keeps the desktop session's keyring connection, which a login shell never sets", async () => {
    for (const [key, value] of Object.entries(desktop)) vi.stubEnv(key, value);
    await loginShellPrints({ PATH: '/login/bin', HOME: '/home/someone' });
    expect(await userEnv()).toEqual({
      ...desktop,
      PATH: '/login/bin:/usr/bin:/bin',
      HOME: '/home/someone',
    });
  });

  it("prefers the login shell's own value, and adds nothing the session lacks", async () => {
    for (const key of Object.keys(desktop)) vi.stubEnv(key, undefined);
    vi.stubEnv('DISPLAY', ':0');
    await loginShellPrints({ PATH: '/login/bin', DISPLAY: ':1' });
    expect(await userEnv()).toEqual({ PATH: '/login/bin:/usr/bin:/bin', DISPLAY: ':1' });
  });
});
