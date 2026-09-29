import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Guards .github/workflows/test-suite.yml → deterministic-quality-gates (sc-3887).
// Every gate must run even when an earlier gate is red, so one failure cannot hide
// another. Plain text parsing: no YAML library is a declared dependency here.

const WORKFLOW_PATH = resolve(__dirname, '../../.github/workflows/test-suite.yml');
const JOB_KEY = 'deterministic-quality-gates';
const GATE_CONDITION = "if: ${{ !cancelled() && steps.install.outcome == 'success' }}";
const REQUIRED_GATES = [
  'format:check',
  'lint:oxlint',
  'lint:structure',
  'ts:check',
  'knip',
  'build:skills:check',
];

function jobBlock(workflow: string, jobKey: string): string | null {
  const lines = workflow.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((line) => line === `  ${jobKey}:`);
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^ {2}\S/.test(line) || /^\S/.test(line));
  return [lines[start], ...(end === -1 ? rest : rest.slice(0, end))].join('\n');
}

function jobSteps(block: string): string[] {
  const stepsAt = block.indexOf('\n    steps:\n');
  if (stepsAt === -1) return [];
  return block
    .slice(stepsAt + '\n    steps:\n'.length)
    .split(/\n(?= {6}- )/)
    .map((step) => step.trim())
    .filter(Boolean);
}

/** Every reason the job would let one red gate hide another, or pass with nothing checked. */
function gateProblems(workflow: string): string[] {
  const block = jobBlock(workflow, JOB_KEY);
  if (!block) return [`job ${JOB_KEY} not found`];

  const problems: string[] = [];
  const steps = jobSteps(block);
  const installIndex = steps.findIndex((step) => /^\s*id: install$/m.test(step));
  if (installIndex === -1) {
    problems.push('no step has id: install (gates would all skip and the job would pass)');
  } else if (!/run: bun install\b/.test(steps[installIndex])) {
    problems.push('the step with id: install does not run bun install');
  }

  if (/continue-on-error/.test(block)) {
    problems.push('continue-on-error would turn a red gate green');
  }

  steps.forEach((step, index) => {
    if (installIndex !== -1 && index <= installIndex) return;
    if (!step.includes(GATE_CONDITION)) {
      problems.push(
        `${step.split('\n')[0]} runs after install without the independent-run condition`,
      );
    }
  });

  for (const gate of REQUIRED_GATES) {
    const runs = steps.filter((step) => new RegExp(`run: bun run ${gate}$`, 'm').test(step));
    if (runs.length !== 1) problems.push(`gate ${gate} appears ${runs.length} times`);
    else if (installIndex !== -1 && steps.indexOf(runs[0]) < installIndex) {
      problems.push(`gate ${gate} runs before install`);
    }
  }
  return problems;
}

const GOOD_JOB = `jobs:
  ${JOB_KEY}:
    name: Deterministic quality gates
    steps:
      - uses: actions/checkout@v4

      - name: Install root dependencies
        id: install
        run: bun install --frozen-lockfile

${REQUIRED_GATES.map((gate) => `      - name: ${gate}\n        ${GATE_CONDITION}\n        run: bun run ${gate}`).join('\n\n')}

  branch-suite:
    steps:
      - run: bun run test:run
`;

describe('deterministic quality gates workflow', () => {
  const workflow = readFileSync(WORKFLOW_PATH, 'utf8');

  it('runs every gate independently once install succeeds', () => {
    expect(gateProblems(workflow)).toEqual([]);
  });

  it('still runs on pull requests and on pushes to main', () => {
    const block = jobBlock(workflow, JOB_KEY) ?? '';
    const jobIf = block.split('\n')[1] ?? '';
    expect(jobIf).toContain("github.event_name == 'pull_request'");
    expect(jobIf).toContain("github.event_name == 'push' && github.ref == 'refs/heads/main'");
  });
});

describe('gateProblems', () => {
  it('accepts a correctly gated job', () => {
    expect(gateProblems(GOOD_JOB)).toEqual([]);
  });

  it('accepts CRLF line endings from a Windows checkout', () => {
    expect(gateProblems(GOOD_JOB.replace(/\n/g, '\r\n'))).toEqual([]);
  });

  it('flags a missing job', () => {
    expect(gateProblems(GOOD_JOB.replace(`  ${JOB_KEY}:`, '  renamed-job:'))).toEqual([
      `job ${JOB_KEY} not found`,
    ]);
  });

  it('flags a missing install id, which would skip every gate and pass', () => {
    const problems = gateProblems(GOOD_JOB.replace('        id: install\n', ''));
    expect(problems).toContain(
      'no step has id: install (gates would all skip and the job would pass)',
    );
  });

  it('flags an install id on a step that does not install', () => {
    const moved = GOOD_JOB.replace('        id: install\n', '').replace(
      '      - uses: actions/checkout@v4',
      '      - uses: actions/checkout@v4\n        id: install',
    );
    expect(gateProblems(moved)).toContain('the step with id: install does not run bun install');
  });

  it('flags a gate that lost its condition', () => {
    const ungated = GOOD_JOB.replace(
      `        ${GATE_CONDITION}\n        run: bun run knip`,
      '        run: bun run knip',
    );
    expect(gateProblems(ungated)).toEqual([
      '- name: knip runs after install without the independent-run condition',
    ]);
  });

  it('flags always(), which would keep running gates after a cancel or timeout', () => {
    const always = GOOD_JOB.replace(GATE_CONDITION, 'if: always()');
    expect(gateProblems(always)).toHaveLength(1);
  });

  it('flags a new gate step added without the condition', () => {
    const extra = GOOD_JOB.replace(
      '\n\n  branch-suite:',
      '\n\n      - name: Lint\n        run: bun run lint\n\n  branch-suite:',
    );
    expect(gateProblems(extra)).toEqual([
      '- name: Lint runs after install without the independent-run condition',
    ]);
  });

  it('flags continue-on-error', () => {
    const soft = GOOD_JOB.replace(
      '        run: bun run knip',
      '        continue-on-error: true\n        run: bun run knip',
    );
    expect(gateProblems(soft)).toContain('continue-on-error would turn a red gate green');
  });

  it('flags a required gate that was removed or duplicated', () => {
    const removed = GOOD_JOB.replace(/\n\n {6}- name: build:skills:check\n[^\n]*\n[^\n]*/, '');
    expect(gateProblems(removed)).toEqual(['gate build:skills:check appears 0 times']);
  });

  it('does not count steps from the next job', () => {
    const otherJob = GOOD_JOB.replace('      - run: bun run test:run', '      - run: bun run knip');
    expect(gateProblems(otherJob)).toEqual([]);
  });
});
