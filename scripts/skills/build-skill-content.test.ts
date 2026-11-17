import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  getCustomNodesGuideline,
  getTemplateVariablesGuideline,
} from '../../src/main/lib/mcp/flows-tools/guidelines';
import { computeBaseline, findDrift, formatDriftReport } from './build-skill-content';

type VersionContextBuilder = (
  outputs: ReadonlyMap<string, string>,
  packageVersion: string,
) => ReturnType<typeof computeBaseline>;

const buildInVersionContext = computeBaseline as VersionContextBuilder;

describe('build-skill-content baseline', () => {
  it('is identical across package-version contexts when generated content is unchanged', () => {
    const outputs = new Map([
      ['SKILL.md', '# frink-flows\n'],
      ['references/topic.md', 'same generated content\n'],
    ]);

    const featureBaseline = buildInVersionContext(outputs, '0.0.9');
    const targetBaseline = buildInVersionContext(outputs, '0.0.10');

    expect(featureBaseline).toEqual(targetBaseline);
    expect(featureBaseline.version).toMatch(/^content-[a-f0-9]{12}$/);
    expect(featureBaseline.generatedAt).toBe(featureBaseline.version);
  });

  it('canonicalizes insertion order and manifest path separators', () => {
    const posixOutputs = new Map([
      ['SKILL.md', '# frink-flows\n'],
      ['references/topic.md', 'generated content\n'],
    ]);
    const windowsOutputs = new Map([
      ['references\\topic.md', 'generated content\n'],
      ['SKILL.md', '# frink-flows\n'],
    ]);

    expect(computeBaseline(posixOutputs)).toEqual(computeBaseline(windowsOutputs));
  });

  it('changes identity when content changes without changing its byte length', () => {
    const before = computeBaseline(new Map([['references/topic.md', 'before']]));
    const after = computeBaseline(new Map([['references/topic.md', 'after!']]));

    expect(Buffer.byteLength('before')).toBe(Buffer.byteLength('after!'));
    expect(after.files['references/topic.md']?.sha256).not.toBe(
      before.files['references/topic.md']?.sha256,
    );
    expect(after.version).not.toBe(before.version);
  });
});

describe('custom-nodes guideline source', () => {
  it('documents the template opt-out that agents need for script-owned {{...}} syntax', () => {
    const guideline = getCustomNodesGuideline();

    expect(guideline).toContain('`listOptions`, `template` |');
    expect(guideline).toContain('Set `"template": false`');
  });
});

describe('committed frink-flows skill assets', () => {
  // Generated references must only change through their guideline source; a hand edit is lost on the next build.
  const committedRoot = resolve(__dirname, '../../assets/skills/frink-flows');
  const copies: string[] = [];

  /** A scratch copy of the committed assets, so a test can damage it without touching the repo. */
  function copyOfAssets(): string {
    const root = mkdtempSync(join(tmpdir(), 'frink-flows-skill-'));
    cpSync(committedRoot, root, { recursive: true });
    copies.push(root);
    return root;
  }

  afterEach(() => {
    for (const root of copies.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('match the generator output exactly', async () => {
    await expect(findDrift()).resolves.toEqual([]);
  });

  it('report a hand-edited reference and a missing baseline by name', async () => {
    const root = copyOfAssets();
    writeFileSync(join(root, 'references/inspecting-runs.md'), '# hand edited\n');
    unlinkSync(join(root, '.baseline.json'));

    await expect(findDrift(root)).resolves.toEqual([
      'references/inspecting-runs.md: out of sync with guideline TS source',
      '.baseline.json: missing on disk',
    ]);
  });

  it('name each drifted path and the package script that regenerates them', () => {
    expect(
      formatDriftReport(['references/a.md: missing on disk', '.baseline.json: out of sync']),
    ).toBe(
      'Skill content drift detected:\n' +
        '  - references/a.md: missing on disk\n' +
        '  - .baseline.json: out of sync\n' +
        'Re-run: bun run build:skills\n',
    );
  });

  it('report a stale baseline even when every reference matches', async () => {
    const root = copyOfAssets();
    writeFileSync(join(root, '.baseline.json'), '{}\n');

    await expect(findDrift(root)).resolves.toEqual(['.baseline.json: out of sync']);
  });

  it('check out with LF endings on every OS, so a CRLF checkout cannot read as drift', () => {
    const generated = [
      'assets/skills/frink-flows/references/template-variables.md',
      'assets/skills/frink-flows/.baseline.json',
    ];
    const attrs = execFileSync('git', ['check-attr', 'text', 'eol', '--', ...generated], {
      cwd: resolve(__dirname, '../..'),
      encoding: 'utf8',
    });

    for (const path of generated) {
      expect(attrs).toContain(`${path}: text: set`);
      expect(attrs).toContain(`${path}: eol: lf`);
    }
  });

  it('document the blank-path advisory and its guard in the guideline source', () => {
    const guideline = getTemplateVariablesGuideline();

    expect(guideline).toContain('A command placeholder directly beside `/`');
    expect(guideline).toContain('rm -rf "/tmp/work/${v:?}"');
  });
});
