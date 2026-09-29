/** Guards for the public formatting and oxlint gates (sc-3790): files owned by a generator stay
 *  outside oxfmt so regenerating them cannot turn a gate red, and `bun run lint` runs both. */

import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format } from 'oxfmt';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const OXFMT_BIN = join(REPO_ROOT, 'node_modules/.bin/oxfmt');

/** JSON written with `JSON.stringify(value, null, 2)` by a generator, and never hand-edited. */
const VENDOR_INVENTORY_DIR = 'src/shared/integrations/vendor-inventory';
const GENERATED_JSON = [
  // Byte-compared by `build:skills:check`, so oxfmt must not rewrite it.
  'assets/skills/frink-flows/.baseline.json',
  ...readdirSync(join(REPO_ROOT, VENDOR_INVENTORY_DIR))
    .filter((name) => name.endsWith('.json'))
    .map((name) => `${VENDOR_INVENTORY_DIR}/${name}`),
];

describe('generated JSON and oxfmt', () => {
  it('reflows JSON.stringify output, so generated files cannot be both formatted and regenerated', async () => {
    const generated = `${JSON.stringify({ keywords: ['a', 'b'] }, null, 2)}\n`;

    const { code, errors } = await format('generated.json', generated);

    expect(errors).toEqual([]);
    expect(code).not.toBe(generated);
  });

  it('excludes every generated JSON file from oxfmt', () => {
    expect(GENERATED_JSON.length).toBeGreaterThan(1);
    // oxfmt reports "excluded by ignore rules" only when none of the given paths is formattable.
    const result = spawnSync(OXFMT_BIN, ['--check', ...GENERATED_JSON], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });

    expect(`${result.stdout}${result.stderr}`).toContain('excluded by ignore rules');
  });

  it('still checks a hand-written JSON file next to the generated ones', () => {
    const result = spawnSync(OXFMT_BIN, ['--check', 'src/shared/integrations/catalog'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });

    expect(`${result.stdout}${result.stderr}`).not.toContain('excluded by ignore rules');
  });
});

// CI wiring of both gates is guarded in scripts/testing/deterministic-quality-gates.test.ts.
describe('local lint script', () => {
  it('keeps `bun run lint` in step with the CI gates', () => {
    const { scripts } = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };

    expect(scripts.lint).toContain('bun run format:check');
    expect(scripts.lint).toContain('bun run lint:oxlint');
    expect(scripts['format:check']).toMatch(/^oxfmt --check /);
    expect(scripts['lint:oxlint']).toMatch(/^oxlint /);
  });
});
