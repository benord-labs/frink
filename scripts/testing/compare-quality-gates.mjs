#!/usr/bin/env node

// Fails a pull request only for quality-gate findings its head adds over its base, so a base
// that is already red cannot hide a new finding, and inherited ones do not block unrelated work.

import { appendFileSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { GATE_SCRIPTS } from './collect-quality-gate-findings.mjs';

const LISTED_FINDINGS_PER_GATE = 50;
/** Every key the collector writes is `<location> :: <detail>`; anything else is not a finding. */
const FINDING_KEY = /^\S.* :: .+$/;

/** Head findings minus base findings, counted as multisets so duplicates are not merged. */
function diffFindings(baseFindings, headFindings) {
  const remaining = new Map();
  for (const finding of baseFindings) remaining.set(finding, (remaining.get(finding) ?? 0) + 1);
  const introduced = [];
  let inherited = 0;
  for (const finding of headFindings) {
    const count = remaining.get(finding) ?? 0;
    if (count > 0) {
      remaining.set(finding, count - 1);
      inherited += 1;
    } else {
      introduced.push(finding);
    }
  }
  const resolved = [...remaining.values()].reduce((sum, count) => sum + count, 0);
  return { introduced, inherited, resolved };
}

/** Why one side's gate record cannot be trusted, or null when it can. */
export function validateGateRun(label, gate, record) {
  if (!record) return `${label} report has no record for ${gate}.`;
  if (record.status === 'absent') {
    return label === 'Head' ? `Head no longer defines the ${gate} script.` : null;
  }
  // Anything but the collector's own `ran` shape fails closed instead of reading as clean.
  const wellFormed =
    record.status === 'ran' &&
    Number.isInteger(record.exitCode) &&
    Array.isArray(record.findings) &&
    record.findings.every((finding) => FINDING_KEY.test(finding));
  if (!wellFormed) return `${label} ${gate} record is malformed.`;
  if (record.parseError) return `${label} ${gate} output could not be read: ${record.parseError}`;
  if (record.exitCode !== 0 && record.findings.length === 0) {
    return `${label} ${gate} exited with code ${record.exitCode} but reported no findings.`;
  }
  if (record.exitCode === 0 && record.findings.length > 0) {
    return `${label} ${gate} exited successfully but reported ${record.findings.length} finding(s).`;
  }
  return null;
}

export function compareGateReports(baseReport, headReport) {
  const gates = GATE_SCRIPTS.map((gate) => {
    const base = baseReport.gates?.[gate];
    const head = headReport.gates?.[gate];
    const headProblem = validateGateRun('Head', gate, head);
    // A clean head introduces nothing whatever base did, so a pull request repairing a gate that
    // crashes on base is not blocked by that crash.
    const headClean = !headProblem && head.status !== 'absent' && head.findings.length === 0;
    const problems = [headClean ? null : validateGateRun('Base', gate, base), headProblem];
    const baseFindings = base?.status === 'absent' ? [] : (base?.findings ?? []);
    return {
      gate,
      problems: problems.filter(Boolean),
      outputTails: [base?.outputTail, head?.outputTail].filter(
        (tail, index) => problems[index] && tail,
      ),
      ...diffFindings(baseFindings, head?.findings ?? []),
    };
  });
  const failed = gates.some((gate) => gate.introduced.length > 0 || gate.problems.length > 0);
  return { gates, failed };
}

function gateSection(gate) {
  const lines = [
    `### ${gate.gate}`,
    '',
    `${gate.introduced.length} introduced · ${gate.inherited} inherited from base · ${gate.resolved} resolved`,
  ];
  if (gate.introduced.length > 0) {
    lines.push('', ...gate.introduced.slice(0, LISTED_FINDINGS_PER_GATE).map((f) => `- \`${f}\``));
    const hidden = gate.introduced.length - LISTED_FINDINGS_PER_GATE;
    if (hidden > 0) lines.push(`- …and ${hidden} more`);
  }
  if (gate.problems.length > 0) {
    lines.push('', ...gate.problems.map((problem) => `- **Invalid run:** ${problem}`));
    for (const tail of gate.outputTails) lines.push('', '```', tail, '```');
  }
  return lines.join('\n');
}

export function formatSummary(comparison) {
  return [
    '## Deterministic quality gates (pull request delta)',
    '',
    ...comparison.gates.map(gateSection),
  ].join('\n\n');
}

function publishSummary(summary) {
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || !args.every(Boolean)) {
    console.error('Usage: compare-quality-gates <base-report.json> <head-report.json>');
    process.exitCode = 2;
    return;
  }
  const comparison = compareGateReports(readJson(args[0]), readJson(args[1]));
  publishSummary(formatSummary(comparison));
  if (comparison.failed) {
    console.error('The pull request introduces quality-gate findings, or a gate run is invalid.');
    process.exitCode = 1;
  }
}

// Real paths: a symlinked temp dir (macOS /tmp) must not silently skip main().
if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  main();
}
