/**
 * Tests for custom node discovery from ~/.frink/nodes/.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  CUSTOM_NODES_DIR,
  discoverCustomNodes,
  MAX_ENTRYPOINT_READ_BYTES,
  readCustomNodeEntrypointPreview,
  removeLocalCustomNodeFolder,
} from './discovery';
import { writeCustomNodeFixture } from './test-helpers';

const TEST_DIR = join(tmpdir(), `frink-custom-nodes-test-${Date.now()}`);
const writeNode = writeCustomNodeFixture.bind(undefined, TEST_DIR);

beforeAll(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterAll(() => {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
});

beforeEach(() => {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
  mkdirSync(TEST_DIR, { recursive: true });
});

describe('discoverCustomNodes', () => {
  it('returns empty when directory does not exist', () => {
    const result = discoverCustomNodes('/tmp/nonexistent-frink-nodes-dir');
    expect(result.valid).toEqual([]);
    expect(result.manifestWarnings).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it('returns empty when directory is empty', () => {
    const result = discoverCustomNodes(TEST_DIR);
    expect(result.valid).toEqual([]);
    expect(result.manifestWarnings).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it('ignores dot-prefixed directories (e.g. crash-persisted .tmp- dirs)', () => {
    // Simulate a crash that left a .tmp- dir with a valid manifest.json
    // before the atomic rename could complete.
    const tmpDir = join(TEST_DIR, '.tmp-check-new-prs-abc123');
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(
      join(tmpDir, 'manifest.json'),
      JSON.stringify({
        name: 'check-new-prs',
        displayName: 'Check New PRs',
        description: 'Crash-persisted temp node',
        version: '1.0.0',
        entrypoint: 'run.js',
        timeout: 60,
        inputs: {},
      }),
    );
    writeFileSync(join(tmpDir, 'run.js'), 'console.log("ok")');

    const result = discoverCustomNodes(TEST_DIR);
    expect(result.valid).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it('discovers a valid manifest', () => {
    writeNode('check-new-prs', {
      name: 'check-new-prs',
      displayName: 'Check New PRs',
      description: 'Check GitHub for new PRs',
      version: '1.0.0',
      entrypoint: 'run.js',
      timeout: 60,
      inputs: {
        repo: { type: 'string', required: true },
      },
      outputs: { result: { type: 'string' } },
    });

    expect(readdirSync(TEST_DIR)).toContain('check-new-prs');
    expect(
      TEST_DIR === CUSTOM_NODES_DIR,
      'test tmp dir must not alias default nodes dir (reference)',
    ).toBe(false);
    const result = discoverCustomNodes(TEST_DIR);
    expect(result.errors, JSON.stringify(result.errors)).toHaveLength(0);
    expect(result.manifestWarnings).toEqual([]);
    expect(result.valid).toHaveLength(1);

    const node = result.valid[0];
    expect(node).toBeDefined();
    if (node === undefined) {
      throw new Error('expected one valid node');
    }
    expect(node.name).toBe('check-new-prs');
    expect(node.displayName).toBe('Check New PRs');
    expect(node).not.toHaveProperty('runtime');
    expect(node.entrypoint).toBe('run.js');
    expect(node.timeout).toBe(60);
    expect(node.inputs).toEqual({ repo: { type: 'string', required: true } });
    expect(node.nodePath).toBe(realpathSync(join(TEST_DIR, 'check-new-prs')));
  });

  it('reports a leftover integrations/ subtree by name and skips a leftover generated manifest', () => {
    mkdirSync(join(TEST_DIR, 'integrations', 'posthog_call_tool'), { recursive: true });
    writeFileSync(
      join(TEST_DIR, 'integrations', 'posthog_call_tool', 'manifest.json'),
      JSON.stringify({ name: 'posthog_call_tool', kind: 'plugin_mcp_tool' }),
    );
    mkdirSync(join(TEST_DIR, 'shortcut_get_story'), { recursive: true });
    writeFileSync(
      join(TEST_DIR, 'shortcut_get_story', 'manifest.json'),
      JSON.stringify({ name: 'shortcut_get_story', kind: 'plugin_operation' }),
    );
    const result = discoverCustomNodes(TEST_DIR);
    expect(result.valid).toEqual([]);
    expect(result.errors).toEqual([
      { dir: 'integrations', error: expect.stringContaining('delete this folder') },
    ]);
  });

  it('skips directories without manifest.json', () => {
    const dir = join(TEST_DIR, 'no-manifest');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'run.js'), 'console.log("hi")');

    const result = discoverCustomNodes(TEST_DIR);
    expect(result.valid).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it('reports error for invalid JSON in manifest', () => {
    const dir = join(TEST_DIR, 'bad-json');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'manifest.json'), '{not valid json');

    const result = discoverCustomNodes(TEST_DIR);
    expect(result.valid).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.dir).toBe('bad-json');
    expect(result.errors[0]?.error).toContain('failed to parse');
  });

  it('reports error for missing name', () => {
    writeNode('no-name', {
      entrypoint: 'run.js',
    });

    const result = discoverCustomNodes(TEST_DIR);
    expect(result.valid).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.error).toContain('name');
  });

  it('reports error for invalid name (uppercase)', () => {
    writeNode('upper', {
      name: 'Check-New-PRs',
      entrypoint: 'run.js',
    });

    const result = discoverCustomNodes(TEST_DIR);
    expect(result.valid).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.error).toContain('name');
  });

  it('rejects explicit runtime selectors with migration guidance', () => {
    for (const runtime of ['frink', 'bun', 'node', 'python', 'bash']) {
      writeNode(`runtime-${runtime}`, {
        name: `runtime-${runtime}`,
        runtime,
        entrypoint: 'run.js',
      });
    }

    const result = discoverCustomNodes(TEST_DIR);
    expect(result.valid).toHaveLength(0);
    expect(result.errors).toHaveLength(5);
    for (const error of result.errors) {
      expect(error.error).toContain('"runtime" is no longer supported');
      expect(error.error).toContain('Remove it and use a ".js" entrypoint');
      expect(error.error).toContain('bundled Node.js');
    }
  });

  it('reports error for missing entrypoint file', () => {
    const dir = join(TEST_DIR, 'missing-entry');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify({
        name: 'missing-entry',
        entrypoint: 'run.js',
      }),
    );

    const result = discoverCustomNodes(TEST_DIR);
    expect(result.valid).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.error).toContain('entrypoint');
  });

  it('defaults displayName to name when not provided', () => {
    writeNode('my-node', {
      name: 'my-node',
      entrypoint: 'run.js',
    });

    const result = discoverCustomNodes(TEST_DIR);
    expect(result.valid).toHaveLength(1);
    expect(result.valid[0]?.displayName).toBe('my-node');
  });

  it('defaults timeout to 60 when not provided', () => {
    writeNode('no-timeout', {
      name: 'no-timeout',
      entrypoint: 'run.js',
    });

    const result = discoverCustomNodes(TEST_DIR);
    expect(result.valid[0]?.timeout).toBe(60);
  });

  it('clamps timeout to 1-600', () => {
    writeNode('huge-timeout', {
      name: 'huge-timeout',
      entrypoint: 'run.js',
      timeout: 9999,
    });

    const result = discoverCustomNodes(TEST_DIR);
    expect(result.valid[0]?.timeout).toBe(600);
  });

  it('defaults inputs to empty object when not provided', () => {
    writeNode('no-inputs', {
      name: 'no-inputs',
      entrypoint: 'run.js',
    });

    const result = discoverCustomNodes(TEST_DIR);
    expect(result.valid[0]?.inputs).toEqual({});
  });

  it('discovers multiple valid nodes', () => {
    writeNode('node-a', { name: 'node-a', entrypoint: 'run.js' });
    writeNode('node-b', { name: 'node-b', entrypoint: 'run.js' });
    writeNode('node-c', { name: 'node-c', entrypoint: 'run.js' });

    const result = discoverCustomNodes(TEST_DIR);
    expect(result.valid).toHaveLength(3);
    const names = result.valid.map((n) => n.name).sort();
    expect(names).toEqual(['node-a', 'node-b', 'node-c']);
  });

  it('mixes valid and invalid nodes', () => {
    writeNode('good', { name: 'good', entrypoint: 'run.js' });
    writeNode('bad', { name: 'BAD', entrypoint: 'run.js' });

    const result = discoverCustomNodes(TEST_DIR);
    expect(result.valid).toHaveLength(1);
    expect(result.valid[0]?.name).toBe('good');
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.dir).toBe('bad');
  });

  it('ignores non-directory entries', () => {
    writeFileSync(join(TEST_DIR, 'stray-file.txt'), 'not a node');
    writeNode('valid', { name: 'valid', entrypoint: 'run.js' });

    const result = discoverCustomNodes(TEST_DIR);
    expect(result.valid).toHaveLength(1);
    expect(result.errors).toHaveLength(0);
  });

  it('reports error for manifest that is an array', () => {
    const dir = join(TEST_DIR, 'array-manifest');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'manifest.json'), '[]');
    writeFileSync(join(dir, 'run.js'), 'console.log("ok")');

    const result = discoverCustomNodes(TEST_DIR);
    expect(result.valid).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.error).toContain('not a JSON object');
  });

  it('rejects a non-.js entrypoint', () => {
    writeNode('typescript-node', { name: 'typescript-node', entrypoint: 'run.ts' });

    const result = discoverCustomNodes(TEST_DIR);
    expect(result.valid).toHaveLength(0);
    expect(result.errors[0]?.error).toContain('must use a ".js" entrypoint');
  });

  it('creates the nodes directory if it does not exist', () => {
    const newDir = join(tmpdir(), `frink-nodes-autocreate-${Date.now()}`);
    expect(existsSync(newDir)).toBe(false);
    const result = discoverCustomNodes(newDir);
    expect(result.valid).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
    expect(existsSync(newDir)).toBe(true);
    rmSync(newDir, { recursive: true, force: true });
  });

  it('clamps timeout minimum to 1 when given 0 or negative', () => {
    writeNode('zero-timeout', {
      name: 'zero-timeout',
      entrypoint: 'run.js',
      timeout: 0,
    });
    writeNode('neg-timeout', {
      name: 'neg-timeout',
      entrypoint: 'run.js',
      timeout: -10,
    });

    const result = discoverCustomNodes(TEST_DIR);
    expect(result.valid).toHaveLength(2);
    for (const node of result.valid) {
      expect(node.timeout).toBe(1);
    }
  });

  it('accepts names starting with a digit', () => {
    writeNode('1node', { name: '1node', entrypoint: 'run.js' });

    const result = discoverCustomNodes(TEST_DIR);
    expect(result.valid).toHaveLength(1);
    expect(result.valid[0]?.name).toBe('1node');
  });

  it('rejects names starting with a hyphen', () => {
    // dir name starts with hyphen, manifest name starts with hyphen
    const dir = join(TEST_DIR, 'hyphen-node');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify({ name: '-bad', entrypoint: 'run.js' }),
    );
    writeFileSync(join(dir, 'run.js'), 'console.log("ok")');

    const result = discoverCustomNodes(TEST_DIR);
    expect(result.valid).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.error).toContain('name');
  });

  it('rejects names with uppercase letters', () => {
    writeNode('upper', { name: 'MyNode', entrypoint: 'run.js' });

    const result = discoverCustomNodes(TEST_DIR);
    expect(result.valid).toHaveLength(0);
    expect(result.errors[0]?.error).toContain('name');
  });
});

describe('parseCredentials (via discoverCustomNodes)', () => {
  it('parses a valid credentials block', () => {
    writeNode('cred-node', {
      name: 'cred-node',
      entrypoint: 'run.js',
      credentials: {
        github: { required: true, label: 'GitHub PAT', envVar: 'GITHUB_TOKEN' },
        slack: { required: false, label: 'Slack Token', helpUrl: 'https://slack.com/tokens' },
      },
    });

    const result = discoverCustomNodes(TEST_DIR);
    expect(result.valid).toHaveLength(1);
    const node = result.valid[0];
    expect(node).toBeDefined();
    if (node === undefined) {
      throw new Error('expected one valid node');
    }
    const creds = node.credentials;
    expect(Object.keys(creds)).toEqual(['github', 'slack']);
    expect(creds.github).toEqual({
      required: true,
      label: 'GitHub PAT',
      helpUrl: undefined,
      envVar: 'GITHUB_TOKEN',
    });
    expect(creds.slack).toEqual({
      required: false,
      label: 'Slack Token',
      helpUrl: 'https://slack.com/tokens',
      envVar: undefined,
    });
  });

  it('defaults credentials to empty object when not provided', () => {
    writeNode('no-creds', {
      name: 'no-creds',
      entrypoint: 'run.js',
    });

    const result = discoverCustomNodes(TEST_DIR);
    expect(result.valid[0]?.credentials).toEqual({});
  });

  it('defaults required to false when not specified', () => {
    writeNode('opt-cred', {
      name: 'opt-cred',
      entrypoint: 'run.js',
      credentials: { token: { label: 'API Token' } },
    });

    const result = discoverCustomNodes(TEST_DIR);
    expect(result.valid[0]?.credentials.token?.required).toBe(false);
  });

  it('ignores non-object credential entries', () => {
    writeNode('bad-cred-entries', {
      name: 'bad-cred-entries',
      entrypoint: 'run.js',
      credentials: {
        valid: { label: 'OK' },
        string_entry: 'not-an-object',
        null_entry: null,
        array_entry: [1, 2, 3],
        number_entry: 42,
      },
    });

    const result = discoverCustomNodes(TEST_DIR);
    const node = result.valid[0];
    expect(node).toBeDefined();
    if (node === undefined) {
      throw new Error('expected one valid node');
    }
    const creds = node.credentials;
    expect(Object.keys(creds)).toEqual(['valid']);
  });

  it('ignores non-object credentials block (array)', () => {
    writeNode('array-creds', {
      name: 'array-creds',
      entrypoint: 'run.js',
      credentials: ['github-pat'],
    });

    const result = discoverCustomNodes(TEST_DIR);
    expect(result.valid[0]?.credentials).toEqual({});
  });

  it('ignores non-object credentials block (string)', () => {
    writeNode('string-creds', {
      name: 'string-creds',
      entrypoint: 'run.js',
      credentials: 'github-pat',
    });

    const result = discoverCustomNodes(TEST_DIR);
    expect(result.valid[0]?.credentials).toEqual({});
  });

  it('ignores non-string label, helpUrl, envVar', () => {
    writeNode('bad-types', {
      name: 'bad-types',
      entrypoint: 'run.js',
      credentials: {
        token: { label: 123, helpUrl: true, envVar: { nested: true } },
      },
    });

    const result = discoverCustomNodes(TEST_DIR);
    const node = result.valid[0];
    expect(node).toBeDefined();
    if (node === undefined) {
      throw new Error('expected one valid node');
    }
    const cred = node.credentials.token;
    expect(cred).toBeDefined();
    if (cred === undefined) {
      throw new Error('expected token credential');
    }
    expect(cred.label).toBeUndefined();
    expect(cred.helpUrl).toBeUndefined();
    expect(cred.envVar).toBeUndefined();
  });

  it('handles empty credentials object', () => {
    writeNode('empty-creds', {
      name: 'empty-creds',
      entrypoint: 'run.js',
      credentials: {},
    });

    const result = discoverCustomNodes(TEST_DIR);
    expect(result.valid[0]?.credentials).toEqual({});
  });
});

describe('outputs parsing', () => {
  function validBase() {
    return {
      name: 'my-node',
      entrypoint: 'run.js',
    };
  }

  it('parses flat outputs with all supported types', () => {
    writeNode('flat-outputs', {
      ...validBase(),
      outputs: {
        success: { type: 'boolean', description: 'Whether it succeeded' },
        count: { type: 'number', description: 'Item count' },
        message: { type: 'string', description: 'Status message' },
        meta: { type: 'object', description: 'Metadata object' },
        items: { type: 'array', description: 'Result list' },
      },
    });

    const result = discoverCustomNodes(TEST_DIR);
    const node = result.valid[0];
    expect(node).toBeDefined();
    if (node === undefined) {
      throw new Error('expected one valid node');
    }
    const outputs = node.outputs;
    expect(outputs).toBeDefined();
    if (outputs === undefined) {
      throw new Error('expected outputs');
    }
    expect(Object.keys(outputs)).toEqual(['success', 'count', 'message', 'meta', 'items']);
    expect(outputs.success).toEqual({ type: 'boolean', description: 'Whether it succeeded' });
    expect(outputs.count).toEqual({ type: 'number', description: 'Item count' });
    expect(outputs.items).toEqual({ type: 'array', description: 'Result list' });
  });

  it('parses array field with items sub-schema', () => {
    writeNode('array-outputs', {
      ...validBase(),
      outputs: {
        items: {
          type: 'array',
          description: 'PRs list',
          items: {
            headRefName: { type: 'string', description: 'Branch name' },
            number: { type: 'number', description: 'PR number' },
          },
        },
      },
    });

    const result = discoverCustomNodes(TEST_DIR);
    const node = result.valid[0];
    expect(node).toBeDefined();
    if (node === undefined) {
      throw new Error('expected one valid node');
    }
    const items = node.outputs?.items;
    expect(items).toBeDefined();
    if (items === undefined) {
      throw new Error('expected items output');
    }
    expect(items.type).toBe('array');
    expect(items.items).toEqual({
      headRefName: { type: 'string', description: 'Branch name' },
      number: { type: 'number', description: 'PR number' },
    });
  });

  it('caps recursion depth at 3 — ignores items on array fields at depth 3', () => {
    // Structure: top (depth 0) → n1 (depth 1) → n2 (depth 2) → n3 (depth 3, array) → leaf
    // n3 is at depth 3 and has items, but depth=3 is NOT < MAX_OUTPUTS_DEPTH=3 → items NOT parsed
    writeNode('deep-outputs', {
      ...validBase(),
      outputs: {
        top: {
          type: 'array',
          description: 'Top level',
          items: {
            n1: {
              type: 'array',
              description: 'Nesting 1',
              items: {
                n2: {
                  type: 'array',
                  description: 'Nesting 2',
                  items: {
                    n3: {
                      type: 'array',
                      description: 'Nesting 3 — AT depth 3, items should be capped',
                      items: {
                        leaf: { type: 'string', description: 'Should not appear' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    const result = discoverCustomNodes(TEST_DIR);
    const node = result.valid[0];
    expect(node).toBeDefined();
    if (node === undefined) {
      throw new Error('expected one valid node');
    }
    const outputs = node.outputs;
    expect(outputs).toBeDefined();
    if (outputs === undefined) {
      throw new Error('expected outputs');
    }
    // top (depth 0) → n1 (depth 1) → n2 (depth 2): all allowed
    expect(outputs.top?.items?.n1?.items?.n2?.type).toBe('array');
    // n3 is at depth 3 — the cap fires, so n2.items.n3.items is undefined
    const n3 = outputs.top?.items?.n1?.items?.n2?.items?.n3;
    expect(n3?.type).toBe('array');
    expect(n3?.items).toBeUndefined();
  });

  it('silently drops output fields with invalid types', () => {
    writeNode('invalid-type-outputs', {
      ...validBase(),
      outputs: {
        valid: { type: 'string', description: 'OK' },
        bad: { type: 'date', description: 'Not a supported type' },
        alsobad: { type: 123 },
      },
    });

    const result = discoverCustomNodes(TEST_DIR);
    const node = result.valid[0];
    expect(node).toBeDefined();
    if (node === undefined) {
      throw new Error('expected one valid node');
    }
    const outputs = node.outputs;
    expect(outputs).toBeDefined();
    if (outputs === undefined) {
      throw new Error('expected outputs');
    }
    expect(Object.keys(outputs)).toEqual(['valid']);
  });

  it('handles array-of-primitives (no items field)', () => {
    writeNode('primitive-array-outputs', {
      ...validBase(),
      outputs: {
        labels: { type: 'array', description: 'List of label names' },
      },
    });

    const result = discoverCustomNodes(TEST_DIR);
    const node = result.valid[0];
    expect(node).toBeDefined();
    if (node === undefined) {
      throw new Error('expected one valid node');
    }
    const labels = node.outputs?.labels;
    expect(labels).toBeDefined();
    if (labels === undefined) {
      throw new Error('expected labels output');
    }
    expect(labels.type).toBe('array');
    expect(labels.items).toBeUndefined();
  });

  it('omits outputs when field is absent', () => {
    writeNode('no-outputs', {
      ...validBase(),
    });

    const result = discoverCustomNodes(TEST_DIR);
    expect(result.valid[0]?.outputs).toBeUndefined();
  });

  it('omits outputs when outputs is null', () => {
    writeNode('null-outputs', {
      ...validBase(),
      outputs: null,
    });

    const result = discoverCustomNodes(TEST_DIR);
    expect(result.valid[0]?.outputs).toBeUndefined();
  });

  it('omits outputs when all entries have invalid types', () => {
    writeNode('all-invalid-outputs', {
      ...validBase(),
      outputs: {
        bad1: { type: 'date' },
        bad2: 'not-an-object',
        bad3: 42,
      },
    });

    const result = discoverCustomNodes(TEST_DIR);
    expect(result.valid[0]?.outputs).toBeUndefined();
  });
});

describe('manifestWarnings', () => {
  const minimalOutputs = { r: { type: 'string' as const } };

  it('warns when description is empty', () => {
    writeNode('no-desc', {
      name: 'no-desc',
      displayName: 'No Desc',
      description: '',
      version: '1.0.0',
      entrypoint: 'run.js',
      timeout: 60,
      inputs: {},
      outputs: minimalOutputs,
    });

    const result = discoverCustomNodes(TEST_DIR);
    expect(result.valid).toHaveLength(1);
    expect(result.manifestWarnings).toHaveLength(1);
    expect(result.manifestWarnings[0]?.name).toBe('no-desc');
    expect(result.manifestWarnings[0]?.warnings.some((w) => w.includes('description'))).toBe(true);
  });

  it('warns when displayName is omitted', () => {
    writeNode('no-display', {
      name: 'no-display',
      entrypoint: 'run.js',
      description: 'Has description',
      version: '1.0.0',
      timeout: 60,
      inputs: {},
      outputs: minimalOutputs,
    });

    const result = discoverCustomNodes(TEST_DIR);
    expect(result.valid).toHaveLength(1);
    expect(result.manifestWarnings[0]?.warnings.some((w) => w.includes('displayName'))).toBe(true);
  });

  it('warns when outputs are omitted', () => {
    writeNode('no-out', {
      name: 'no-out',
      displayName: 'No Out',
      description: 'd',
      version: '1.0.0',
      entrypoint: 'run.js',
      timeout: 60,
      inputs: {},
    });

    const result = discoverCustomNodes(TEST_DIR);
    expect(result.valid).toHaveLength(1);
    expect(result.manifestWarnings[0]?.warnings.some((w) => w.includes('outputs'))).toBe(true);
  });

  it('warns but still loads a node declaring an unsupported input type', () => {
    // "select" was documented for months with no implementation. Rejecting such a manifest would
    // make an installed node vanish from the flow editor for following the shipped docs.
    writeNode('legacy-select', {
      name: 'legacy-select',
      displayName: 'Legacy Select',
      description: 'd',
      version: '1.0.0',
      entrypoint: 'run.js',
      timeout: 60,
      inputs: { mode: { type: 'select' } },
      outputs: minimalOutputs,
    });

    const result = discoverCustomNodes(TEST_DIR);
    expect(result.valid).toHaveLength(1);
    expect(result.errors).toEqual([]);
    expect(result.manifestWarnings[0]?.warnings.some((w) => w.includes('mode'))).toBe(true);
  });

  it('warns when a declared default contradicts its declared input type', () => {
    writeNode('bad-default', {
      name: 'bad-default',
      displayName: 'Bad Default',
      description: 'd',
      version: '1.0.0',
      entrypoint: 'run.js',
      timeout: 60,
      inputs: { retries: { type: 'number', default: 'lots' } },
      outputs: minimalOutputs,
    });

    const result = discoverCustomNodes(TEST_DIR);
    expect(result.valid).toHaveLength(1);
    expect(result.manifestWarnings[0]?.warnings.some((w) => w.includes('retries'))).toBe(true);
  });

  it('warns for unknown icon key', () => {
    writeNode('bad-icon', {
      name: 'bad-icon',
      displayName: 'Bad Icon',
      description: 'd',
      version: '1.0.0',
      entrypoint: 'run.js',
      timeout: 60,
      inputs: {},
      outputs: minimalOutputs,
      icon: 'totally-unknown-icon',
    });

    const result = discoverCustomNodes(TEST_DIR);
    expect(result.valid).toHaveLength(1);
    expect(result.manifestWarnings[0]?.warnings.some((w) => w.includes('Unknown icon'))).toBe(true);
  });
});

describe('readCustomNodeEntrypointPreview', () => {
  const fullManifest = (name: string, entrypoint: string) => ({
    name,
    displayName: name,
    description: 'Test node',
    version: '1.0.0',
    entrypoint,
    timeout: 60,
    inputs: {},
    outputs: { r: { type: 'string' as const } },
  });

  it('rejects invalid node names', () => {
    const r = readCustomNodeEntrypointPreview('../evil', TEST_DIR);
    expect(r).toEqual({ ok: false, error: 'Invalid custom node name' });
  });

  it('returns JavaScript preview for a valid node', () => {
    writeNode('preview-ok', fullManifest('preview-ok', 'run.js'), '// hello\n');
    const r = readCustomNodeEntrypointPreview('preview-ok', TEST_DIR);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.language).toBe('javascript');
      expect(r.content).toContain('hello');
      expect(r.truncated).toBe(false);
    }
  });

  it('rejects entrypoint file that is not valid UTF-8', () => {
    writeNode('preview-bad-utf8', fullManifest('preview-bad-utf8', 'run.js'));
    writeFileSync(join(TEST_DIR, 'preview-bad-utf8', 'run.js'), Buffer.from([0xff, 0xfe]));
    const r = readCustomNodeEntrypointPreview('preview-bad-utf8', TEST_DIR);
    expect(r).toEqual({ ok: false, error: 'Entrypoint is not valid UTF-8 text' });
  });

  it('truncates when entrypoint exceeds max bytes', () => {
    writeNode('preview-big', fullManifest('preview-big', 'run.js'));
    writeFileSync(
      join(TEST_DIR, 'preview-big', 'run.js'),
      `${'x'.repeat(MAX_ENTRYPOINT_READ_BYTES + 4000)}\n`,
    );
    const r = readCustomNodeEntrypointPreview('preview-big', TEST_DIR);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.truncated).toBe(true);
      expect(Buffer.byteLength(r.content, 'utf8')).toBeLessThanOrEqual(
        MAX_ENTRYPOINT_READ_BYTES + 500,
      );
    }
  });

  it('rejects a non-JavaScript manifest before preview', () => {
    writeNode('preview-wasm', fullManifest('preview-wasm', 'code.wasm'));
    writeFileSync(join(TEST_DIR, 'preview-wasm', 'code.wasm'), Buffer.from([0, 1]));
    const r = readCustomNodeEntrypointPreview('preview-wasm', TEST_DIR);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('not found or invalid manifest');
    }
  });

  it.skipIf(process.platform === 'win32')(
    'rejects symlink entrypoint outside node directory',
    () => {
      const name = 'sym-out';
      const nodeDir = join(TEST_DIR, name);
      mkdirSync(nodeDir, { recursive: true });
      const outside = join(TEST_DIR, 'outside-entry.js');
      writeFileSync(outside, '// outside');
      symlinkSync(join('..', 'outside-entry.js'), join(nodeDir, 'entry.js'));
      writeFileSync(join(nodeDir, 'manifest.json'), JSON.stringify(fullManifest(name, 'entry.js')));

      const r = readCustomNodeEntrypointPreview(name, TEST_DIR);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toContain('not found or invalid manifest');
      }
    },
  );
});

describe('removeLocalCustomNodeFolder', () => {
  it('rejects invalid names', async () => {
    await expect(removeLocalCustomNodeFolder('../escape', TEST_DIR)).resolves.toEqual({
      ok: false,
      error: 'Invalid custom node name',
    });
  });

  it('rejects empty string and uppercase names', async () => {
    await expect(removeLocalCustomNodeFolder('', TEST_DIR)).resolves.toEqual({
      ok: false,
      error: 'Invalid custom node name',
    });
    await expect(removeLocalCustomNodeFolder('MyNode', TEST_DIR)).resolves.toEqual({
      ok: false,
      error: 'Invalid custom node name',
    });
  });

  it('returns removed false when folder is absent', async () => {
    const r = await removeLocalCustomNodeFolder('no-such-node', TEST_DIR);
    expect(r).toEqual({ ok: true, removed: false });
  });

  it('deletes the node directory under nodesDir', async () => {
    writeNode('to-delete', {
      name: 'to-delete',
      displayName: 'X',
      description: '',
      version: '1.0.0',
      entrypoint: 'run.js',
      timeout: 60,
      inputs: {},
    });
    expect(existsSync(join(TEST_DIR, 'to-delete'))).toBe(true);
    const r = await removeLocalCustomNodeFolder('to-delete', TEST_DIR);
    expect(r).toEqual({ ok: true, removed: true });
    expect(existsSync(join(TEST_DIR, 'to-delete'))).toBe(false);
  });
});
