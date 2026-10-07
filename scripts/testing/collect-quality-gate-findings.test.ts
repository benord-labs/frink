import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  collectReport,
  GATES,
  parseEslintJson,
  parseFormatCheck,
  parseKnipJson,
  parseOxlintJson,
  parseSkillDrift,
  parseTsc,
  recordGate,
} from './collect-quality-gate-findings.mjs';

// Fixtures mirror real gate output captured from a red checkout.
const ROOT = '/tmp/checkout';
const output = (stdout: string, stderr = '', exitCode = 1) => ({ stdout, stderr, exitCode });

/** The knip JSON categories these fixtures fill in; the rest stay empty arrays. */
type KnipItem = { name: string; line?: number; col?: number; pos?: number };
type KnipIssueExtra = {
  binaries?: KnipItem[];
  exports?: KnipItem[];
  types?: KnipItem[];
  duplicates?: KnipItem[][];
};

describe('gate output parsers', () => {
  it('reads one finding per unformatted file and ignores the timing footer', () => {
    const stdout = [
      'Checking formatting...',
      '',
      'mobile/src/lib/computer-store.test.ts (0ms)',
      'scripts/qa/fixtures/base.ts (12ms)',
      '',
      'Format issues found in above 2 files. Run without `--check` to fix.',
      'Finished in 197ms on 3482 files using 10 threads.',
    ].join('\n');
    expect(parseFormatCheck(output(stdout))).toEqual([
      'mobile/src/lib/computer-store.test.ts :: unformatted',
      'scripts/qa/fixtures/base.ts :: unformatted',
    ]);
  });

  it('keeps oxlint errors and drops advisory warnings', () => {
    const diagnostic = (severity: string, code: string, line: number) => ({
      message: `Problem ${code}`,
      code,
      severity,
      filename: 'scripts/qa/bench/cdp.mjs',
      labels: [{ span: { offset: 1, length: 1, line, column: 3 } }],
    });
    const stdout = JSON.stringify({
      diagnostics: [
        diagnostic('error', 'eslint(no-unused-expressions)', 14),
        diagnostic('warning', 'eslint(no-console)', 20),
      ],
    });
    expect(parseOxlintJson(output(stdout), ROOT)).toEqual([
      'scripts/qa/bench/cdp.mjs :: eslint(no-unused-expressions) :: Problem eslint(no-unused-expressions)',
    ]);
  });

  it('reads eslint errors with the checkout root and line breaks normalised away', () => {
    const stdout = JSON.stringify([
      {
        filePath: `${ROOT}/src/main/lib/update-feed-url.ts`,
        messages: [
          {
            ruleId: 'project-structure/folder-structure',
            severity: 2,
            message:
              "🔥 File 'update-feed-url.ts' is invalid. 🔥\n\nError location = ./src/main/lib",
            line: 3,
          },
          { ruleId: 'some/warning', severity: 1, message: 'advisory', line: 9 },
        ],
      },
      { filePath: `${ROOT}/src/clean.ts`, messages: [] },
    ]);
    expect(parseEslintJson(output(stdout), ROOT)).toEqual([
      "src/main/lib/update-feed-url.ts :: project-structure/folder-structure :: 🔥 File 'update-feed-url.ts' is invalid. 🔥 Error location = ./src/main/lib",
    ]);
  });

  it('reads tsc diagnostics without their line and column', () => {
    const stdout = [
      '$ node ./node_modules/@typescript/native/bin/tsc --noEmit',
      "src/main/zz.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.",
    ].join('\n');
    expect(parseTsc(output('', stdout), ROOT)).toEqual([
      "src/main/zz.ts :: TS2322 :: Type 'string' is not assignable to type 'number'.",
    ]);
  });

  it('reads every knip category, including unlisted binaries and unused types', () => {
    const issue = (file: string, extra: KnipIssueExtra) => ({
      file,
      binaries: [],
      dependencies: [],
      duplicates: [],
      exports: [],
      files: [],
      types: [],
      ...extra,
    });
    const stdout = JSON.stringify({
      issues: [
        issue('.github/workflows/build-desktop.yml', { binaries: [{ name: 'node-gyp' }] }),
        issue('src/main/lib/auto-updater.ts', {
          exports: [{ name: 'installDownloadedUpdate', line: 271, col: 17, pos: 8360 }],
        }),
        issue('src/shared/types/remote/mobile.ts', {
          types: [{ name: 'MobileAccount', line: 269 }],
          duplicates: [[{ name: 'a' }, { name: 'b' }]],
        }),
      ],
    });
    expect(parseKnipJson(output(stdout), ROOT)).toEqual([
      '.github/workflows/build-desktop.yml :: binaries :: node-gyp',
      'src/main/lib/auto-updater.ts :: exports :: installDownloadedUpdate',
      'src/shared/types/remote/mobile.ts :: duplicates :: a, b',
      'src/shared/types/remote/mobile.ts :: types :: MobileAccount',
    ]);
  });

  it('reads each drifted skill file', () => {
    const stderr = [
      'Skill content drift detected:',
      '  - references/inspecting-runs.md: out of sync with guideline TS source',
      '  - .baseline.json: out of sync',
      'Re-run: bun run build:skills',
    ].join('\n');
    expect(parseSkillDrift(output('', stderr))).toEqual([
      'skill content :: references/inspecting-runs.md: out of sync with guideline TS source',
      'skill content :: .baseline.json: out of sync',
    ]);
  });
});

describe('recordGate', () => {
  const knip = GATES.find((gate) => gate.script === 'knip');

  it('keeps a parse failure and the output tail instead of reporting zero findings', () => {
    const record = recordGate(knip, output('Error: cannot load knip.json'), ROOT);
    expect(record.findings).toEqual([]);
    expect(record.parseError).toMatch(/no JSON object/);
    expect(record.outputTail).toContain('cannot load knip.json');
  });

  it('records a clean run without an output tail', () => {
    expect(recordGate(knip, output('{"issues":[]}', '', 0), ROOT)).toEqual({
      status: 'ran',
      exitCode: 0,
      findings: [],
    });
  });
});

describe('collectReport', () => {
  // Drives the real `bun run` spawn against a checkout whose gate scripts are stand-ins, so the
  // wiring from package.json script to parsed record is exercised, not just the parsers.
  it('runs each defined gate through bun and records absent ones without running them', () => {
    const checkout = mkdtempSync(join(tmpdir(), 'gate-report-'));
    try {
      // A script file, like the real tools, so the appended `--reporter json` lands in argv.
      writeFileSync(
        join(checkout, 'knip-stand-in.mjs'),
        "console.log(JSON.stringify({ issues: [{ file: 'src/a.ts', exports: [{ name: 'gone' }] }] }));\nprocess.exit(1);\n",
      );
      const scripts = {
        knip: 'node knip-stand-in.mjs',
        'format:check': 'node -e "process.exit(0)"',
      };
      writeFileSync(join(checkout, 'package.json'), JSON.stringify({ scripts }));

      const report = collectReport(checkout);

      expect(report.gates.knip).toMatchObject({
        status: 'ran',
        exitCode: 1,
        findings: ['src/a.ts :: exports :: gone'],
      });
      expect(report.gates['format:check']).toEqual({ status: 'ran', exitCode: 0, findings: [] });
      expect(report.gates['ts:check']).toEqual({ status: 'absent' });
    } finally {
      rmSync(checkout, { recursive: true, force: true });
    }
  });
});

describe('collector entry point', () => {
  // CI copies this file alone into a temp dir and runs it from there. A symlinked path (macOS /tmp)
  // once made the entry check skip main() and exit 0 with no report; a relative import would only
  // break in that copied location.
  it('runs main from a lone copy reached through a symlink', () => {
    const lone = mkdtempSync(join(tmpdir(), 'gate-collector-'));
    const linked = mkdtempSync(join(tmpdir(), 'gate-collector-link-'));
    const checkout = mkdtempSync(join(tmpdir(), 'gate-checkout-'));
    try {
      const copy = join(lone, 'collect.mjs');
      copyFileSync(resolve(__dirname, 'collect-quality-gate-findings.mjs'), copy);
      const link = join(linked, 'collect.mjs');
      symlinkSync(copy, link);
      writeFileSync(join(checkout, 'package.json'), JSON.stringify({ scripts: {} }));
      const reportPath = join(checkout, 'gates.json');

      const run = spawnSync(process.execPath, [link, reportPath], {
        cwd: checkout,
        encoding: 'utf8',
      });

      expect(run.stderr).toBe('');
      expect(run.status).toBe(0);
      expect(JSON.parse(readFileSync(reportPath, 'utf8'))).toEqual({
        version: 1,
        gates: Object.fromEntries(GATES.map((gate) => [gate.script, { status: 'absent' }])),
      });
    } finally {
      for (const dir of [lone, linked, checkout]) rmSync(dir, { recursive: true, force: true });
    }
  });
});
