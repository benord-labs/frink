import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Guards .github/workflows/build-desktop.yml: each OS packages as soon as its OWN Codex build
// finishes. `needs` waits for every leg of a matrix, so the Codex and packaging work must stay one
// job per OS, each `build-<os>` needing only `codex-native-<os>`, with the step lists shared through
// one anchor each so the per-OS jobs cannot drift. Plain text parsing, like the sibling
// deterministic-quality-gates test: no YAML library is a declared dependency here.

const WORKFLOW_PATH = resolve(__dirname, '../../.github/workflows/build-desktop.yml');

type Job = { key: string; lines: string[] };

function jobsOf(workflow: string): Job[] {
  const lines = workflow.replace(/\r\n/g, '\n').split('\n');
  const start = lines.indexOf('jobs:');
  if (start === -1) return [];
  const jobs: Job[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    const key = /^ {2}([\w-]+):\s*$/.exec(line)?.[1];
    if (key) jobs.push({ key, lines: [] });
    else jobs.at(-1)?.lines.push(line);
  }
  return jobs;
}

const field = (job: Job, name: string) =>
  job.lines.map((line) => new RegExp(`^ {4}${name}:\\s*(.*)$`).exec(line)?.[1]).find(Boolean);

/** platformKey values of the job's matrix rows only — a step or env line of the same name is not a row. */
function platformKeys(job: Job): string[] {
  const start = job.lines.findIndex((line) => /^ {6}matrix:\s*$/.test(line));
  if (start === -1) return [];
  const rest = job.lines.slice(start + 1);
  const end = rest.findIndex((line) => /^ {0,6}\S/.test(line));
  return rest
    .slice(0, end === -1 ? undefined : end)
    .flatMap((line) => /^\s+(?:- )?platformKey:\s*(\S+)/.exec(line)?.[1] ?? []);
}

/** Every way the workflow can stop an OS from packaging as soon as its own Codex build ends. */
function perOsProblems(workflow: string): string[] {
  const jobs = jobsOf(workflow);
  const byKey = new Map(jobs.map((job) => [job.key, job]));
  const problems: string[] = [];

  const builds = jobs.filter((job) => job.key.startsWith('build-'));
  if (builds.length === 0) problems.push('no per-OS build-<os> packaging jobs');

  for (const job of jobs.filter(
    (j) => j.key.startsWith('build') || j.key.startsWith('codex-native'),
  )) {
    if (job.key === 'codex-native-mac') continue;
    const keys = platformKeys(job);
    if (keys.length !== 1)
      problems.push(
        `${job.key} builds ${keys.length} platforms; a dependant would wait for all of them`,
      );
  }

  for (const build of builds) {
    const os = build.key.slice('build-'.length);
    const codexKey = `codex-native-${os}`;
    const needs = field(build, 'needs');
    if (needs !== codexKey)
      problems.push(`${build.key} needs "${needs ?? ''}" instead of only ${codexKey}`);
    if (!byKey.has(codexKey)) problems.push(`${build.key} has no ${codexKey} job to package from`);
    for (const job of [build, byKey.get(codexKey)]) {
      const keys = job ? platformKeys(job) : [];
      if (job && keys.length === 1 && keys[0] !== os)
        problems.push(`${job.key} builds platformKey ${keys[0]}, not ${os}`);
    }
  }

  // The reverse contract: a per-OS Codex build nothing packages is a dropped OS. Mac releases build
  // Codex locally, so codex-native-mac alone has no packaging job.
  for (const codex of jobs.filter((j) => j.key.startsWith('codex-native-'))) {
    const os = codex.key.slice('codex-native-'.length);
    if (os !== 'mac' && !byKey.has(`build-${os}`))
      problems.push(`${codex.key} has no build-${os} job packaging it`);
  }

  const sharedSteps = (prefix: string, anchor: string) => {
    const group = jobs.filter((job) => job.key.startsWith(prefix));
    const steps = group.map((job) => field(job, 'steps'));
    if (group.length > 0 && steps.filter((s) => s === `&${anchor}`).length !== 1) {
      problems.push(`exactly one ${prefix}* job must define steps: &${anchor}`);
    }
    group.forEach((job, i) => {
      if (steps[i] !== `&${anchor}` && steps[i] !== `*${anchor}`) {
        problems.push(`${job.key} does not share the ${anchor} step list`);
      }
    });
  };
  sharedSteps('build-', 'build-steps');
  sharedSteps('codex-native-', 'codex-native-steps');

  return problems;
}

const job = (key: string, body: string) => `  ${key}:\n${body}`;
const codex = (os: string, steps: string) =>
  job(
    `codex-native-${os}`,
    `    strategy:\n      matrix:\n        include:\n          - os: runner\n            platformKey: ${os}\n    steps: ${steps}\n`,
  );
const build = (os: string, needs: string, steps: string) =>
  job(
    `build-${os}`,
    `    needs: ${needs}\n    strategy:\n      matrix:\n        include:\n          - os: runner\n            platformKey: ${os}\n    steps: ${steps}\n`,
  );
const workflowOf = (...jobs: string[]) => `name: Build Desktop\n\njobs:\n${jobs.join('\n')}`;

const GOOD = workflowOf(
  codex('win32-x64', '&codex-native-steps\n      - run: build'),
  codex('linux-x64', '*codex-native-steps'),
  build('win32-x64', 'codex-native-win32-x64', '&build-steps\n      - run: package'),
  build('linux-x64', 'codex-native-linux-x64', '*build-steps'),
);

describe('build-desktop.yml per-OS packaging', () => {
  it('lets every OS package as soon as its own Codex build finishes', () => {
    expect(perOsProblems(readFileSync(WORKFLOW_PATH, 'utf8'))).toEqual([]);
  });
});

describe('perOsProblems', () => {
  it('accepts per-OS jobs sharing one step list each', () => {
    expect(perOsProblems(GOOD)).toEqual([]);
  });

  it('accepts CRLF line endings from a Windows checkout', () => {
    expect(perOsProblems(GOOD.replace(/\n/g, '\r\n'))).toEqual([]);
  });

  // The shape this workflow had before: packaging needed the whole Codex matrix.
  it('flags packaging that needs a multi-platform Codex matrix', () => {
    const matrix = workflowOf(
      job(
        'codex-native',
        '    strategy:\n      matrix:\n        include:\n          - platformKey: win32-x64\n          - platformKey: linux-x64\n          - platformKey: linux-arm64\n    steps: &codex-native-steps\n      - run: build\n',
      ),
      job(
        'build',
        '    needs: codex-native\n    strategy:\n      matrix:\n        include:\n          - platformKey: win32-x64\n          - platformKey: linux-x64\n    steps:\n      - run: package\n',
      ),
    );
    expect(perOsProblems(matrix)).toEqual([
      'no per-OS build-<os> packaging jobs',
      'codex-native builds 3 platforms; a dependant would wait for all of them',
      'build builds 2 platforms; a dependant would wait for all of them',
    ]);
  });

  it('flags a packaging job wired to another OS Codex job', () => {
    const crossed = GOOD.replace('needs: codex-native-linux-x64', 'needs: codex-native-win32-x64');
    expect(perOsProblems(crossed)).toEqual([
      'build-linux-x64 needs "codex-native-win32-x64" instead of only codex-native-linux-x64',
    ]);
  });

  it('flags a packaging job that waits on every Codex job again', () => {
    const all = GOOD.replace(
      'needs: codex-native-linux-x64',
      'needs: [codex-native-win32-x64, codex-native-linux-x64]',
    );
    expect(perOsProblems(all)).toHaveLength(1);
  });

  it('flags a per-OS packaging job that grew a second matrix row', () => {
    const twoRows = GOOD.replace(
      'platformKey: linux-x64\n    steps: *build-steps',
      'platformKey: linux-x64\n          - os: runner\n            platformKey: linux-arm64\n    steps: *build-steps',
    );
    expect(perOsProblems(twoRows)).toEqual([
      'build-linux-x64 builds 2 platforms; a dependant would wait for all of them',
    ]);
  });

  it('does not take a step or env platformKey for a matrix row', () => {
    const noRow = GOOD.replace(
      '          - os: runner\n            platformKey: linux-x64\n    steps: *build-steps',
      '          - os: runner\n    steps: *build-steps\n    env:\n      platformKey: linux-x64\n',
    );
    expect(perOsProblems(noRow)).toEqual([
      'build-linux-x64 builds 0 platforms; a dependant would wait for all of them',
    ]);
  });

  it('flags a Codex job whose OS lost its packaging job', () => {
    const dropped = workflowOf(
      GOOD.split('jobs:\n')[1],
      codex('linux-arm64', '*codex-native-steps'),
    );
    expect(perOsProblems(dropped)).toEqual([
      'codex-native-linux-arm64 has no build-linux-arm64 job packaging it',
    ]);
  });

  it('flags a new OS packaging job without its own Codex job', () => {
    const orphan = workflowOf(
      GOOD.split('jobs:\n')[1],
      build('linux-arm64', 'codex-native-linux-x64', '*build-steps'),
    );
    expect(perOsProblems(orphan)).toEqual([
      'build-linux-arm64 needs "codex-native-linux-x64" instead of only codex-native-linux-arm64',
      'build-linux-arm64 has no codex-native-linux-arm64 job to package from',
    ]);
  });

  it('flags a job whose row builds a different platform than its name', () => {
    const swapped = GOOD.replace(
      'platformKey: linux-x64\n    steps: *build-steps',
      'platformKey: linux-arm64\n    steps: *build-steps',
    );
    expect(perOsProblems(swapped)).toEqual([
      'build-linux-x64 builds platformKey linux-arm64, not linux-x64',
    ]);
  });

  it('flags a packaging job that copied the steps instead of sharing them', () => {
    const forked = GOOD.replace('steps: *build-steps', 'steps:\n      - run: package');
    expect(perOsProblems(forked)).toEqual([
      'build-linux-x64 does not share the build-steps step list',
    ]);
  });

  it('does not count matrix rows from the next job', () => {
    const mac = job(
      'codex-native-mac',
      '    strategy:\n      matrix:\n        include:\n          - platformKey: darwin-arm64\n          - platformKey: darwin-x64\n    steps: *codex-native-steps\n',
    );
    expect(perOsProblems(workflowOf(GOOD.split('jobs:\n')[1], mac))).toEqual([]);
  });
});
