/** Config-level guards that keep the @deprecated cloud layer contained.
 *  Rationale: docs/decisions/fallow-gradual-adoption.md (knip owns export-level dead code). */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

/** Import specifiers that resolve to `src/main/lib/cloud/index.ts`. */
const BARREL_SPECIFIERS = ['**/cloud', '**/cloud/index', '**/cloud/index.ts'];

/** Consumer roots the local-first migration moved off the cloud layer. */
const PROTECTED_ROOTS = [
  'src/main/lib/socket/**',
  'src/main/lib/mcp/**',
  'src/main/lib/permissions/**',
  'src/main/lib/task-executor/**',
];

type RestrictedImportPattern = { group?: string[] };
type RestrictedImportRule = [severity: string, options: { patterns?: RestrictedImportPattern[] }];
type OxlintOverride = {
  files?: string[];
  rules?: { 'eslint/no-restricted-imports'?: RestrictedImportRule };
};
type OxlintConfig = { overrides?: OxlintOverride[] };
type KnipConfig = {
  ignoreIssues?: Record<string, string[]>;
  workspaces?: Record<string, { ignore?: string[] }>;
};

/** `JSON.parse` already widens to `any`; the caller names the shape it expects. */
function readJson<TConfig>(relativePath: string): TConfig {
  return JSON.parse(readFileSync(resolve(REPO_ROOT, relativePath), 'utf8'));
}

function findRestrictedImportOverride(config: OxlintConfig): OxlintOverride {
  const match = config.overrides?.find(
    (override) => override.rules?.['eslint/no-restricted-imports'],
  );
  if (!match) {
    throw new Error('.oxlintrc.json no longer defines an eslint/no-restricted-imports override');
  }
  return match;
}

function bannedGroupsIn(override: OxlintOverride): string[] {
  const rule = override.rules?.['eslint/no-restricted-imports'];
  return (rule?.[1].patterns ?? []).flatMap((pattern) => pattern.group ?? []);
}

describe('cloud barrel surface', () => {
  // Asserted against source, not the imported module: deprecated cloud modules are mostly
  // types-only, so a widening re-export adds no runtime key for Object.keys to catch.
  it('exports nothing (core.ts/ApiRequestError removed), so the barrel is not a second spelling for a banned module', () => {
    const source = readFileSync(resolve(REPO_ROOT, 'src/main/lib/cloud/index.ts'), 'utf8');
    const exportStatements = source.match(/^\s*export\s.*$/gm)?.map((line) => line.trim()) ?? [];

    expect(exportStatements).toEqual(['export {};']);
  });
});

describe('cloud deprecation guards', () => {
  it('bans the cloud barrel spellings, so a new path cannot bypass the per-module bans', () => {
    const override = findRestrictedImportOverride(readJson<OxlintConfig>('.oxlintrc.json'));
    const banned = bannedGroupsIn(override);

    for (const specifier of BARREL_SPECIFIERS) {
      expect(banned).toContain(specifier);
    }
  });

  it('keeps the bans applying to the migrated consumer roots', () => {
    const override = findRestrictedImportOverride(readJson<OxlintConfig>('.oxlintrc.json'));

    expect(override.files ?? []).toEqual(expect.arrayContaining(PROTECTED_ROOTS));
  });
});

describe('cloud dead-code visibility', () => {
  // A blanket ignore here hid 12 real findings; epic 3353 exists to undo that.
  it('adds no knip suppression for the cloud path, so dead code is deleted not re-hidden', () => {
    const knip = readJson<KnipConfig>('knip.json');
    const suppressions = [
      ...(knip.workspaces?.['.']?.ignore ?? []),
      ...Object.keys(knip.ignoreIssues ?? {}),
    ];

    expect(suppressions.filter((entry) => entry.includes('src/main/lib/cloud'))).toEqual([]);
  });
});
