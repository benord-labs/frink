import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Guards .github/workflows/build-desktop.yml: only a seeding run on main (a push to main or the
// weekly schedule) may write an Actions cache. GitHub lets a PR or a release tag read main's caches
// but never another PR's, so a cache saved by a PR run only fills the 10 GB budget and evicts the
// ones releases could use. Plain text parsing, like the sibling build-desktop guards: no YAML
// library is a declared dependency here.

const WORKFLOW_PATH = resolve(__dirname, '../../.github/workflows/build-desktop.yml');
const SEEDING_ONLY = [
  "github.event_name == 'schedule'",
  "github.event_name == 'push' && github.ref == 'refs/heads/main'",
];

/** Each step as its own block of lines, from its `- ` line to the next step or the end of the list. */
function stepsOf(workflow: string): string[][] {
  const steps: string[][] = [];
  let indent = -1;
  for (const line of workflow.replace(/\r\n/g, '\n').split('\n')) {
    const start = /^(\s*)- /.exec(line);
    const lineIndent = line.search(/\S/);
    if (start && (indent === -1 || start[1].length === indent)) {
      indent = start[1].length;
      steps.push([line]);
    } else if (indent !== -1 && lineIndent !== -1 && lineIndent <= indent) {
      indent = -1;
    } else if (indent !== -1) {
      steps.at(-1)?.push(line);
    }
  }
  return steps;
}

/** Every step that can write a cache from a run other than a seeding run on main. */
function cacheProblems(workflow: string): string[] {
  const problems: string[] = [];
  for (const step of stepsOf(workflow)) {
    const text = step.join('\n');
    const uses = /uses:\s*(actions\/cache(?:\/\w+)?)@/.exec(text)?.[1];
    if (uses === 'actions/cache') {
      problems.push(
        `${step[0].trim()}: actions/cache also saves on PR runs; restore and save separately`,
      );
    }
    if (uses === 'actions/cache/save' && !SEEDING_ONLY.every((clause) => text.includes(clause))) {
      problems.push(`${step[0].trim()}: saves a cache outside a seeding run on main`);
    }
  }
  return problems;
}

const workflowOf = (...steps: string[]) =>
  `name: Build Desktop\n\njobs:\n  codex:\n    steps:\n${steps.join('')}  next-job:\n    steps:\n      - run: echo\n`;
const RESTORE =
  '      - name: Restore\n        uses: actions/cache/restore@v4\n        with:\n          key: k\n';
const SEEDING_SAVE =
  "      - name: Save\n        if: >-\n          miss\n          && (github.event_name == 'schedule' || (github.event_name == 'push' && github.ref == 'refs/heads/main'))\n        uses: actions/cache/save@v4\n";

describe('build-desktop.yml Codex cache', () => {
  it('writes caches only from seeding runs on main', () => {
    expect(cacheProblems(readFileSync(WORKFLOW_PATH, 'utf8'))).toEqual([]);
  });
});

describe('cacheProblems', () => {
  it('accepts a restore everywhere and a save gated to seeding runs', () => {
    expect(cacheProblems(workflowOf(RESTORE, SEEDING_SAVE))).toEqual([]);
  });

  it('accepts CRLF line endings from a Windows checkout', () => {
    expect(cacheProblems(workflowOf(RESTORE, SEEDING_SAVE).replace(/\n/g, '\r\n'))).toEqual([]);
  });

  // The shape this workflow had before: one actions/cache step that saved from every PR run.
  it('flags a combined actions/cache step', () => {
    const combined = '      - uses: actions/cache@v4\n        with:\n          key: k\n';
    expect(cacheProblems(workflowOf(combined))).toEqual([
      '- uses: actions/cache@v4: actions/cache also saves on PR runs; restore and save separately',
    ]);
  });

  it('flags a save with no condition', () => {
    const ungated = '      - name: Save\n        uses: actions/cache/save@v4\n';
    expect(cacheProblems(workflowOf(RESTORE, ungated))).toEqual([
      '- name: Save: saves a cache outside a seeding run on main',
    ]);
  });

  it('flags a save gated on main pushes but not the schedule that keeps the cache alive', () => {
    const mainOnly = SEEDING_SAVE.replace("github.event_name == 'schedule' || ", '');
    expect(cacheProblems(workflowOf(RESTORE, mainOnly))).toEqual([
      '- name: Save: saves a cache outside a seeding run on main',
    ]);
  });

  it('flags a save whose condition sits on a different step', () => {
    const misplaced =
      "      - if: github.event_name == 'schedule' || (github.event_name == 'push' && github.ref == 'refs/heads/main')\n        run: echo seeding\n      - name: Save\n        uses: actions/cache/save@v4\n";
    expect(cacheProblems(workflowOf(RESTORE, misplaced))).toEqual([
      '- name: Save: saves a cache outside a seeding run on main',
    ]);
  });
});
