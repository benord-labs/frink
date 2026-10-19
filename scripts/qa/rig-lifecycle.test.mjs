import { spawn } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';

const qaDir = import.meta.dirname;
const REAL_SCRIPTS = ['boot.sh', 'stop.sh', 'smoke.sh', 'env.sh', 'scrub-host-env.sh'];
// Everything the scripts call but these tests do not exercise. The electron stub, once its signal
// handling is set, records its pid in $HOME/launched; asked to, it ignores SIGTERM like a hung app.
const STUBS = {
  'scripts/qa/use-fake-claude.sh': 'exit 0\n',
  'scripts/qa/seed.sh': 'exit 0\n',
  'scripts/binaries/ensure-electron-binary.mjs':
    'await new Promise((r) => setTimeout(r, Number(process.env.QA_TEST_PRELAUNCH_MS ?? 0)));\n',
  'node_modules/.bin/electron': `#!/usr/bin/env node
if (process.env.QA_TEST_APP_IGNORES_TERM) process.on('SIGTERM', () => {});
require('node:fs').writeFileSync(process.env.HOME + '/launched', String(process.pid));
setInterval(() => {}, 1000);
`,
  'out-qa/main/index.js': '// built\n',
  // Stands in for smoke-check.ts: once the app is up, prints QA_TEST_CHECKS_OUTPUT and exits with
  // QA_TEST_CHECKS_EXIT (default 0, a pass).
  'bin/bun': `#!/bin/bash
for _ in $(seq 1 200); do [ -f "$HOME/launched" ] && break; sleep 0.05; done
[ -f "$HOME/launched" ] || exit 1
[ -z "\${QA_TEST_CHECKS_OUTPUT:-}" ] || echo "$QA_TEST_CHECKS_OUTPUT"
exit "\${QA_TEST_CHECKS_EXIT:-0}"
`,
};

const rigs = [];
afterEach(() => {
  for (const rig of rigs.splice(0)) disposeRig(rig);
});

/** A throwaway checkout and $HOME: the real boot, stop and smoke scripts around the stubs above. */
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
  const env = { ...process.env, HOME: home, PATH: `${join(repo, 'bin')}:${process.env.PATH}` };
  delete env.QA_REAL_CLAUDE;
  const rig = { root, repo, home, lock: join(home, '.frink-qa', 'lock.d'), boots: [] };
  rig.env = { ...env, ...extraEnv };
  rigs.push(rig);
  return rig;
}

function disposeRig(rig) {
  for (const boot of rig.boots) boot.kill('SIGKILL');
  const app = launchedPid(rig);
  if (app && isAlive(app)) process.kill(app, 'SIGKILL');
  rmSync(rig.root, { recursive: true, force: true });
}

function startBoot(rig) {
  const boot = spawn('bash', [join(rig.repo, 'scripts/qa/boot.sh')], {
    env: rig.env,
    stdio: 'ignore',
  });
  boot.exited = new Promise((resolve) => boot.on('exit', resolve));
  rig.boots.push(boot);
  return boot;
}

function runScript(rig, name, args = []) {
  return new Promise((resolve) => {
    const child = spawn('bash', [join(rig.repo, 'scripts/qa', name), ...args], { env: rig.env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

function readPid(path) {
  try {
    return Number(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

const lockPid = (rig, name = 'pid') => readPid(join(rig.lock, name));
const launchedPid = (rig) => readPid(join(rig.home, 'launched'));

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

async function bootedRig(extraEnv) {
  const rig = makeRig(extraEnv);
  const boot = startBoot(rig);
  await until(() => launchedPid(rig) !== null);
  return { rig, boot, app: launchedPid(rig) };
}

it('smoke never spends the operator quota on a health check', () => {
  // An inherited QA_REAL_CLAUDE=1 would route the smoke run's sends through the real CLI.
  expect(readFileSync(join(qaDir, 'smoke.sh'), 'utf-8')).toContain('env -u QA_REAL_CLAUDE');
});

// env.sh refuses anything but macOS, so these run where the rig itself runs.
describe.runIf(process.platform === 'darwin')('QA rig stop and smoke', () => {
  it('stops the app through boot.sh, which frees the lock, and exits 0', async () => {
    const { rig, boot, app } = await bootedRig();
    const stop = await runScript(rig, 'stop.sh');
    expect(stop.status, stop.stderr).toBe(0);
    expect(stop.stdout).toContain('qa stop: stopped');
    await boot.exited;
    expect(isAlive(app)).toBe(false);
    expect(existsSync(rig.lock)).toBe(false);
  }, 30_000);

  it('kills an app that ignores SIGTERM after 10 s, and still frees the lock', async () => {
    const { rig, app } = await bootedRig({ QA_TEST_APP_IGNORES_TERM: '1' });
    const stop = await runScript(rig, 'stop.sh');
    expect(stop.status, stop.stderr).toBe(0);
    expect(stop.stderr).toContain('did not exit within 10 s');
    expect(isAlive(app)).toBe(false);
    expect(existsSync(rig.lock)).toBe(false);
  }, 40_000);

  it('ends a boot.sh stopped before its launch without ever starting the app', async () => {
    const rig = makeRig({ QA_TEST_PRELAUNCH_MS: '1500' });
    const boot = startBoot(rig);
    await until(() => lockPid(rig) === boot.pid);
    const stop = await runScript(rig, 'stop.sh');
    expect(stop.stdout).toContain('qa stop: stopped');
    await boot.exited;
    expect(launchedPid(rig)).toBeNull();
    expect(existsSync(rig.lock)).toBe(false);
  }, 30_000);

  it('stops an app whose boot.sh was killed, instead of reporting nothing running', async () => {
    const { rig, boot, app } = await bootedRig();
    boot.kill('SIGKILL');
    await boot.exited;
    const stop = await runScript(rig, 'stop.sh');
    expect(stop.stdout).toContain('qa stop: stopped');
    expect(isAlive(app)).toBe(false);
    expect(existsSync(rig.lock)).toBe(false);
  }, 30_000);

  it('clears a stale lock without signalling a process that has since taken its pids', async () => {
    const rig = makeRig();
    // Its command line names both rig paths, as an editor or an agent's shell wrapper could.
    const unrelated = spawn(process.execPath, [
      '-e',
      'setInterval(() => {}, 1000)',
      'scripts/qa/boot.sh',
      'out-qa/main/index.js',
    ]);
    try {
      mkdirSync(rig.lock, { recursive: true });
      for (const name of ['pid', 'app-pid']) {
        writeFileSync(join(rig.lock, name), String(unrelated.pid));
        writeFileSync(join(rig.lock, `${name}.start`), 'Thu Jan  1 00:00:00 1970');
      }
      const stop = await runScript(rig, 'stop.sh');
      expect(stop.status, stop.stderr).toBe(0);
      expect(stop.stdout).toContain('qa stop: not running');
      expect(isAlive(unrelated.pid)).toBe(true);
      expect(existsSync(rig.lock)).toBe(false);
    } finally {
      unrelated.kill('SIGKILL');
    }
  });

  it("given another run's boot pid, leaves the rig alone", async () => {
    const { rig, boot, app } = await bootedRig();
    const stop = await runScript(rig, 'stop.sh', ['1']);
    expect(stop.stdout).toContain('left it alone');
    expect(isAlive(app)).toBe(true);
    expect(lockPid(rig)).toBe(boot.pid);
  }, 30_000);

  it('smoke passes, then stops the app its own boot.sh launched', async () => {
    const rig = makeRig();
    const smoke = await runScript(rig, 'smoke.sh');
    expect(smoke.stdout, smoke.stderr).toContain('qa smoke: PASS');
    const app = launchedPid(rig);
    expect(app).not.toBeNull();
    await until(() => !isAlive(app) && !existsSync(rig.lock));
  }, 30_000);

  it('smoke prints the first failure, or a crash, as one FAIL line and exits 1', async () => {
    const failing = makeRig({
      QA_TEST_CHECKS_EXIT: '1',
      QA_TEST_CHECKS_OUTPUT: 'no chat composer on screen',
    });
    const failed = await runScript(failing, 'smoke.sh');
    expect(failed.status).toBe(1);
    expect(failed.stdout).toContain(
      'qa smoke: FAIL — no chat composer on screen (all of it in checks.log)',
    );
    const unbuilt = makeRig();
    rmSync(join(unbuilt.repo, 'out-qa'), { recursive: true });
    const notBuilt = await runScript(unbuilt, 'smoke.sh');
    expect(notBuilt.status).toBe(1);
    expect(notBuilt.stdout).toContain('qa smoke: FAIL — not built');
  }, 30_000);

  it('smoke fails, and leaves the app alone, when another run takes the rig first', async () => {
    const { rig, boot, app } = await bootedRig();
    const smoke = await runScript(rig, 'smoke.sh');
    expect(smoke.status).toBe(1);
    expect(smoke.stdout).toContain('FAIL — boot.sh did not take the rig: frink QA already running');
    expect(isAlive(app)).toBe(true);
    expect(lockPid(rig)).toBe(boot.pid);
  }, 30_000);
});
