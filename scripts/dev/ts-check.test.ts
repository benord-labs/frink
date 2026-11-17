import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { main, PROJECTS, runProject, runTsCheck } from './ts-check.mjs';

const REPO_ROOT = resolve(__dirname, '../..');
const RUNNER = resolve(__dirname, 'ts-check.mjs');
const TSCONFIG = JSON.stringify({
  compilerOptions: { strict: true, noEmit: true },
  include: ['src/**/*'],
});

type Outcome = { ok: boolean; reason: string };

function runWith(outcomes: Record<string, Outcome>) {
  const ran: string[] = [];
  const result = runTsCheck({
    root: '/repo',
    run: (project: { name: string }) => {
      ran.push(project.name);
      return outcomes[project.name] ?? { ok: true, reason: 'passed' };
    },
  });
  return { ran, ...result };
}

describe('runTsCheck', () => {
  const allProjects = PROJECTS.map((project) => project.name);

  it('passes when every project passes', () => {
    const { ran, exitCode } = runWith({});
    expect(ran).toEqual(allProjects);
    expect(exitCode).toBe(0);
  });

  it('still runs the later projects when the first one fails', () => {
    const { ran, exitCode, results } = runWith({
      root: { ok: false, reason: 'exit 1' },
    });
    expect(ran).toEqual(allProjects);
    expect(exitCode).toBe(1);
    expect(results.map((result) => result.ok)).toEqual([false, true, true]);
  });

  it('fails when only the last project fails', () => {
    const last = allProjects[allProjects.length - 1];
    expect(runWith({ [last]: { ok: false, reason: 'exit 2' } }).exitCode).toBe(1);
  });

  it('counts a killed or unspawnable compiler as a failure', () => {
    expect(runWith({ relay: { ok: false, reason: 'killed by SIGKILL' } }).exitCode).toBe(1);
    expect(runWith({ relay: { ok: false, reason: 'spawn ENOENT' } }).exitCode).toBe(1);
  });
});

describe('runProject', () => {
  type SpawnResult = { status: number | null; signal?: string; error?: Error };

  function runWithSpawn(result: SpawnResult, project = PROJECTS[1]) {
    const calls: Array<{ command: string; args: string[]; options: { cwd: string } }> = [];
    const outcome = runProject(project, '/repo', (command, args, options) => {
      calls.push({ command, args, options });
      return result;
    });
    return { outcome, call: calls[0] };
  }

  it('passes only on a zero exit', () => {
    expect(runWithSpawn({ status: 0 }).outcome.ok).toBe(true);
    expect(runWithSpawn({ status: 1 }).outcome).toEqual({ ok: false, reason: 'exit 1' });
    expect(runWithSpawn({ status: 2 }).outcome).toEqual({ ok: false, reason: 'exit 2' });
  });

  // A compiler the OS killed (out of memory on a small runner) has no exit status to trust.
  it('fails a compiler that was killed by a signal', () => {
    expect(runWithSpawn({ status: null, signal: 'SIGKILL' }).outcome).toEqual({
      ok: false,
      reason: 'killed by SIGKILL',
    });
  });

  it('fails a compiler that could not be started, whatever status came back', () => {
    const error = new Error('spawn ENOENT');
    expect(runWithSpawn({ status: 0, error }).outcome).toEqual({
      ok: false,
      reason: 'spawn ENOENT',
    });
  });

  it('runs the native compiler by explicit path from the root, without emitting', () => {
    const { call } = runWithSpawn({ status: 0 });
    expect(call.command).toBe(process.execPath);
    expect(call.args[0]).toMatch(/@typescript[\\/]native[\\/]bin[\\/]tsc$/);
    expect(call.args.slice(1)).toEqual(['--noEmit', '-p', 'relay/tsconfig.test.json']);
    expect(call.options.cwd).toBe('/repo');
  });

  it('lets tsc find the root project itself', () => {
    expect(runWithSpawn({ status: 0 }, PROJECTS[0]).call.args.slice(1)).toEqual(['--noEmit']);
  });
});

describe('main', () => {
  function runMain(argv: string[], failing: string[] = []) {
    const roots: string[] = [];
    const lines: string[] = [];
    const exitCode = main(['node', 'ts-check.mjs', ...argv], {
      run: (project: { name: string }, root: string) => {
        roots.push(root);
        return failing.includes(project.name)
          ? { ok: false, reason: 'exit 1' }
          : { ok: true, reason: 'passed' };
      },
      log: (line: string) => lines.push(line),
    });
    return { roots, lines, exitCode };
  }

  it('checks the repo this script lives in by default, wherever it is run from', () => {
    const { roots, exitCode } = runMain([]);
    expect(roots.map((root) => resolve(root))).toEqual(PROJECTS.map(() => REPO_ROOT));
    expect(exitCode).toBe(0);
  });

  it('checks the directory given after --root', () => {
    expect(runMain(['--root', '/elsewhere']).roots).toEqual(PROJECTS.map(() => '/elsewhere'));
  });

  it('reports every project and returns 1 when one fails', () => {
    const { lines, exitCode } = runMain([], ['relay']);
    expect(exitCode).toBe(1);
    expect(lines).toEqual([
      '[ts:check] root: passed',
      '[ts:check] relay: failed (exit 1)',
      '[ts:check] live-activity-forwarder: passed',
    ]);
  });
});

describe('ts:check wiring', () => {
  it('is the script package.json runs', () => {
    const { scripts } = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
    expect(scripts['ts:check']).toBe('node ./scripts/dev/ts-check.mjs');
    expect(scripts['prets:check']).toBe('node ./scripts/dev/ensure-package-deps.mjs');
  });

  it('checks projects that exist', () => {
    const tsconfigs = PROJECTS.map((project) => project.tsconfig ?? 'tsconfig.json');
    expect(tsconfigs).toEqual([
      'tsconfig.json',
      'relay/tsconfig.test.json',
      'live-activity-forwarder/tsconfig.json',
    ]);
    for (const tsconfig of tsconfigs) expect(existsSync(join(REPO_ROOT, tsconfig))).toBe(true);
  });
});

describe('ts:check against the real compiler', () => {
  let fixture: string | undefined;

  afterEach(() => {
    if (fixture) rmSync(fixture, { recursive: true, force: true });
    fixture = undefined;
  });

  function writeFixture(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), 'ts-check-'));
    for (const [file, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), content);
    }
    return root;
  }

  function runCli(root: string, runner = RUNNER) {
    const result = spawnSync(process.execPath, [runner, '--root', root], {
      encoding: 'utf8',
    });
    return {
      status: result.status,
      output: `${result.stdout}\n${result.stderr}`,
    };
  }

  it('prints the errors of every failing project and exits non-zero', () => {
    fixture = writeFixture({
      'tsconfig.json': TSCONFIG,
      'src/a.ts': 'export const a: number = "one";\n',
      'relay/tsconfig.test.json': TSCONFIG,
      'relay/src/b.ts': 'export const b: string = 2;\n',
      'live-activity-forwarder/tsconfig.json': TSCONFIG,
      'live-activity-forwarder/src/c.ts': 'export const c = 3;\n',
    });

    const { status, output } = runCli(fixture);

    expect(status).toBe(1);
    expect(output).toMatch(/^src\/a\.ts\(\d+,\d+\): error TS2322: /m);
    expect(output).toMatch(/^relay\/src\/b\.ts\(\d+,\d+\): error TS2322: /m);
    expect(output).toContain('[ts:check] root: failed (exit ');
    expect(output).toContain('[ts:check] relay: failed (exit ');
    expect(output).toContain('[ts:check] live-activity-forwarder: passed');
    // The result lines must never read as diagnostics to whatever parses the output.
    const diagnostics = output.split('\n').filter((line) => /\(\d+,\d+\): error TS\d+/.test(line));
    expect(diagnostics.filter((line) => line.includes('[ts:check]'))).toEqual([]);
    expect(diagnostics).toHaveLength(2);
  }, 60_000);

  // Node reports the entry script by its real path, so a naive argv comparison skips the whole
  // check and exits 0 when the runner is reached through a link.
  it.skipIf(process.platform === 'win32')(
    'still checks when the runner is reached through a symlink',
    () => {
      fixture = writeFixture({
        'tsconfig.json': TSCONFIG,
        'src/a.ts': 'export const a: number = "one";\n',
      });
      const linked = join(fixture, 'linked-ts-check.mjs');
      symlinkSync(RUNNER, linked);

      const { status, output } = runCli(fixture, linked);

      expect(status).toBe(1);
      expect(output).toMatch(/^src\/a\.ts\(\d+,\d+\): error TS2322: /m);
    },
    60_000,
  );

  it('fails every project when the root does not exist', () => {
    const { status, output } = runCli(join(tmpdir(), 'ts-check-no-such-root'));

    expect(status).toBe(1);
    for (const project of PROJECTS) {
      expect(output).toContain(`[ts:check] ${project.name}: failed (`);
    }
  }, 60_000);

  it('passes when no project has an error', () => {
    fixture = writeFixture({
      'tsconfig.json': TSCONFIG,
      'src/a.ts': 'export const a = 1;\n',
      'relay/tsconfig.test.json': TSCONFIG,
      'relay/src/b.ts': 'export const b = 2;\n',
      'live-activity-forwarder/tsconfig.json': TSCONFIG,
      'live-activity-forwarder/src/c.ts': 'export const c = 3;\n',
    });

    const { status, output } = runCli(fixture);

    expect(status).toBe(0);
    expect(output).not.toMatch(/error TS\d+/);
  }, 60_000);

  it('fails when a project is missing instead of skipping it', () => {
    fixture = writeFixture({
      'tsconfig.json': TSCONFIG,
      'src/a.ts': 'export const a = 1;\n',
    });

    const { status, output } = runCli(fixture);

    expect(status).toBe(1);
    expect(output).toContain('[ts:check] root: passed');
    expect(output).toContain('[ts:check] relay: failed (exit ');
  }, 60_000);
});
