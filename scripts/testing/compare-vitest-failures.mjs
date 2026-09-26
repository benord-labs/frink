#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const STACK_LINE = /^\s*(?:at|❯)\s/;

function normalizePath(filePath, root) {
  return relative(resolve(root), resolve(filePath)).split(sep).join('/');
}

function normalizeMessage(messages, root) {
  const rootPath = resolve(root);
  const text = (Array.isArray(messages) ? messages : [messages])
    .filter(Boolean)
    .join('\n')
    .replaceAll(rootPath, '<repo>');
  const stableLines = text
    .split('\n')
    .filter((line) => !STACK_LINE.test(line))
    .map((line) => line.replace(/:\d+:\d+/g, ':<line>:<column>').trimEnd());
  return stableLines.join('\n').trim() || '<no failure message>';
}

function failureRecord(identity, messages, root) {
  const message = normalizeMessage(messages, root);
  return {
    identity,
    message,
    signature: createHash('sha256').update(message).digest('hex').slice(0, 12),
  };
}

export function collectFailures(report, root) {
  const failures = [];
  for (const result of report.testResults ?? []) {
    const file = normalizePath(result.name, root);
    const failedAssertions = (result.assertionResults ?? []).filter(
      (assertion) => assertion.status === 'failed',
    );
    for (const [index, assertion] of failedAssertions.entries()) {
      const name = assertion.fullName || assertion.title || `assertion ${index + 1}`;
      failures.push(failureRecord(`${file} :: ${name}`, assertion.failureMessages ?? [], root));
    }
    if (result.status === 'failed' && failedAssertions.length === 0) {
      failures.push(
        failureRecord(
          `${file} :: <suite setup>`,
          result.failureMessage ?? result.message ?? [],
          root,
        ),
      );
    }
  }
  return failures.sort((a, b) => a.identity.localeCompare(b.identity));
}

export function compareReports(baseReport, headReport, baseRoot, headRoot) {
  const baseFailures = collectFailures(baseReport, baseRoot);
  const headFailures = collectFailures(headReport, headRoot);
  const baseByIdentity = new Map(baseFailures.map((failure) => [failure.identity, failure]));
  const headByIdentity = new Map(headFailures.map((failure) => [failure.identity, failure]));
  const existing = headFailures.filter(
    (failure) => baseByIdentity.get(failure.identity)?.signature === failure.signature,
  );
  const introduced = headFailures.filter(
    (failure) => baseByIdentity.get(failure.identity)?.signature !== failure.signature,
  );
  const resolved = baseFailures.filter(
    (failure) => headByIdentity.get(failure.identity)?.signature !== failure.signature,
  );
  return { baseFailures, headFailures, existing, introduced, resolved };
}

export function validateRun(label, failures, exitCode) {
  if (!Number.isInteger(exitCode) || exitCode < 0) {
    return `${label} Vitest exit code is invalid: ${exitCode}`;
  }
  if (exitCode > 1) {
    return `${label} Vitest run exited abnormally with code ${exitCode}.`;
  }
  if (exitCode === 1 && failures.length === 0) {
    return `${label} Vitest run exited with code 1 but reported no failures.`;
  }
  if (exitCode === 0 && failures.length > 0) {
    return `${label} Vitest run exited successfully but reported ${failures.length} failure(s).`;
  }
  return null;
}

function failureList(title, failures) {
  if (failures.length === 0) return `### ${title}\n\nNone.\n`;
  return `### ${title}\n\n${failures
    .map((failure) => `- \`${failure.identity}\` (${failure.signature})`)
    .join('\n')}\n`;
}

export function formatSummary(comparison) {
  const { baseFailures, headFailures, existing, introduced, resolved } = comparison;
  return [
    '## Full Vitest suite delta',
    '',
    `Base: ${baseFailures.length} failure(s) · Head: ${headFailures.length} failure(s)`,
    '',
    failureList('Introduced or changed failures', introduced),
    failureList('Pre-existing unchanged failures', existing),
    failureList('Resolved failures', resolved),
  ].join('\n');
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

const USAGE =
  'Usage: compare-vitest-failures <base-report.json> <base-root> <base-exit> <head-report.json> <head-root> <head-exit>';

function parseArguments(args) {
  return args.length === 6 && args.every(Boolean) ? args : null;
}

function collectRunProblems(comparison, baseExit, headExit) {
  return [
    validateRun('Base', comparison.baseFailures, Number(baseExit)),
    validateRun('Head', comparison.headFailures, Number(headExit)),
  ].filter(Boolean);
}

function includeRunProblems(summary, runProblems) {
  if (runProblems.length === 0) return summary;
  return [
    summary,
    '### Invalid suite runs',
    '',
    ...runProblems.map((problem) => `- ${problem}`),
  ].join('\n');
}

function publishSummary(summary) {
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  }
}

function main() {
  const args = parseArguments(process.argv.slice(2));
  if (!args) {
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  const [baseReportPath, baseRoot, baseExit, headReportPath, headRoot, headExit] = args;

  const comparison = compareReports(
    readJson(baseReportPath),
    readJson(headReportPath),
    baseRoot,
    headRoot,
  );
  const runProblems = collectRunProblems(comparison, baseExit, headExit);
  publishSummary(includeRunProblems(formatSummary(comparison), runProblems));
  if (comparison.introduced.length > 0 || runProblems.length > 0) {
    console.error(`Full suite introduced or changed ${comparison.introduced.length} failure(s).`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
