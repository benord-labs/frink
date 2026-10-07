/**
 * Generate the `frink-flows` skill reference files from the canonical
 * guideline modules in `src/main/lib/mcp/flows-tools/guidelines/*.ts`.
 *
 * The guideline TS files are the source of truth (block-related topics are
 * dynamic — they pull OUTPUT_SCHEMAS / TRIGGER_SCHEMAS from
 * `src/shared/lib/output-schemas.ts`). Running this script writes one Markdown
 * file per topic into `assets/skills/frink-flows/references/` and refreshes the
 * SHA256 baseline at `assets/skills/frink-flows/.baseline.json`.
 *
 * Usage:
 *   bun run scripts/build-skill-content.ts          # write
 *   bun run scripts/build-skill-content.ts --check  # verify outputs match TS (CI / drift gate)
 */

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildTriggerAliasesSection,
  getBatchingGuideline,
  getBlocksActionsGuideline,
  getBlocksLogicGuideline,
  getBlocksTriggersGuideline,
  getCustomNodesGuideline,
  getExamplesGuideline,
  getInspectingRunsGuideline,
  getTemplateVariablesGuideline,
} from '../../src/main/lib/mcp/flows-tools/guidelines';
import { canonicalStringify } from '../../src/shared/lib/canonical-stringify';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
const SKILL_ROOT = join(REPO_ROOT, 'assets', 'skills', 'frink-flows');
const SKILL_FILE = join(SKILL_ROOT, 'SKILL.md');
const BASELINE_FILE = join(SKILL_ROOT, '.baseline.json');

const TOPICS = [
  { name: 'blocks-triggers', build: getBlocksTriggersGuideline },
  { name: 'blocks-actions', build: getBlocksActionsGuideline },
  { name: 'blocks-logic', build: getBlocksLogicGuideline },
  { name: 'template-variables', build: getTemplateVariablesGuideline },
  { name: 'batching', build: getBatchingGuideline },
  { name: 'custom-nodes', build: getCustomNodesGuideline },
  { name: 'examples', build: getExamplesGuideline },
  { name: 'inspecting-runs', build: getInspectingRunsGuideline },
  { name: 'webhook-aliases', build: buildTriggerAliasesSection },
] as const;

type BaselineEntry = { sha256: string; bytes: number };
type Baseline = { generatedAt: string; version: string; files: Record<string, BaselineEntry> };

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

async function buildAll(): Promise<Map<string, string>> {
  const outputs = new Map<string, string>();
  const skillBody = await readFile(SKILL_FILE, 'utf8');
  outputs.set('SKILL.md', skillBody);
  for (const topic of TOPICS) {
    outputs.set(`references/${topic.name}.md`, topic.build());
  }
  return outputs;
}

export function computeBaseline(outputs: ReadonlyMap<string, string>): Baseline {
  const files: Record<string, BaselineEntry> = {};
  const normalizedOutputs = [...outputs.entries()]
    .map(([path, content]) => [path.replaceAll('\\', '/'), content] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [path, content] of normalizedOutputs) {
    files[path] = { sha256: sha256(content), bytes: Buffer.byteLength(content, 'utf8') };
  }
  const version = `content-${sha256(canonicalStringify(files)).slice(0, 12)}`;
  return { generatedAt: version, version, files };
}

async function writeOutputs(outputs: Map<string, string>, baseline: Baseline): Promise<void> {
  for (const [relPath, content] of outputs) {
    if (relPath === 'SKILL.md') continue; // SKILL.md is hand-authored; we read it for baseline only
    const abs = join(SKILL_ROOT, relPath);
    await writeFile(abs, content, 'utf8');
  }
  await writeFile(BASELINE_FILE, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
}

async function checkDrift(outputs: Map<string, string>, baseline: Baseline): Promise<string[]> {
  const drift: string[] = [];
  for (const [relPath, content] of outputs) {
    if (relPath === 'SKILL.md') continue;
    const abs = join(SKILL_ROOT, relPath);
    const existing = await readIfExists(abs);
    if (existing === null) {
      drift.push(`${relPath}: missing on disk`);
      continue;
    }
    if (existing !== content) {
      drift.push(`${relPath}: out of sync with guideline TS source`);
    }
  }
  const existingBaselineRaw = await readIfExists(BASELINE_FILE);
  const expectedBaseline = `${JSON.stringify(baseline, null, 2)}\n`;
  if (existingBaselineRaw === null) {
    drift.push('.baseline.json: missing on disk');
  } else if (existingBaselineRaw !== expectedBaseline) {
    drift.push('.baseline.json: out of sync');
  }
  return drift;
}

async function main(): Promise<void> {
  const check = process.argv.includes('--check');
  const outputs = await buildAll();
  const baseline = computeBaseline(outputs);

  if (check) {
    const drift = await checkDrift(outputs, baseline);
    if (drift.length > 0) {
      process.stderr.write(
        `Skill content drift detected:\n${drift.map((d) => `  - ${d}`).join('\n')}\n`,
      );
      process.stderr.write(`Re-run: bun run build:skills\n`);
      process.exit(1);
    }
    process.stdout.write(`Skill content in sync (manifest ${baseline.version}).\n`);
    return;
  }

  await writeOutputs(outputs, baseline);
  process.stdout.write(
    `Wrote ${outputs.size - 1} reference file(s) + .baseline.json (manifest ${baseline.version}).\n`,
  );
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    process.stderr.write(
      `build-skill-content failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  });
}
