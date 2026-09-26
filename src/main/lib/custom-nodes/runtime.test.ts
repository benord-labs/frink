import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildCustomNodeInputConfig,
  CUSTOM_NODE_ENTRYPOINT_EXTENSION,
  CUSTOM_NODE_RUNTIME_MIGRATION_MESSAGE,
  coerceCustomNodeInputValue,
  collectManifestInputWarnings,
  isCustomNodeEntrypoint,
  normalizeCustomNodeManifestFields,
  parseCustomNodeEntrypointSpec,
  readDeclaredInputType,
  resolveContainedCustomNodePath,
  resolveCustomNodeEntrypoint,
} from './runtime';

const tempDirs: string[] = [];

function createNodeRoot(): string {
  const base = mkdtempSync(join(tmpdir(), 'frink-custom-node-runtime-'));
  tempDirs.push(base);
  const root = join(base, 'node');
  mkdirSync(root);
  return root;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('custom node JavaScript policy', () => {
  it('accepts only the exact .js extension', () => {
    expect(CUSTOM_NODE_ENTRYPOINT_EXTENSION).toBe('.js');
    expect(isCustomNodeEntrypoint('index.js')).toBe(true);
    expect(isCustomNodeEntrypoint('tools/index.js')).toBe(true);
    expect(isCustomNodeEntrypoint('index.ts')).toBe(false);
    expect(isCustomNodeEntrypoint('index.mjs')).toBe(false);
    expect(isCustomNodeEntrypoint('index.JS')).toBe(false);
  });

  it('parses and trims the JavaScript entrypoint manifest contract', () => {
    expect(parseCustomNodeEntrypointSpec({ entrypoint: ' index.js ' })).toEqual({
      entrypoint: 'index.js',
    });
    expect(() => parseCustomNodeEntrypointSpec({ entrypoint: 'index.ts' })).toThrow(
      /must use a "\.js" entrypoint/,
    );
    expect(() => parseCustomNodeEntrypointSpec({ entrypoint: ' ' })).toThrow(/entrypoint/);
  });

  it('rejects obsolete runtime selectors with actionable migration guidance', () => {
    for (const runtime of ['frink', 'bun', 'node', 'python', 'bash']) {
      expect(() => parseCustomNodeEntrypointSpec({ runtime, entrypoint: 'index.js' })).toThrow(
        CUSTOM_NODE_RUNTIME_MIGRATION_MESSAGE,
      );
    }
  });

  it('passes only declared inputs, applies defaults, and withholds projectId', () => {
    expect(
      buildCustomNodeInputConfig(
        {
          repo: { type: 'string' },
          state: { type: 'string', default: 'open' },
          projectId: { type: 'string', default: 'must-not-leak' },
        },
        {
          repo: 'owner/repo',
          state: undefined,
          projectId: 'project-1',
          undeclared: 'must-not-leak',
        },
      ),
    ).toEqual({ ok: true, config: { repo: 'owner/repo', state: 'open' } });
  });

  it('coerces template-rendered values to their declared input types', () => {
    // Templates always render to a string, so a number/boolean input arrives here as text.
    expect(
      buildCustomNodeInputConfig(
        { temperature: { type: 'number' }, stormy: { type: 'boolean' } },
        { temperature: '12.5', stormy: 'false' },
      ),
    ).toEqual({ ok: true, config: { temperature: 12.5, stormy: false } });
  });

  it('is idempotent with the string workaround it replaces', () => {
    // Flows authored against the old "declare it string, parse it in the node" advice keep working.
    expect(buildCustomNodeInputConfig({ retries: { type: 'number' } }, { retries: '5' })).toEqual({
      ok: true,
      config: { retries: 5 },
    });
  });

  it('applies the declared default when a template resolves to nothing', () => {
    // A present-but-null upstream leaf renders to '' — coercing it would ship a fabricated 0.
    expect(
      buildCustomNodeInputConfig({ retries: { type: 'number', default: 3 } }, { retries: '' }),
    ).toEqual({ ok: true, config: { retries: 3 } });
  });

  it('omits a value that resolves to nothing and has no default, never defaulting it to zero', () => {
    expect(buildCustomNodeInputConfig({ retries: { type: 'number' } }, { retries: '' })).toEqual({
      ok: true,
      config: {},
    });
  });

  it('accepts a node that declares no inputs at all', () => {
    expect(buildCustomNodeInputConfig({}, {})).toEqual({ ok: true, config: {} });
  });

  it('fails when a declared-required input has no value and no default', () => {
    const result = buildCustomNodeInputConfig({ repo: { type: 'string', required: true } }, {});
    expect(result).toEqual({
      ok: false,
      error: 'is missing required input: "repo" not set',
    });
  });

  it('names every missing required input in one failure', () => {
    const result = buildCustomNodeInputConfig(
      {
        repo: { type: 'string', required: true },
        branch: { type: 'string', required: true },
        optional: { type: 'string' },
      },
      {},
    );
    expect(result).toEqual({
      ok: false,
      error: 'is missing required inputs: "repo", "branch" not set',
    });
  });

  it('distinguishes a never-set required input from one that resolved to an empty value', () => {
    // A required string that a template rendered away is absent in substance, not a valid ''.
    const result = buildCustomNodeInputConfig(
      { repo: { type: 'string', required: true }, branch: { type: 'string', required: true } },
      { branch: '' },
    );
    expect(result).toEqual({
      ok: false,
      error:
        'is missing required inputs: "repo" not set; "branch" resolved to an empty value — check the step it reads from',
    });
  });

  it('treats an explicit null as missing for a required input, matching the editor', () => {
    // frink_flows_patch writes config JSON directly, so a literal null is reachable. The design-time
    // check already calls this missing; the runtime must not disagree and ship null to the script.
    expect(
      buildCustomNodeInputConfig({ repo: { type: 'string', required: true } }, { repo: null }),
    ).toEqual({
      ok: false,
      error:
        'is missing required input: "repo" resolved to an empty value — check the step it reads from',
    });
  });

  it('still passes null through for an input that is not required', () => {
    expect(buildCustomNodeInputConfig({ note: { type: 'string' } }, { note: null })).toEqual({
      ok: true,
      config: { note: null },
    });
  });

  it('rejects null for a typed input rather than coercing it to zero or false', () => {
    // null never reaches the zod coercion: the non-string guard errors first, so a fabricated 0/false
    // can never be dispatched for a number or boolean input, configured or defaulted.
    expect(
      buildCustomNodeInputConfig({ n: { type: 'number', required: true } }, { n: null }),
    ).toEqual({ ok: false, error: 'input "n": expected number, got null' });
    expect(
      buildCustomNodeInputConfig({ n: { type: 'number', required: true, default: null } }, {}),
    ).toEqual({ ok: false, error: 'input "n" default: expected number, got null' });
    expect(
      buildCustomNodeInputConfig({ b: { type: 'boolean', required: true } }, { b: null }),
    ).toEqual({ ok: false, error: 'input "b": expected boolean, got null' });
  });

  it('treats zero and false as real values for a required input, never as missing', () => {
    // A falsy-but-valid reading must satisfy the requirement — guards against a future refactor
    // reaching for a plain truthiness check here.
    expect(
      buildCustomNodeInputConfig(
        { count: { type: 'number', required: true }, dryRun: { type: 'boolean', required: true } },
        { count: 0, dryRun: false },
      ),
    ).toEqual({ ok: true, config: { count: 0, dryRun: false } });
  });

  it('treats a whitespace-only value as missing for a required input', () => {
    expect(
      buildCustomNodeInputConfig({ repo: { type: 'string', required: true } }, { repo: '   ' }),
    ).toEqual({
      ok: false,
      error:
        'is missing required input: "repo" resolved to an empty value — check the step it reads from',
    });
  });

  it('rejects a required input whose declared default is itself blank', () => {
    // Required-plus-empty-default is contradictory; honouring it would dispatch the very empty
    // value the requirement exists to prevent.
    expect(
      buildCustomNodeInputConfig({ repo: { type: 'string', required: true, default: '' } }, {}),
    ).toEqual({
      ok: false,
      error: 'is missing required input: "repo" not set',
    });
  });

  it('still applies a blank declared default to an input that is not required', () => {
    expect(buildCustomNodeInputConfig({ note: { type: 'string', default: '' } }, {})).toEqual({
      ok: true,
      config: { note: '' },
    });
  });

  it('still accepts an empty string for an input that is not required', () => {
    expect(buildCustomNodeInputConfig({ note: { type: 'string' } }, { note: '' })).toEqual({
      ok: true,
      config: { note: '' },
    });
  });

  it('accepts a required input satisfied by the node config', () => {
    expect(
      buildCustomNodeInputConfig(
        { repo: { type: 'string', required: true } },
        { repo: 'owner/repo' },
      ),
    ).toEqual({ ok: true, config: { repo: 'owner/repo' } });
  });

  it('accepts a required input satisfied by its manifest default', () => {
    const schema = { state: { type: 'string', required: true, default: 'open' } };
    // Both when the key is absent and when a template rendered it away: the default lands first.
    expect(buildCustomNodeInputConfig(schema, {})).toEqual({
      ok: true,
      config: { state: 'open' },
    });
    expect(buildCustomNodeInputConfig(schema, { state: '' })).toEqual({
      ok: true,
      config: { state: 'open' },
    });
  });

  it('never treats reserved projectId as a required input', () => {
    // The project is chosen by its own control and may be inherited from the flow's settings.
    expect(
      buildCustomNodeInputConfig({ projectId: { type: 'string', required: true } }, {}),
    ).toEqual({ ok: true, config: {} });
  });

  it('leaves a non-boolean "required" optional rather than enforcing it', () => {
    expect(buildCustomNodeInputConfig({ repo: { type: 'string', required: 'true' } }, {})).toEqual({
      ok: true,
      config: {},
    });
  });

  it('still delivers a configured value whose declaration is malformed', () => {
    // A malformed declaration must degrade to optional, never swallow the user's value.
    expect(
      buildCustomNodeInputConfig(
        { repo: { type: 'string', required: 'true' } },
        { repo: 'owner/x' },
      ),
    ).toEqual({ ok: true, config: { repo: 'owner/x' } });
    expect(buildCustomNodeInputConfig({ repo: 'string' }, { repo: 'owner/x' })).toEqual({
      ok: true,
      config: { repo: 'owner/x' },
    });
    expect(buildCustomNodeInputConfig({ retries: { type: 123 } }, { retries: '5' })).toEqual({
      ok: true,
      config: { retries: '5' },
    });
  });

  it('still applies a declared default when a sibling field is malformed', () => {
    expect(
      buildCustomNodeInputConfig(
        { repo: { type: 'string', required: 'true', default: 'owner/x' } },
        {},
      ),
    ).toEqual({ ok: true, config: { repo: 'owner/x' } });
  });

  it('coerces declared defaults too', () => {
    expect(buildCustomNodeInputConfig({ retries: { type: 'number', default: '10' } }, {})).toEqual({
      ok: true,
      config: { retries: 10 },
    });
  });

  it('fails naming the input when a rendered value cannot be its declared type', () => {
    expect(
      buildCustomNodeInputConfig(
        { temperature: { type: 'number' } },
        { temperature: '{{previous.nope}}' },
      ),
    ).toEqual({
      ok: false,
      error: 'input "temperature": expected number, got "{{previous.nope}}"',
    });
  });

  it('rejects an MCP-authored config whose literal does not match the declared type', () => {
    // frink_flows_patch writes config JSON with no editor widget in between, so a boolean input can
    // arrive holding 0. Without this the script receives a number where its manifest promised a bool.
    expect(
      buildCustomNodeInputConfig({ stormy: { type: 'boolean' } }, { stormy: 0 }),
    ).toMatchObject({ ok: false });
    expect(
      buildCustomNodeInputConfig({ temperature: { type: 'number' } }, { temperature: true }),
    ).toMatchObject({ ok: false });
  });

  it('does not let an input named __proto__ pollute the built config', () => {
    const result = buildCustomNodeInputConfig(
      { __proto__: { type: 'string' }, safe: { type: 'string' } },
      { __proto__: 'polluted', safe: 'ok' },
    );

    expect(result.ok).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  });

  it('fails naming the input when a declared default cannot be its declared type', () => {
    expect(
      buildCustomNodeInputConfig({ retries: { type: 'number', default: 'lots' } }, {}),
    ).toEqual({ ok: false, error: 'input "retries" default: expected number, got "lots"' });
  });

  it('normalizes shared manifest defaults and clamps timeout', () => {
    expect(normalizeCustomNodeManifestFields('sample', { timeout: 9999 })).toEqual({
      displayName: 'sample',
      description: '',
      version: '1.0.0',
      timeout: 600,
      inputs: {},
      hadDisplayName: false,
    });
    expect(
      normalizeCustomNodeManifestFields('sample', {
        displayName: ' Sample Node ',
        description: 'Runs a sample',
        version: '2.0.0',
        timeout: 0,
        inputs: { value: { type: 'string' } },
      }),
    ).toEqual({
      displayName: 'Sample Node',
      description: 'Runs a sample',
      version: '2.0.0',
      timeout: 1,
      inputs: { value: { type: 'string' } },
      hadDisplayName: true,
    });
  });
});

describe('resolveCustomNodeEntrypoint', () => {
  it('resolves a contained path without requiring the entrypoint to exist', () => {
    const root = createNodeRoot();

    expect(resolveContainedCustomNodePath(root, 'tools/index.js')).toBe(
      resolve(root, 'tools/index.js'),
    );
    expect(() => resolveContainedCustomNodePath(root, '../outside.js')).toThrow(
      /cannot contain "\.\."/,
    );
    expect(() => resolveContainedCustomNodePath(root, '.')).toThrow(/outside node directory/);
  });

  it('returns the real path of a nested entrypoint inside the node root', () => {
    const root = createNodeRoot();
    mkdirSync(join(root, 'tools'));
    writeFileSync(join(root, 'tools', 'index.js'), 'console.log("ok")');

    expect(resolveCustomNodeEntrypoint(root, 'tools/index.js')).toBe(
      realpathSync(resolve(root, 'tools/index.js')),
    );
  });

  it('rejects absolute and parent-segment entrypoints before filesystem resolution', () => {
    const root = createNodeRoot();

    expect(() => resolveCustomNodeEntrypoint(root, '/tmp/outside.js')).toThrow(/must be relative/);
    expect(() => resolveCustomNodeEntrypoint(root, 'tools/../index.js')).toThrow(
      /cannot contain "\.\."/,
    );
  });

  it('rejects a symlink whose real target escapes the node root', () => {
    const root = createNodeRoot();
    const outside = join(root, '..', 'outside.js');
    writeFileSync(outside, 'console.log("outside")');
    symlinkSync(outside, join(root, 'index.js'));

    expect(() => resolveCustomNodeEntrypoint(root, 'index.js')).toThrow(
      /resolves outside node directory/,
    );
  });
});

describe('readDeclaredInputType', () => {
  it('falls back to string for absent, malformed, and unsupported types', () => {
    expect(readDeclaredInputType({ type: 'number' })).toBe('number');
    expect(readDeclaredInputType({ type: 'boolean' })).toBe('boolean');
    expect(readDeclaredInputType({})).toBe('string');
    expect(readDeclaredInputType(null)).toBe('string');
    expect(readDeclaredInputType(['number'])).toBe('string');
    // "select" was documented but never implemented; it must degrade, not break.
    expect(readDeclaredInputType({ type: 'select' })).toBe('string');
  });
});

describe('coerceCustomNodeInputValue', () => {
  it('converts template-rendered text back to the declared type', () => {
    expect(coerceCustomNodeInputValue('number', '12.5')).toEqual({ kind: 'value', value: 12.5 });
    expect(coerceCustomNodeInputValue('number', '  7 ')).toEqual({ kind: 'value', value: 7 });
    expect(coerceCustomNodeInputValue('boolean', 'true')).toEqual({ kind: 'value', value: true });
  });

  it('renders a false upstream boolean as false, not true', () => {
    // z.coerce.boolean would return true here: Boolean('false') is true. z.stringbool must be used.
    expect(coerceCustomNodeInputValue('boolean', 'false')).toEqual({ kind: 'value', value: false });
    expect(coerceCustomNodeInputValue('boolean', 'False')).toEqual({ kind: 'value', value: false });
    expect(coerceCustomNodeInputValue('boolean', '0')).toEqual({ kind: 'value', value: false });
  });

  it('tolerates surrounding whitespace on both number and boolean', () => {
    // Command stdout is newline-terminated, so {{previous.output}} routinely renders "true\n".
    // z.coerce.number trims internally but z.stringbool does not — coercion must not be asymmetric.
    expect(coerceCustomNodeInputValue('boolean', 'true\n')).toEqual({ kind: 'value', value: true });
    expect(coerceCustomNodeInputValue('boolean', 'false\r\n')).toEqual({
      kind: 'value',
      value: false,
    });
    expect(coerceCustomNodeInputValue('boolean', '  true  ')).toEqual({
      kind: 'value',
      value: true,
    });
    expect(coerceCustomNodeInputValue('number', '12.5\n')).toEqual({ kind: 'value', value: 12.5 });
  });

  it('reports empty as missing rather than coercing it to zero', () => {
    // A present-but-null upstream leaf renders to ''. Number('') is 0 — a fabricated reading.
    expect(coerceCustomNodeInputValue('number', '')).toEqual({ kind: 'missing' });
    expect(coerceCustomNodeInputValue('number', '   ')).toEqual({ kind: 'missing' });
    expect(coerceCustomNodeInputValue('boolean', '')).toEqual({ kind: 'missing' });
  });

  it('rejects unresolved placeholders and mixed interpolation', () => {
    expect(coerceCustomNodeInputValue('number', '{{previous.nope}}')).toMatchObject({
      kind: 'error',
    });
    expect(coerceCustomNodeInputValue('number', 'v{{previous.count}}')).toMatchObject({
      kind: 'error',
    });
    expect(coerceCustomNodeInputValue('boolean', 'maybe')).toMatchObject({ kind: 'error' });
    expect(coerceCustomNodeInputValue('number', 'NaN')).toMatchObject({ kind: 'error' });
    expect(coerceCustomNodeInputValue('number', 'Infinity')).toMatchObject({ kind: 'error' });
  });

  it('names the declared type and the offending value in the error', () => {
    const result = coerceCustomNodeInputValue('number', '{{previous.nope}}');
    expect(result).toEqual({
      kind: 'error',
      error: 'expected number, got "{{previous.nope}}"',
    });
  });

  it('passes through values that are already the declared type', () => {
    expect(coerceCustomNodeInputValue('number', 42)).toEqual({ kind: 'value', value: 42 });
    expect(coerceCustomNodeInputValue('boolean', false)).toEqual({ kind: 'value', value: false });
  });

  it('rejects a native value of the wrong type', () => {
    // frink_flows_patch writes config JSON directly, so a wrong-typed literal never passes through
    // an editor widget. The declared type is the authority for these too, not just for templates.
    expect(coerceCustomNodeInputValue('boolean', 0)).toMatchObject({ kind: 'error' });
    expect(coerceCustomNodeInputValue('boolean', 1)).toMatchObject({ kind: 'error' });
    expect(coerceCustomNodeInputValue('number', true)).toMatchObject({ kind: 'error' });
    expect(coerceCustomNodeInputValue('number', { value: 3 })).toMatchObject({ kind: 'error' });
    expect(coerceCustomNodeInputValue('number', [3])).toMatchObject({ kind: 'error' });
    expect(coerceCustomNodeInputValue('boolean', null)).toMatchObject({ kind: 'error' });
  });

  it('treats zero and false as real values, never as missing', () => {
    // The classic falsy bug: 0 and false are legitimate readings, not absent ones.
    expect(coerceCustomNodeInputValue('number', '0')).toEqual({ kind: 'value', value: 0 });
    expect(coerceCustomNodeInputValue('number', 0)).toEqual({ kind: 'value', value: 0 });
    expect(coerceCustomNodeInputValue('number', '-0')).toEqual({ kind: 'value', value: -0 });
    expect(coerceCustomNodeInputValue('boolean', false)).toEqual({ kind: 'value', value: false });
  });

  it('handles negative and large numeric boundaries', () => {
    expect(coerceCustomNodeInputValue('number', '-1')).toEqual({ kind: 'value', value: -1 });
    expect(coerceCustomNodeInputValue('number', String(Number.MAX_SAFE_INTEGER))).toEqual({
      kind: 'value',
      value: Number.MAX_SAFE_INTEGER,
    });
    // Beyond MAX_SAFE_INTEGER JS silently loses precision. Documented, not guarded: a node needing
    // exact large ids should declare the input as a string.
    expect(coerceCustomNodeInputValue('number', '9007199254740993')).toEqual({
      kind: 'value',
      value: 9007199254740992,
    });
  });

  it('leaves string inputs untouched, including rendered JSON and empty text', () => {
    // resolvePath JSON.stringifies object/array leaves, so {{previous.items}} arrives as JSON text.
    expect(coerceCustomNodeInputValue('string', '["a","b"]')).toEqual({
      kind: 'value',
      value: '["a","b"]',
    });
    expect(coerceCustomNodeInputValue('string', '')).toEqual({ kind: 'value', value: '' });
    expect(coerceCustomNodeInputValue('string', '{{previous.nope}}')).toEqual({
      kind: 'value',
      value: '{{previous.nope}}',
    });
  });
});

describe('collectManifestInputWarnings', () => {
  it('warns without rejecting when an input declares an unsupported type', () => {
    const warnings = collectManifestInputWarnings({ mode: { type: 'select' } });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('"mode"');
    expect(warnings[0]).toContain('listOptions');
  });

  it('warns when a declared default cannot be its declared type', () => {
    const warnings = collectManifestInputWarnings({ retries: { type: 'number', default: 'lots' } });
    expect(warnings).toEqual([
      'Input "retries" default does not match its declared type — expected number, got "lots"',
    ]);
  });

  it('warns when "required" is not a boolean, since it is then silently ignored', () => {
    expect(collectManifestInputWarnings({ repo: { type: 'string', required: 'true' } })).toEqual([
      'Input "repo" declares a non-boolean "required" ("true") — treated as optional. Use true or false.',
    ]);
  });

  it('stays silent for well-formed inputs', () => {
    expect(
      collectManifestInputWarnings({
        repo: { type: 'string' },
        retries: { type: 'number', default: 3 },
        coerced: { type: 'number', default: '3' },
        dryRun: { type: 'boolean', default: false },
        picker: { type: 'string', listOptions: true },
      }),
    ).toEqual([]);
  });
});
