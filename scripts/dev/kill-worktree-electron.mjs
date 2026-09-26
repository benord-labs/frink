#!/usr/bin/env node
/**
 * Kill Electron processes whose argv references a Frink git worktree under
 * ~/.frink/worktrees/frink/<name>/... (bare default_app Electron windows).
 *
 * Uses ps(1) with -ww (full argv) + optional lsof(8) cwd when argv omits the
 * worktree path, then kill in a short loop — more reliable than a single
 * pkill when helpers respawn or PPID is launchd (1).
 * Never kills the main Frink dev app (command line contains "Frink Dev").
 * Matches electron-vite (argv often has no capital "Electron").
 *
 * Does **not** stop main-checkout `bun dev` (paths like …/Personal and learning/frink/).
 * Only targets ~/.frink/worktrees/frink/<name>/.
 *
 * Safe for your code: does not remove worktrees or delete files.
 */
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

/** First column from `ps -o pid=,command=` */
const PS_PID_LINE = /^\s*(\d+)\s+/;
/** Match bare Electron binary name in argv (not every string containing "Electron") */
const ELECTRON_BINARY = /[/\s]Electron(\s|$)/;
/** Frink worktree root segment — argv or cwd (allow non-.frink-expanded paths) */
function pathLooksLikeFrinkWorktree(s) {
  return s.includes('.frink/worktrees/frink/') || s.includes('/worktrees/frink/');
}

function extractPid(line) {
  const m = line.match(PS_PID_LINE);
  return m ? Number(m[1]) : null;
}

/** cwd for PID (macOS/BSD); null if unavailable */
function getPidCwd(pid) {
  const { stdout = '', status } = spawnSync(
    'lsof',
    ['-n', '-a', '-p', String(pid), '-d', 'cwd', '-Fn'],
    { encoding: 'utf8' },
  );
  if (status !== 0) return null;
  for (const line of stdout.split('\n')) {
    if (line.startsWith('n')) return line.slice(1);
  }
  return null;
}

const LSREGISTER =
  '/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister';

/** Unregister worktree Electron.app(s) from macOS Launch Services so the
 *  frink-dev:// protocol routes to the main Frink Dev app, not a bare shell. */
function unregisterWorktreeElectronApps() {
  if (process.platform !== 'darwin') return;

  const home = process.env.HOME ?? '';
  const worktreeRoot = `${home}/.frink/worktrees/frink`;
  const { stdout = '' } = spawnSync(
    'find',
    [worktreeRoot, '-path', '*/electron/dist/Electron.app', '-maxdepth', 6],
    {
      encoding: 'utf8',
    },
  );
  const apps = stdout.split('\n').filter(Boolean);
  for (const app of apps) {
    const { status } = spawnSync(LSREGISTER, ['-u', app], { encoding: 'utf8' });
    if (status === 0) {
      console.log(`Unregistered from Launch Services: ${app}`);
    }
  }
}

function isElectronStackLine(line) {
  const l = line.toLowerCase();
  return (
    line.includes('Electron.app') ||
    line.includes('Electron Helper') ||
    l.includes('electron-vite') ||
    line.includes('node_modules/electron') ||
    line.includes('electron/cli.js') ||
    line.includes('.bin/electron') ||
    line.includes('default_app.asar') ||
    ELECTRON_BINARY.test(line)
  );
}

function collectWorktreeElectronPids() {
  const { stdout = '', status } = spawnSync('ps', ['-ax', '-ww', '-o', 'pid=,command='], {
    encoding: 'utf8',
  });
  if (status !== 0) {
    return { pids: [], hintMainDev: false };
  }

  const lines = stdout.split('\n');
  const pids = new Set();

  for (const line of lines) {
    if (!pathLooksLikeFrinkWorktree(line)) continue;
    if (!isElectronStackLine(line)) continue;
    if (line.includes('Frink Dev')) continue;
    const pid = extractPid(line);
    if (pid) pids.add(pid);
  }

  // argv may omit ~/.frink/... (short path, cwd launch); cwd still points at worktree
  for (const line of lines) {
    if (line.includes('Frink Dev')) continue;
    if (!isElectronStackLine(line)) continue;
    if (pathLooksLikeFrinkWorktree(line)) continue;
    const pid = extractPid(line);
    if (!pid || pids.has(pid)) continue;
    const cwd = getPidCwd(pid);
    if (cwd && pathLooksLikeFrinkWorktree(cwd)) {
      pids.add(pid);
    }
  }

  const out = [...pids].sort((a, b) => b - a);

  const hintMainDev =
    out.length === 0 &&
    lines.some(
      (line) =>
        !line.includes('Frink Dev') &&
        line.toLowerCase().includes('electron-vite') &&
        isElectronStackLine(line) &&
        !pathLooksLikeFrinkWorktree(line),
    );

  return { pids: out, hintMainDev };
}

async function main() {
  if (process.platform === 'win32') {
    console.error('kill-worktree-electron: not implemented on Windows.');
    process.exit(0);
  }

  const maxRounds = Math.min(
    20,
    Math.max(1, parseInt(process.env.KILL_WORKTREE_ROUNDS ?? '5', 10) || 5),
  );
  const delayMs = Math.min(
    2000,
    Math.max(50, parseInt(process.env.KILL_WORKTREE_DELAY_MS ?? '250', 10) || 250),
  );
  const force = process.argv.includes('--force');

  let totalKilled = 0;
  for (let round = 1; round <= maxRounds; round++) {
    const { pids, hintMainDev } = collectWorktreeElectronPids();

    if (pids.length === 0) {
      if (round === 1) {
        console.log('No processes under ~/.frink/worktrees/frink/ (nothing to kill here).');
        if (hintMainDev) {
          console.log(
            'Main checkout electron-vite is running (e.g. bun dev) — expected. Stop it with Ctrl+C in that terminal; this script does not kill main-repo dev.',
          );
        } else {
          console.log(
            'If a stray default Electron window remains from a worktree, open it then run this again.',
          );
        }
      } else {
        console.log(`Stopped after ${round - 1} round(s); no matching PIDs left.`);
      }
      unregisterWorktreeElectronApps();
      process.exit(0);
    }

    console.log(
      `Round ${round}: sending ${force ? 'SIGKILL' : 'SIGTERM then SIGKILL'} to PIDs ${pids.join(', ')}`,
    );

    for (const pid of pids) {
      try {
        process.kill(pid, force ? 'SIGKILL' : 'SIGTERM');
        totalKilled += 1;
      } catch {
        /* ESRCH etc. */
      }
    }

    if (!force) {
      for (const pid of pids) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* ESRCH */
        }
      }
    }

    if (round < maxRounds) await delay(delayMs);
  }

  const { pids: leftover } = collectWorktreeElectronPids();

  if (leftover.length > 0) {
    console.error(
      `Still see ${leftover.length} matching PID(s): ${leftover.join(', ')}. Try: KILL_WORKTREE_ROUNDS=10 bun run kill:worktree-electron -- --force`,
    );
    process.exit(1);
  }

  unregisterWorktreeElectronApps();
  console.log(`Done. Signaled ${totalKilled} process(es). Worktree files unchanged.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
