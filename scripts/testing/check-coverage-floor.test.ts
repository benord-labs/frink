import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FLOOR, coverageVerdict, formatSummary, readTotals } from './check-coverage-floor.mjs';

type Pct = number | 'Unknown' | undefined;

function totals(statements: Pct, functions: Pct) {
  return { statements: { pct: statements }, functions: { pct: functions } };
}

function failing(rows: Array<{ metric: string; pass: boolean }>) {
  return rows.filter((row) => !row.pass).map((row) => row.metric);
}

describe('coverage floor', () => {
  it('passes when every metric is at or above its floor', () => {
    expect(failing(coverageVerdict(totals(80, 79)))).toEqual([]);
    expect(failing(coverageVerdict(totals(FLOOR.statements, FLOOR.functions)))).toEqual([]);
  });

  it('fails only the metric below its floor', () => {
    expect(failing(coverageVerdict(totals(FLOOR.statements - 0.01, 90)))).toEqual(['statements']);
  });

  it('fails closed when the summary is missing or has no usable percentage', () => {
    expect(failing(coverageVerdict(null))).toEqual(['statements', 'functions']);
    expect(failing(coverageVerdict({}))).toEqual(['statements', 'functions']);
    expect(failing(coverageVerdict(totals('Unknown', 90)))).toEqual(['statements']);
  });

  it('reads the total block of a json-summary report and null for anything unreadable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'coverage-floor-'));
    const valid = join(dir, 'coverage-summary.json');
    const broken = join(dir, 'broken.json');
    writeFileSync(valid, JSON.stringify({ total: totals(70, 70), '/repo/a.ts': totals(1, 1) }));
    writeFileSync(broken, '{');

    expect(readTotals(valid)).toEqual(totals(70, 70));
    expect(readTotals(broken)).toBeNull();
    expect(readTotals(join(dir, 'absent.json'))).toBeNull();
  });

  it('shows the floor, the measured value and the verdict for every metric', () => {
    const summary = formatSummary(coverageVerdict(totals(64.5, undefined)));
    expect(summary).toContain(`| statements | ${FLOOR.statements}% | 64.5% | FAIL |`);
    expect(summary).toContain(`| functions | ${FLOOR.functions}% | missing | FAIL |`);
  });
});
