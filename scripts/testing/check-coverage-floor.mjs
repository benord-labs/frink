#!/usr/bin/env node

import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Repository-wide coverage floor, enforced in CI. Raise it as coverage improves; never lower it.
export const FLOOR = { statements: 65, functions: 63 };

/** The `total` block of a Vitest json-summary report, or null when it cannot be read. */
export function readTotals(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8')).total ?? null;
  } catch {
    return null;
  }
}

/** One row per floored metric. A missing or non-numeric percentage fails. */
export function coverageVerdict(totals) {
  return Object.entries(FLOOR).map(([metric, floor]) => {
    const pct = totals?.[metric]?.pct;
    return { metric, floor, pct, pass: Number.isFinite(pct) && pct >= floor };
  });
}

export function formatSummary(rows) {
  return [
    '## Coverage floor',
    '',
    '| Metric | Floor | Coverage | Result |',
    '| --- | --- | --- | --- |',
    ...rows.map(
      ({ metric, floor, pct, pass }) =>
        `| ${metric} | ${floor}% | ${Number.isFinite(pct) ? `${pct}%` : 'missing'} | ${pass ? 'pass' : 'FAIL'} |`,
    ),
  ].join('\n');
}

function main() {
  const [summaryPath] = process.argv.slice(2);
  if (!summaryPath) {
    console.error('Usage: check-coverage-floor <coverage-summary.json>');
    process.exitCode = 2;
    return;
  }
  const rows = coverageVerdict(readTotals(summaryPath));
  const summary = formatSummary(rows);
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  }
  if (rows.some((row) => !row.pass)) {
    console.error(`Coverage is below the repository floor (${summaryPath}).`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
