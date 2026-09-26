import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  readExistingRegisteredNode,
  registerNodeArgsSchema,
  validateJavaScriptSource,
} from './register-node-support';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

const INLINE_MANIFEST = { name: 'example-node', entrypoint: 'index.js' };

describe('register-node JavaScript contract', () => {
  it('accepts a package path or an inline manifest + scriptContent, with optional test input', () => {
    expect(
      registerNodeArgsSchema.safeParse({
        packagePath: 'custom-nodes/example-node',
        test: { config: { limit: 2 }, timeoutMs: 10_000 },
      }).success,
    ).toBe(true);
    expect(
      registerNodeArgsSchema.safeParse({
        manifest: INLINE_MANIFEST,
        scriptContent: 'console.log("ok")',
      }).success,
    ).toBe(true);
  });

  it('rejects mixing inline fields with packagePath, and incomplete inline pairs', () => {
    const both = registerNodeArgsSchema.safeParse({
      packagePath: 'custom-nodes/example-node',
      manifest: INLINE_MANIFEST,
      scriptContent: 'console.log("ok")',
    });
    expect(both.success).toBe(false);
    expect(JSON.stringify(both.error?.issues)).toContain('not both');

    const neither = registerNodeArgsSchema.safeParse({});
    expect(neither.success).toBe(false);
    expect(JSON.stringify(neither.error?.issues)).toContain('manifest and scriptContent together');

    expect(registerNodeArgsSchema.safeParse({ manifest: INLINE_MANIFEST }).success).toBe(false);
    expect(registerNodeArgsSchema.safeParse({ scriptContent: 'console.log("ok")' }).success).toBe(
      false,
    );
  });

  it('rejects reserved names before anything is staged: the integrations folder and plugin namespaces', () => {
    for (const name of ['integrations', 'shortcut_create_story']) {
      const inline = registerNodeArgsSchema.safeParse({
        manifest: { ...INLINE_MANIFEST, name },
        scriptContent: 'console.log("ok")',
      });
      expect(inline.success).toBe(false);
      expect(JSON.stringify(inline.error?.issues)).toContain('name is reserved');
    }
  });

  it('bounds scriptContent size and test timeouts', () => {
    expect(
      registerNodeArgsSchema.safeParse({
        manifest: INLINE_MANIFEST,
        scriptContent: 'x'.repeat(100 * 1024 + 1),
      }).success,
    ).toBe(false);
    expect(
      registerNodeArgsSchema.safeParse({
        packagePath: 'node',
        test: { timeoutMs: 999 },
      }).success,
    ).toBe(false);
    expect(
      registerNodeArgsSchema.safeParse({
        packagePath: 'node',
        test: { timeoutMs: 120_001 },
      }).success,
    ).toBe(false);
  });

  it('accepts plain ESM JavaScript including top-level await', () => {
    expect(
      validateJavaScriptSource(
        "import { readFile } from 'node:fs/promises';\nawait readFile(process.argv[1]);\n",
        'index.js',
      ),
    ).toBeNull();
  });

  it('accepts valid JavaScript that resembles TypeScript generic syntax', () => {
    expect(validateJavaScriptSource('score < threshold > (baseline);\n', 'index.js')).toBeNull();
  });

  it('accepts a UTF-8 BOM before valid JavaScript', () => {
    expect(validateJavaScriptSource('\uFEFFconst enabled = true;\n', 'index.js')).toBeNull();
  });

  it('rejects erasable TypeScript annotations', () => {
    expect(validateJavaScriptSource('const count: number = 1;\n', 'index.js')).toContain(
      'Use plain ESM JavaScript',
    );
  });

  it('rejects TypeScript syntax that requires transformation', () => {
    expect(validateJavaScriptSource('enum Mode { Fast }\n', 'index.js')).toContain(
      'JavaScript validation failed',
    );
  });

  it('reports invalid JavaScript syntax', () => {
    expect(validateJavaScriptSource('const = 1;\n', 'index.js')).toContain('Unexpected token');
  });

  it('reads generated package metadata and treats a missing install as absent', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'frink-existing-node-'));
    temporaryDirectories.push(directory);
    await writeFile(
      join(directory, 'manifest.json'),
      JSON.stringify({
        name: 'example',
        entrypoint: 'index.js',
        frinkPackage: {
          version: 1,
          digest: 'a'.repeat(64),
          resources: [],
          totalBytes: 32,
        },
      }),
    );

    await expect(readExistingRegisteredNode(directory)).resolves.toEqual({
      entrypoint: 'index.js',
      sourceMode: 'package',
    });
    await expect(readExistingRegisteredNode(join(directory, 'missing'))).resolves.toBeNull();
  });
});
