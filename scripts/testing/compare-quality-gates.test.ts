import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GATE_SCRIPTS } from './collect-quality-gate-findings.mjs';
import { compareGateReports, formatSummary, validateGateRun } from './compare-quality-gates.mjs';

type GateRecord = {
  status: 'ran' | 'absent';
  exitCode?: number;
  findings?: string[];
  parseError?: string;
  outputTail?: string;
};

const ran = (findings: string[] = []): GateRecord => ({
  status: 'ran',
  exitCode: findings.length > 0 ? 1 : 0,
  findings,
});

/** A report where every gate is clean except the ones overridden. */
function report(overrides: Record<string, GateRecord> = {}) {
  return {
    version: 1,
    gates: Object.fromEntries(GATE_SCRIPTS.map((gate) => [gate, overrides[gate] ?? ran()])),
  };
}

type GateReport = ReturnType<typeof report>;

const gate = (comparison: ReturnType<typeof compareGateReports>, name: string) =>
  comparison.gates.find((entry) => entry.gate === name);

describe('compareGateReports', () => {
  it('passes a pull request whose base is red when it adds nothing new', () => {
    const inherited = [
      'src/main/lib/update-feed-url.ts :: project-structure/folder-structure :: x',
    ];
    const comparison = compareGateReports(
      report({ 'lint:structure': ran(inherited) }),
      report({ 'lint:structure': ran(inherited) }),
    );
    expect(comparison.failed).toBe(false);
    expect(gate(comparison, 'lint:structure')).toMatchObject({ inherited: 1, introduced: [] });
  });

  it('flags an export left unused in an unchanged file once its last caller is deleted', () => {
    const comparison = compareGateReports(
      report(),
      report({ knip: ran(['src/main/lib/auto-updater.ts :: exports :: installDownloadedUpdate']) }),
    );
    expect(comparison.failed).toBe(true);
    expect(gate(comparison, 'knip')?.introduced).toEqual([
      'src/main/lib/auto-updater.ts :: exports :: installDownloadedUpdate',
    ]);
  });

  it('flags a sibling structure violation caused by a deleted file', () => {
    const sibling =
      'src/main/lib/platform/frink-home.ts :: project-structure/folder-structure :: y';
    const comparison = compareGateReports(report(), report({ 'lint:structure': ran([sibling]) }));
    expect(gate(comparison, 'lint:structure')?.introduced).toEqual([sibling]);
  });

  it('counts duplicate findings, so a second copy of an inherited finding is new', () => {
    const finding = 'src/a.ts :: TS2322 :: Type mismatch';
    const comparison = compareGateReports(
      report({ 'ts:check': ran([finding]) }),
      report({ 'ts:check': ran([finding, finding]) }),
    );
    expect(gate(comparison, 'ts:check')).toMatchObject({ inherited: 1, introduced: [finding] });
  });

  it('reports findings the pull request fixed as resolved without failing', () => {
    const comparison = compareGateReports(
      report({ 'format:check': ran(['a.ts :: unformatted', 'b.ts :: unformatted']) }),
      report(),
    );
    expect(comparison.failed).toBe(false);
    expect(gate(comparison, 'format:check')?.resolved).toBe(2);
  });

  it('treats every head finding as new when base has no such gate yet', () => {
    const comparison = compareGateReports(
      report({ knip: { status: 'absent' } }),
      report({ knip: ran(['src/x.ts :: exports :: y']) }),
    );
    expect(comparison.failed).toBe(true);
    expect(gate(comparison, 'knip')?.problems).toEqual([]);
  });

  it('fails closed when a base gate crashed and head has findings', () => {
    const crashed = { status: 'ran' as const, exitCode: 1, findings: [], outputTail: 'boom' };
    const comparison = compareGateReports(
      report({ knip: crashed }),
      report({ knip: ran(['src/x.ts :: exports :: y']) }),
    );
    expect(comparison.failed).toBe(true);
    expect(gate(comparison, 'knip')?.problems).toEqual([
      'Base knip exited with code 1 but reported no findings.',
    ]);
    expect(formatSummary(comparison)).toContain('boom');
  });

  it('passes a clean head even when the same gate crashed on base', () => {
    const crashed = { status: 'ran' as const, exitCode: 1, findings: [] };
    const comparison = compareGateReports(report({ knip: crashed }), report());
    expect(comparison.failed).toBe(false);
  });

  it('fails when head output could not be parsed', () => {
    const comparison = compareGateReports(
      report(),
      report({ knip: { status: 'ran', exitCode: 1, findings: [], parseError: 'no JSON object' } }),
    );
    expect(comparison.failed).toBe(true);
  });

  // A pull request that breaks a gate's own config makes it exit non-zero with nothing parsed;
  // reading that as "no findings" would let the PR switch the gate off.
  it('fails when a gate crashes on head even though base was clean', () => {
    const comparison = compareGateReports(
      report(),
      report({ 'lint:structure': { status: 'ran', exitCode: 2, findings: [] } }),
    );
    expect(comparison.failed).toBe(true);
    expect(gate(comparison, 'lint:structure')?.problems).toEqual([
      'Head lint:structure exited with code 2 but reported no findings.',
    ]);
  });

  it('fails a head gate whose status the collector never writes, even with no findings', () => {
    const skipped = { status: 'skipped', exitCode: 0, findings: [] };
    const comparison = compareGateReports(report(), {
      version: 1,
      gates: { ...report().gates, knip: skipped },
    });
    expect(comparison.failed).toBe(true);
  });

  // Parsed JSON objects never equal one another, so a non-string finding can never match base
  // and is always counted as introduced.
  it('fails when head findings are not strings, even if base lists the same shapes', () => {
    const objects = { status: 'ran', exitCode: 1, findings: [{ file: 'a.ts' }] };
    const comparison = compareGateReports(
      { version: 1, gates: { ...report().gates, knip: JSON.parse(JSON.stringify(objects)) } },
      { version: 1, gates: { ...report().gates, knip: JSON.parse(JSON.stringify(objects)) } },
    );
    expect(comparison.failed).toBe(true);
  });

  it('fails when both sides carry the same malformed primitive finding', () => {
    const nulls = { status: 'ran', exitCode: 1, findings: [null] };
    const comparison = compareGateReports(
      { version: 1, gates: { ...report().gates, knip: nulls } },
      { version: 1, gates: { ...report().gates, knip: nulls } },
    );
    expect(comparison.failed).toBe(true);
  });

  it('fails when a report is missing a gate entirely', () => {
    const { 'ts:check': _dropped, ...gates } = report().gates;
    expect(compareGateReports(report(), { version: 1, gates }).failed).toBe(true);
  });
});

describe('validateGateRun', () => {
  // Only `ran` and `absent` are statuses the collector writes. Anything else, or a record whose
  // fields are the wrong shape, must fail closed rather than read as a clean run.
  it.each([
    ['an unknown status', { status: 'skipped', exitCode: 0, findings: [] }],
    ['a missing status', { exitCode: 0, findings: [] }],
    ['a non-object record', 'ran'],
    // Primitives compare equal across sides, so `[null]` on both would otherwise read as inherited.
    ['a null finding', { status: 'ran', exitCode: 1, findings: [null] }],
    ['a numeric finding', { status: 'ran', exitCode: 1, findings: [42] }],
    ['an object finding', { status: 'ran', exitCode: 1, findings: [{ file: 'a.ts' }] }],
    [
      'a finding without the location separator',
      { status: 'ran', exitCode: 1, findings: ['oops'] },
    ],
  ])('rejects %s', (_label, record) => {
    expect(validateGateRun('Head', 'knip', record)).toBe('Head knip record is malformed.');
  });

  it('rejects a head that dropped a gate script', () => {
    expect(validateGateRun('Head', 'knip', { status: 'absent' })).toBe(
      'Head no longer defines the knip script.',
    );
  });

  it('rejects a successful exit that still reported findings', () => {
    expect(
      validateGateRun('Head', 'knip', { status: 'ran', exitCode: 0, findings: ['a.ts :: x'] }),
    ).toMatch(/exited successfully but reported 1 finding/);
  });

  it('accepts a failing run that names its findings', () => {
    expect(validateGateRun('Base', 'knip', ran(['a.ts :: x']))).toBeNull();
  });
});

describe('formatSummary', () => {
  it('lists introduced findings and counts inherited ones per gate', () => {
    const summary = formatSummary(
      compareGateReports(
        report({ knip: ran(['old :: exports :: a']) }),
        report({ knip: ran(['old :: exports :: a', 'new :: exports :: b']) }),
      ),
    );
    expect(summary).toContain('### knip');
    expect(summary).toContain('1 introduced · 1 inherited from base · 0 resolved');
    expect(summary).toContain('- `new :: exports :: b`');
  });
});

describe('compare-quality-gates CLI', () => {
  const script = resolve(__dirname, 'compare-quality-gates.mjs');
  const runCli = (...args: string[]) =>
    spawnSync(process.execPath, [script, ...args], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH },
    });

  function withReports(base: GateReport, head: GateReport, check: (paths: string[]) => void) {
    const dir = mkdtempSync(join(tmpdir(), 'gate-reports-'));
    try {
      const paths = [join(dir, 'base.json'), join(dir, 'head.json')];
      writeFileSync(paths[0], JSON.stringify(base));
      writeFileSync(paths[1], JSON.stringify(head));
      check(paths);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // A matrix leg that timed out or died uploads no report; that must block, never pass.
  it('fails when a side has no report', () => {
    withReports(report(), report(), ([, head]) => {
      const run = runCli(join(tmpdir(), 'no-such-gates-report.json'), head);
      expect(run.status).not.toBe(0);
    });
  });

  it('exits 0 on a red base with nothing new and 1 once head adds a finding', () => {
    const inherited = report({ knip: ran(['old :: exports :: a']) });
    withReports(inherited, inherited, (paths) => {
      expect(runCli(...paths).status).toBe(0);
    });
    withReports(
      inherited,
      report({ knip: ran(['old :: exports :: a', 'new :: exports :: b']) }),
      (paths) => {
        const run = runCli(...paths);
        expect(run.status).toBe(1);
        expect(run.stdout).toContain('- `new :: exports :: b`');
      },
    );
  });

  it('rejects a wrong argument count with usage, not a pass', () => {
    expect(runCli('only-one.json').status).toBe(2);
  });
});
