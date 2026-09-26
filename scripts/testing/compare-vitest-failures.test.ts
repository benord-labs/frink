import { describe, expect, it } from 'vitest';
import {
  collectFailures,
  compareReports,
  formatSummary,
  validateRun,
} from './compare-vitest-failures.mjs';

const BASE_ROOT = '/tmp/base-checkout';
const HEAD_ROOT = '/tmp/head-checkout';

function report(
  root: string,
  failures: Array<{ file: string; name?: string; message?: string; suite?: boolean }>,
) {
  return {
    testResults: failures.map((failure) => ({
      name: `${root}/${failure.file}`,
      status: 'failed',
      assertionResults: failure.suite
        ? []
        : [
            {
              fullName: failure.name,
              status: 'failed',
              failureMessages: [
                `${failure.message ?? 'AssertionError: mismatch'}\n ❯ ${root}/${failure.file}:20:4`,
              ],
            },
          ],
      failureMessage: failure.suite ? failure.message : undefined,
    })),
  };
}

describe('compare Vitest failures', () => {
  it('treats the same normalized failure on base and head as pre-existing', () => {
    const base = report(BASE_ROOT, [
      { file: 'src/example.test.ts', name: 'example fails', message: 'expected 1 to be 2' },
    ]);
    const head = report(HEAD_ROOT, [
      { file: 'src/example.test.ts', name: 'example fails', message: 'expected 1 to be 2' },
    ]);

    const comparison = compareReports(base, head, BASE_ROOT, HEAD_ROOT);

    expect(comparison.existing).toHaveLength(1);
    expect(comparison.introduced).toEqual([]);
    expect(comparison.resolved).toEqual([]);
  });

  it('flags a new failing test and a changed failure message', () => {
    const base = report(BASE_ROOT, [
      { file: 'src/example.test.ts', name: 'example fails', message: 'expected 1 to be 2' },
    ]);
    const head = report(HEAD_ROOT, [
      { file: 'src/example.test.ts', name: 'example fails', message: 'expected 1 to be 3' },
      { file: 'scripts/new.test.ts', name: 'new failure' },
    ]);

    const comparison = compareReports(base, head, BASE_ROOT, HEAD_ROOT);

    expect(comparison.introduced.map((failure) => failure.identity)).toEqual([
      'scripts/new.test.ts :: new failure',
      'src/example.test.ts :: example fails',
    ]);
    expect(comparison.resolved).toHaveLength(1);
  });

  it('reports failures removed by the head', () => {
    const base = report(BASE_ROOT, [
      { file: 'src/example.test.ts', name: 'example fails', message: 'expected 1 to be 2' },
    ]);

    const comparison = compareReports(base, { testResults: [] }, BASE_ROOT, HEAD_ROOT);

    expect(comparison.resolved).toHaveLength(1);
    expect(comparison.headFailures).toEqual([]);
  });

  it('captures suite setup failures that have no failed assertion', () => {
    const failures = collectFailures(
      report(BASE_ROOT, [
        {
          file: 'src/import-error.test.ts',
          message: 'Error: failed to load module',
          suite: true,
        },
      ]),
      BASE_ROOT,
    );

    expect(failures[0].identity).toBe('src/import-error.test.ts :: <suite setup>');
    expect(failures[0].message).toBe('Error: failed to load module');
  });

  it('formats introduced and pre-existing failures for the job summary', () => {
    const comparison = compareReports(
      report(BASE_ROOT, [{ file: 'src/old.test.ts', name: 'old failure', message: 'old' }]),
      report(HEAD_ROOT, [
        { file: 'src/old.test.ts', name: 'old failure', message: 'old' },
        { file: 'src/new.test.ts', name: 'new failure', message: 'new' },
      ]),
      BASE_ROOT,
      HEAD_ROOT,
    );

    const summary = formatSummary(comparison);

    expect(summary).toContain('Introduced or changed failures');
    expect(summary).toContain('src/new.test.ts :: new failure');
    expect(summary).toContain('Pre-existing unchanged failures');
    expect(summary).toContain('src/old.test.ts :: old failure');
  });

  it('rejects abnormal and report-inconsistent suite exits', () => {
    const failures = collectFailures(
      report(BASE_ROOT, [{ file: 'src/old.test.ts', name: 'old failure' }]),
      BASE_ROOT,
    );

    expect(validateRun('Head', failures, 2)).toContain('exited abnormally');
    expect(validateRun('Head', [], 1)).toContain('reported no failures');
    expect(validateRun('Head', failures, 0)).toContain('exited successfully');
    expect(validateRun('Head', failures, 1)).toBeNull();
    expect(validateRun('Head', [], 0)).toBeNull();
  });
});
