#!/usr/bin/env node

// Runs every deterministic quality gate in the current checkout and records each finding as a
// line-free key, so a pull request's findings can be compared with its base's. CI copies this
// file out of the head checkout before checking out the base, so it must stay self-contained.

import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUTPUT_TAIL_LINES = 40;

function normalizePath(filePath, root) {
  const absolute = isAbsolute(filePath) ? filePath : resolve(root, filePath);
  return relative(resolve(root), absolute).split(sep).join('/');
}

function normalizeText(text, root) {
  return text.replaceAll(resolve(root), '<repo>').replace(/\s+/g, ' ').trim();
}

/** JSON reporters may share stdout with a banner; read from the first bracket. */
function parseJsonOutput(stdout, opener) {
  const start = stdout.indexOf(opener);
  if (start === -1) throw new Error(`no JSON ${opener === '[' ? 'array' : 'object'} in output`);
  return JSON.parse(stdout.slice(start));
}

export function parseFormatCheck({ stdout, stderr }) {
  return `${stdout}\n${stderr}`
    .split('\n')
    .map((line) => /^(\S.*?) \(\d+(?:\.\d+)?m?s\)$/.exec(line.trim())?.[1])
    .filter(Boolean)
    .map((file) => `${file} :: unformatted`);
}

export function parseOxlintJson({ stdout }, root) {
  const { diagnostics } = parseJsonOutput(stdout, '{');
  return diagnostics
    .filter((diagnostic) => diagnostic.severity === 'error')
    .map(
      (diagnostic) =>
        `${normalizePath(diagnostic.filename, root)} :: ${diagnostic.code} :: ${normalizeText(diagnostic.message, root)}`,
    );
}

export function parseEslintJson({ stdout }, root) {
  return parseJsonOutput(stdout, '[').flatMap((result) =>
    result.messages
      .filter((message) => message.severity === 2)
      .map(
        (message) =>
          `${normalizePath(result.filePath, root)} :: ${message.ruleId ?? 'fatal'} :: ${normalizeText(message.message, root)}`,
      ),
  );
}

export function parseTsc({ stdout, stderr }, root) {
  return `${stdout}\n${stderr}`
    .split('\n')
    .map((line) => /^(.+?)\(\d+,\d+\): error (TS\d+): (.*)$/.exec(line.trim()))
    .filter(Boolean)
    .map(
      ([, file, code, message]) =>
        `${normalizePath(file, root)} :: ${code} :: ${normalizeText(message, root)}`,
    );
}

function knipItemName(item) {
  if (Array.isArray(item)) return item.map(knipItemName).join(', ');
  return item?.name ?? JSON.stringify(item);
}

export function parseKnipJson({ stdout }, root) {
  const { issues } = parseJsonOutput(stdout, '{');
  return issues.flatMap((issue) =>
    Object.entries(issue)
      .filter(([, items]) => Array.isArray(items))
      .flatMap(([category, items]) =>
        items.map(
          (item) => `${normalizePath(issue.file, root)} :: ${category} :: ${knipItemName(item)}`,
        ),
      ),
  );
}

export function parseSkillDrift({ stdout, stderr }) {
  return `${stdout}\n${stderr}`
    .split('\n')
    .map((line) => /^\s+- (.+)$/.exec(line)?.[1]?.trim())
    .filter(Boolean)
    .map((entry) => `skill content :: ${entry}`);
}

/** Must match the steps of the strict deterministic-quality-gates job; a test enforces it. */
export const GATES = [
  { script: 'format:check', args: [], parse: parseFormatCheck },
  { script: 'lint:oxlint', args: ['--format', 'json'], parse: parseOxlintJson },
  { script: 'lint:structure', args: ['--format', 'json'], parse: parseEslintJson },
  { script: 'ts:check', args: [], parse: parseTsc },
  { script: 'knip', args: ['--reporter', 'json'], parse: parseKnipJson },
  { script: 'build:skills:check', args: [], parse: parseSkillDrift },
];

export const GATE_SCRIPTS = GATES.map((gate) => gate.script);

function outputTail({ stdout, stderr }) {
  return `${stdout}\n${stderr}`.trimEnd().split('\n').slice(-OUTPUT_TAIL_LINES).join('\n');
}

/** One gate's record from its captured output; a parse failure is kept, never swallowed. */
export function recordGate(gate, output, root) {
  const record = { status: 'ran', exitCode: output.exitCode, findings: [] };
  try {
    record.findings = gate.parse(output, root).sort();
  } catch (error) {
    record.parseError = error instanceof Error ? error.message : String(error);
  }
  if (record.parseError || record.exitCode !== 0) record.outputTail = outputTail(output);
  return record;
}

export function runGate(gate, root) {
  const result = spawnSync('bun', ['run', gate.script, ...gate.args], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  const spawnError = result.error ? `\n${result.error.message}` : '';
  return {
    exitCode: spawnError ? -1 : (result.status ?? -1),
    stdout: result.stdout ?? '',
    stderr: `${result.stderr ?? ''}${spawnError}`,
  };
}

/** Every gate's record for the checkout at `root`; a gate its package.json lacks is `absent`. */
export function collectReport(root, run = runGate) {
  const scripts = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).scripts ?? {};
  const gates = {};
  for (const gate of GATES) {
    gates[gate.script] = scripts[gate.script]
      ? recordGate(gate, run(gate, root), root)
      : { status: 'absent' };
  }
  return { version: 1, gates };
}

function main() {
  const [reportPath] = process.argv.slice(2);
  if (!reportPath) {
    console.error('Usage: collect-quality-gate-findings <report.json>');
    process.exitCode = 2;
    return;
  }
  const report = collectReport(process.cwd());
  for (const [script, record] of Object.entries(report.gates)) {
    if (record.status === 'ran') {
      console.log(`${script}: exit ${record.exitCode}, ${record.findings.length} finding(s)`);
    }
  }
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}

// Real paths: a symlinked temp dir (macOS /tmp) must not silently skip main().
if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  main();
}
