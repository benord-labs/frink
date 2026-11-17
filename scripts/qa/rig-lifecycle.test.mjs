import { spawn } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';

const qaDir = import.meta.dirname;
const REAL_SCRIPTS = ['boot.sh', 'env.sh', 'scrub-host-env.sh'];
// Everything boot.sh calls but these tests do not exercise. The electron stub records its pid in
// $HOME/launched; asked to, it exits on its own with a code.
const STUBS = {
  'scripts/qa/use-fake-claude.sh': 'exit 0\n',
  'scripts/binaries/ensure-electron-binary.mjs': `import { writeFileSync } from 'node:fs';
writeFileSync(process.env.HOME + '/prelaunch', '');
await new Promise((r) => setTimeout(r, Number(process.env.QA_TEST_PRELAUNCH_MS ?? 0)));
`,
  'node_modules/.bin/electron': `#!/usr/bin/env node
require('node:fs').writeFileSync(process.env.HOME + '/launched', String(process.pid));
if (process.env.QA_TEST_APP_EXIT) setTimeout(() => process.exit(Number(process.env.QA_TEST_APP_EXIT)), 200);
setInterval(() => {}, 1000);
`,
  'out-qa/main/index.js': '// built\n',
  // boot.sh links the menu bar icons in beside the bundled CLIs the real build puts here.
  'out-qa/main/resources/bin/.keep': '',
};

const rigs = [];
afterEach(() => {
  for (const rig of rigs.splice(0)) disposeRig(rig);
});

/** A throwaway checkout and $HOME: the real boot.sh around the stubs above. */
function makeRig(extraEnv = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'qa rig lifecycle-')));
  const repo = join(root, 'repo');
  const home = join(root, 'home');
  mkdirSync(home);
  for (const [path, body] of Object.entries(STUBS)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), body, { mode: 0o755 });
  }
  for (const name of REAL_SCRIPTS) copyFileSync(join(qaDir, name), join(repo, 'scripts/qa', name));
  const env = { ...process.env, HOME: home };
  delete env.QA_REAL_CLAUDE;
  delete env.FRINK_QA_PORT;
  const rig = { root, repo, home, env: { ...env, ...extraEnv } };
  rigs.push(rig);
  return rig;
}

function disposeRig(rig) {
  rig.boot?.kill('SIGKILL');
  const app = launchedPid(rig);
  if (app && isAlive(app)) process.kill(app, 'SIGKILL');
  rmSync(rig.root, { recursive: true, force: true });
}

function startBoot(rig) {
  const boot = spawn('bash', [join(rig.repo, 'scripts/qa/boot.sh')], {
    env: rig.env,
    stdio: 'ignore',
  });
  boot.exited = new Promise((resolve) => boot.on('exit', (code) => resolve(code)));
  rig.boot = boot;
  return boot;
}

const bootLock = (rig) => join(rig.home, 'Library/Application Support/Frink Dev-21399/boot.lock');
const claimed = (rig) => {
  try {
    return lstatSync(bootLock(rig)).isSymbolicLink();
  } catch {
    return false;
  }
};

function launchedPid(rig) {
  try {
    return Number(readFileSync(join(rig.home, 'launched'), 'utf-8'));
  } catch {
    return null;
  }
}

function isAlive(pid) {
  try {
    return process.kill(pid, 0);
  } catch {
    return false;
  }
}

async function until(check, ms = 10_000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) if (check()) return;
  throw new Error(`condition not met within ${ms} ms`);
}

// env.sh refuses anything but macOS, so these run where the rig itself runs.
describe.runIf(process.platform === 'darwin')('QA rig boot.sh lifecycle', () => {
  it('passes a stop on to the app and exits once the app has', async () => {
    const rig = makeRig();
    const boot = startBoot(rig);
    await until(() => launchedPid(rig) !== null);
    const app = launchedPid(rig);
    boot.kill('SIGTERM');
    expect(await boot.exited).toBe(143);
    expect(isAlive(app)).toBe(false);
    expect(claimed(rig)).toBe(false);
  }, 30_000);

  it('refuses a second boot of an instance that is already running', async () => {
    const rig = makeRig();
    startBoot(rig);
    await until(() => launchedPid(rig) !== null);
    const app = launchedPid(rig);
    const second = spawn('bash', [join(rig.repo, 'scripts/qa/boot.sh')], { env: rig.env });
    let stderr = '';
    second.stderr.on('data', (chunk) => (stderr += chunk));
    expect(await new Promise((resolve) => second.on('exit', resolve))).toBe(1);
    expect(stderr).toContain('is already running');
    expect(isAlive(app)).toBe(true);
    expect(claimed(rig)).toBe(true);
  }, 30_000);

  it('takes over a claim left by a boot.sh that no longer runs', async () => {
    const rig = makeRig();
    mkdirSync(dirname(bootLock(rig)), { recursive: true });
    symlinkSync('999999:Thu Jan 1 00:00:00 1970', bootLock(rig));
    startBoot(rig);
    await until(() => launchedPid(rig) !== null);
    expect(readlinkSync(bootLock(rig))).toMatch(new RegExp(`^${rig.boot.pid}:`));
  }, 30_000);

  it('never starts the app when the stop lands before the launch', async () => {
    const rig = makeRig({ QA_TEST_PRELAUNCH_MS: '1500' });
    const boot = startBoot(rig);
    await until(() => existsSync(join(rig.home, 'prelaunch')));
    boot.kill('SIGTERM');
    expect(await boot.exited).toBe(143);
    expect(launchedPid(rig)).toBeNull();
  }, 30_000);

  it("exits with the app's own code when the app ends by itself", async () => {
    const rig = makeRig({ QA_TEST_APP_EXIT: '7' });
    expect(await startBoot(rig).exited).toBe(7);
  }, 30_000);
});
