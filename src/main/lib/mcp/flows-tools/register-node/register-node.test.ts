import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { JsonValue, PermissionPresentation } from '../../../../../shared/types/permissions';
import { expectMcpResultText as expectResultText } from '../test-helpers';
import { expectedPackageState } from './package/expected-package-state';

const state = vi.hoisted(() => ({
  captureMainException: vi.fn(),
  discoverCustomNodes: vi.fn(),
  invalidateCustomNodesDiscoveryCache: vi.fn(),
  mkdir: vi.fn(),
  readBoundedInstalledFile: vi.fn(),
  readExistingRegisteredNode: vi.fn(),
  readInstalledPackageState: vi.fn(),
  rehashPackageDirectory: vi.fn(),
  replaceDirectory: vi.fn(),
  rm: vi.fn(),
  runCustomNodeScript: vi.fn(),
  stagePackageDirectory: vi.fn(),
  stageRegistrationPackage: vi.fn(),
  writeFile: vi.fn(),
}));

const DIGEST = 'a'.repeat(64);
const MANIFEST = {
  name: 'read-image',
  displayName: 'Read Image',
  description: 'Reads one colocated image',
  version: '1.0.0',
  entrypoint: 'index.js',
  credentials: { image_api: { required: true } },
  inputs: { limit: { type: 'number' } },
};
const SNAPSHOT = {
  digest: DIGEST,
  entrypointBytes: Buffer.from('console.log(JSON.stringify({ bytes: 4 }));'),
  manifestBytes: Buffer.from(JSON.stringify(MANIFEST)),
  modules: [],
  resources: [{ path: 'cinder.png', bytes: 4, hash: 'resource-hash' }],
  resourcePaths: ['cinder.png'],
  sourceManifest: MANIFEST,
  totalBytes: 100,
};
const DISCOVERED = {
  ...MANIFEST,
  nodePath: '/home/testuser/.frink/nodes/read-image',
};

function generatedWriteBytes(filename: string): Buffer {
  const call = [...state.writeFile.mock.calls]
    .reverse()
    .find(([path]) => String(path).endsWith(`/candidate/${filename}`));
  if (!call) throw new Error(`Missing generated ${filename} write`);
  const value = z.union([z.string(), z.instanceof(Buffer)]).parse(call[1]);
  return Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
}

function expectedCandidateState() {
  return expectedPackageState({
    entrypoint: MANIFEST.entrypoint,
    manifestBytes: generatedWriteBytes('manifest.json'),
    packageJsonBytes: generatedWriteBytes('package.json'),
    snapshot: SNAPSHOT,
  });
}

// Every fs call is mocked and assertions name this root; it replaces the vitest.config.ts floor.
vi.stubEnv('FRINK_CUSTOM_NODES_DIR', '/home/testuser/.frink/nodes');

async function getModule() {
  return import('./register-node');
}

async function installDependencySpies(): Promise<void> {
  const { registerNodeDependencies } = await import('./register-node-dependencies');
  vi.spyOn(registerNodeDependencies, 'mkdir').mockImplementation(state.mkdir);
  vi.spyOn(registerNodeDependencies, 'rm').mockImplementation(state.rm);
  vi.spyOn(registerNodeDependencies, 'writeFile').mockImplementation(state.writeFile);
  vi.spyOn(registerNodeDependencies, 'homedir').mockReturnValue('/home/testuser');
  vi.spyOn(registerNodeDependencies, 'frinkUserHome').mockReturnValue('/home/testuser');
  vi.spyOn(registerNodeDependencies, 'discoverCustomNodes').mockImplementation(
    state.discoverCustomNodes,
  );
  vi.spyOn(registerNodeDependencies, 'invalidateCustomNodesDiscoveryCache').mockImplementation(
    state.invalidateCustomNodesDiscoveryCache,
  );
  vi.spyOn(registerNodeDependencies, 'runCustomNodeScript').mockImplementation(
    state.runCustomNodeScript,
  );
  vi.spyOn(registerNodeDependencies, 'replaceDirectory').mockImplementation(state.replaceDirectory);
  vi.spyOn(registerNodeDependencies, 'captureMainException').mockImplementation(
    state.captureMainException,
  );
  vi.spyOn(registerNodeDependencies, 'readBoundedInstalledFile').mockImplementation(
    state.readBoundedInstalledFile,
  );
  vi.spyOn(registerNodeDependencies, 'readInstalledPackageState').mockImplementation(
    state.readInstalledPackageState,
  );
  vi.spyOn(registerNodeDependencies, 'stageRegistrationPackage').mockImplementation(
    state.stageRegistrationPackage,
  );
  vi.spyOn(registerNodeDependencies, 'readExistingRegisteredNode').mockImplementation(
    state.readExistingRegisteredNode,
  );
  vi.spyOn(registerNodeDependencies, 'rehashPackageDirectory').mockImplementation(
    state.rehashPackageDirectory,
  );
  vi.spyOn(registerNodeDependencies, 'stagePackageDirectory').mockImplementation(
    state.stagePackageDirectory,
  );
}

async function register(
  authorize: (
    presentation: PermissionPresentation,
    signal?: AbortSignal,
  ) => Promise<{ allowed: true } | { allowed: false; reason?: string }>,
  args: Record<string, JsonValue> = { packagePath: 'examples/read-image' },
  projectPath: string | undefined = '/workspace/project',
) {
  const { handleRegisterNode } = await getModule();
  return handleRegisterNode(args, 'execution-id', projectPath, {
    chatScoped: true,
    authorize,
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  await installDependencySpies();
  const { resetRegisterNodeCount } = await getModule();
  resetRegisterNodeCount();
  state.discoverCustomNodes.mockReturnValue({
    valid: [DISCOVERED],
    pluginNodes: [],
    manifestWarnings: [],
    errors: [],
  });
  state.mkdir.mockResolvedValue(undefined);
  state.readBoundedInstalledFile.mockResolvedValue(Buffer.from('console.log("old")'));
  state.readExistingRegisteredNode.mockResolvedValue(null);
  state.readInstalledPackageState.mockImplementation(async (path: string) =>
    path.includes('/candidate') ? expectedCandidateState() : null,
  );
  state.rehashPackageDirectory.mockResolvedValue(DIGEST);
  state.replaceDirectory.mockResolvedValue(undefined);
  state.rm.mockResolvedValue(undefined);
  state.runCustomNodeScript.mockResolvedValue({
    stdout: '{}',
    stderr: '',
    exitCode: 0,
  });
  state.stagePackageDirectory.mockResolvedValue(SNAPSHOT);
  state.stageRegistrationPackage.mockResolvedValue({
    ok: true,
    manifest: MANIFEST,
    snapshot: SNAPSHOT,
  });
  state.writeFile.mockResolvedValue(undefined);
});

describe('folder-authored custom-node registration', () => {
  it('rejects a call mixing inline fields with packagePath before reading anything', async () => {
    const authorize = vi.fn().mockResolvedValue({ allowed: true });
    const result = await register(authorize, {
      packagePath: 'examples/read-image',
      manifest: MANIFEST,
      scriptContent: 'console.log("agent copy")',
    });

    expect(expectResultText(result, true)).toContain('not both');
    expect(state.stageRegistrationPackage).not.toHaveBeenCalled();
    expect(authorize).not.toHaveBeenCalled();
  });

  it('requires a chat session and authorization, and steers project-less relative paths', async () => {
    const authorize = vi.fn().mockResolvedValue({ allowed: true });
    const { handleRegisterNode } = await getModule();
    const relativeWithoutProject = await handleRegisterNode(
      { packagePath: 'examples/read-image' },
      'execution-id',
      undefined,
      { chatScoped: true, authorize },
    );
    expect(expectResultText(relativeWithoutProject, true)).toContain('no project');

    const relativeInHomeProject = await handleRegisterNode(
      { packagePath: 'examples/read-image' },
      'execution-id',
      '/home/testuser',
      { chatScoped: true, authorize },
    );
    expect(expectResultText(relativeInHomeProject, true)).toContain('no project');

    const withoutChatSession = await handleRegisterNode(
      { packagePath: 'examples/read-image' },
      'execution-id',
      '/workspace/project',
      { chatScoped: false, authorize },
    );
    expect(expectResultText(withoutChatSession, true)).toContain('active Frink chat session');

    // SAFETY: Missing authorization is deliberate malformed input for the fail-closed test.
    const withoutAuthorization = await handleRegisterNode(
      { packagePath: 'examples/read-image' },
      'execution-id',
      '/workspace/project',
      undefined as never,
    );
    expect(expectResultText(withoutAuthorization, true)).toContain('authorization is required');
    expect(state.stageRegistrationPackage).not.toHaveBeenCalled();
  });

  it('registers an inline node without any files or project and reports an inline source', async () => {
    const authorize = vi.fn().mockResolvedValue({ allowed: true });
    const { handleRegisterNode } = await getModule();
    const result = await handleRegisterNode(
      {
        manifest: MANIFEST,
        scriptContent: 'console.log(JSON.stringify({ bytes: 4 }));',
        test: { config: { limit: 2 } },
      },
      'execution-id',
      undefined,
      { chatScoped: true, authorize },
    );

    const inlineWrites = state.writeFile.mock.calls
      .map(([path]) => String(path))
      .filter((path) => path.includes('/inline/'));
    expect(inlineWrites).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/\/\.frink-register-staging\/.+\/inline\/manifest\.json$/),
        expect.stringMatching(/\/\.frink-register-staging\/.+\/inline\/index\.js$/),
      ]),
    );
    expect(state.stageRegistrationPackage).toHaveBeenCalledWith(
      expect.objectContaining({
        packagePath: 'inline',
        projectRoot: expect.stringContaining('/.frink-register-staging/'),
      }),
    );
    expect(authorize).toHaveBeenCalledWith(
      expect.not.objectContaining({ packagePath: expect.anything() }),
      undefined,
    );
    const body = JSON.parse(expectResultText(result));
    expect(body).toEqual(
      expect.objectContaining({ success: true, registered: true, source: 'inline' }),
    );
    expect(body.packagePath).toBeUndefined();
    expect(body.testResult.exitCode).toBe(0);
  });

  it('refuses an inline entrypoint with separators before writing any file', async () => {
    const authorize = vi.fn().mockResolvedValue({ allowed: true });
    const result = await register(authorize, {
      manifest: { ...MANIFEST, entrypoint: 'nested/index.js' },
      scriptContent: 'console.log("x");',
    });

    expect(expectResultText(result, true)).toContain('plain filename');
    expect(state.writeFile).not.toHaveBeenCalled();
    expect(state.stageRegistrationPackage).not.toHaveBeenCalled();
  });

  it('warns when an inline registration replaces a folder-installed package', async () => {
    state.readInstalledPackageState.mockImplementation(async (path: string) =>
      path.includes('/candidate')
        ? expectedCandidateState()
        : {
            digest: 'old-target',
            files: [
              { path: 'manifest.json', bytes: 20, hash: 'manifest' },
              { path: 'index.js', bytes: 18, hash: 'entrypoint' },
              { path: 'lib/helper.js', bytes: 12, hash: 'module' },
              { path: 'notes.txt', bytes: 8, hash: 'resource' },
            ],
          },
    );
    state.readExistingRegisteredNode.mockResolvedValue({
      entrypoint: 'index.js',
      sourceMode: 'package',
    });
    const authorize = vi.fn().mockResolvedValue({ allowed: false });

    await register(authorize, { manifest: MANIFEST, scriptContent: 'console.log("solo");' });

    expect(authorize).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'replace',
        replacesPackage: true,
        modules: [expect.objectContaining({ path: 'lib/helper.js', change: 'removed' })],
        resources: expect.arrayContaining([
          expect.objectContaining({ path: 'notes.txt', change: 'removed' }),
        ]),
      }),
      undefined,
    );
  });

  it('resolves package paths against the project or an absolute folder and rejects unsafe ones', async () => {
    const deny = vi.fn().mockResolvedValue({ allowed: false });
    await register(deny, { packagePath: 'examples/read-image' });
    expect(state.stageRegistrationPackage).toHaveBeenCalledWith(
      expect.objectContaining({
        packagePath: 'examples/read-image',
        projectRoot: '/workspace/project',
      }),
    );

    await register(deny, { packagePath: '/elsewhere/read-image' });
    expect(state.stageRegistrationPackage).toHaveBeenCalledWith(
      expect.objectContaining({ packagePath: 'read-image', projectRoot: '/elsewhere' }),
    );
    expect(deny).toHaveBeenLastCalledWith(
      expect.objectContaining({ packagePath: '/elsewhere/read-image' }),
      undefined,
    );

    const tilde = await register(deny, { packagePath: '~/nodes/read-image' });
    expect(expectResultText(tilde, true)).toContain('~ is not expanded');

    const insideNodes = await register(deny, {
      packagePath: '/home/testuser/.frink/nodes/read-image',
    });
    expect(expectResultText(insideNodes, true)).toContain('where Frink keeps installed nodes');

    const root = await register(deny, { packagePath: '/' });
    expect(expectResultText(root, true)).toContain('filesystem root');
  });

  it('shows one host-produced preview and runs no custom code when denied', async () => {
    const authorize = vi.fn().mockResolvedValue({ allowed: false, reason: 'Denied by user' });
    const result = await register(authorize, {
      packagePath: 'misleading-folder-name',
      test: { config: { limit: 2 }, timeoutMs: 12_000 },
    });

    expect(expectResultText(result, true)).toBe('Denied by user');
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(authorize).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'create',
        packagePath: 'misleading-folder-name',
        node: expect.objectContaining({
          name: 'read-image',
          entrypoint: 'index.js',
        }),
        source: {
          current: SNAPSHOT.entrypointBytes.toString('utf8'),
          previous: undefined,
        },
        resources: [{ path: 'cinder.png', bytes: 4, change: 'added' }],
        credentialNames: ['image_api'],
        test: { config: { limit: 2 }, timeoutMs: 12_000 },
        packageDigest: DIGEST,
        packageBytes: 100,
      }),
      undefined,
    );
    expect(state.runCustomNodeScript).not.toHaveBeenCalled();
    expect(state.stagePackageDirectory).not.toHaveBeenCalled();
    expect(state.replaceDirectory).not.toHaveBeenCalled();
    expect(state.rm).not.toHaveBeenCalledWith(
      '/workspace/project/misleading-folder-name',
      expect.anything(),
    );
    expect(state.rm).toHaveBeenCalledWith(
      expect.stringContaining('/.frink-register-staging/'),
      expect.objectContaining({ recursive: true, force: true }),
    );
  });

  it('shows sibling module source separately from binary resources', async () => {
    const snapshot = {
      ...SNAPSHOT,
      modules: [
        {
          path: 'lib/helper.js',
          bytes: 24,
          hash: 'module-hash',
          source: 'export const value = 42;\n',
        },
      ],
      resourcePaths: ['cinder.png', 'lib/helper.js'],
    };
    state.stageRegistrationPackage.mockResolvedValueOnce({
      ok: true,
      manifest: MANIFEST,
      snapshot,
    });
    const authorize = vi.fn().mockResolvedValue({ allowed: false });

    await register(authorize);

    expect(authorize).toHaveBeenCalledWith(
      expect.objectContaining({
        modules: [
          {
            path: 'lib/helper.js',
            current: 'export const value = 42;\n',
            previous: undefined,
            change: 'added',
          },
        ],
        resources: [{ path: 'cinder.png', bytes: 4, change: 'added' }],
      }),
      undefined,
    );
  });

  it('installs a fresh generated candidate and returns source-package attestations', async () => {
    const result = await register(vi.fn().mockResolvedValue({ allowed: true }));

    const body = JSON.parse(expectResultText(result));
    expect(body).toEqual(
      expect.objectContaining({
        success: true,
        registered: true,
        source: 'package',
        packagePath: 'examples/read-image',
        packageDigest: DIGEST,
        packageResources: 1,
        packageBytes: 100,
      }),
    );
    expect(state.stagePackageDirectory).toHaveBeenCalledTimes(1);
    expect(state.replaceDirectory).toHaveBeenCalledWith(
      expect.stringContaining('/candidate'),
      '/home/testuser/.frink/nodes/read-image',
      expect.objectContaining({
        backupPath: expect.stringMatching(/\/nodes\/\.read-image\.backup-/),
        destinationExists: false,
        verifyBackup: expect.any(Function),
        verifyDestination: expect.any(Function),
      }),
    );
    expect(state.replaceDirectory.mock.calls[0]?.[2].backupPath).not.toContain(
      '.frink-register-staging',
    );
    expect(state.writeFile).toHaveBeenCalledWith(
      expect.stringContaining('/candidate/package.json'),
      expect.stringContaining('"type": "module"'),
      'utf8',
    );
    const removedPaths = state.rm.mock.calls.map(([path]) => String(path));
    expect(removedPaths).not.toContain('/workspace/project/examples/read-image');
    for (const path of removedPaths) {
      expect(path).toMatch(/\/\.frink-register-staging|\/\.authoring$/);
    }
  });

  it('tests a disposable clone before building the untouched install candidate', async () => {
    const result = await register(vi.fn().mockResolvedValue({ allowed: true }), {
      packagePath: 'examples/read-image',
      test: { config: { limit: 2 } },
    });

    expect(JSON.parse(expectResultText(result)).testResult.exitCode).toBe(0);
    expect(state.stagePackageDirectory).toHaveBeenCalledTimes(2);
    expect(state.stagePackageDirectory.mock.calls[0]?.[0].stagingRoot).toContain('/test');
    expect(state.runCustomNodeScript.mock.calls[0]?.[0].nodePath).toContain('/test');
    expect(state.stagePackageDirectory.mock.calls[1]?.[0].stagingRoot).toContain('/candidate');
    expect(state.stagePackageDirectory.mock.invocationCallOrder[1]).toBeGreaterThan(
      state.runCustomNodeScript.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('leaves the installed node untouched when the staged test times out', async () => {
    state.runCustomNodeScript.mockResolvedValueOnce({
      stdout: '',
      stderr: 'timed out',
      exitCode: 124,
      timedOut: true,
    });

    const result = await register(vi.fn().mockResolvedValue({ allowed: true }), {
      packagePath: 'examples/read-image',
      test: { config: {}, timeoutMs: 1_000 },
    });

    expect(expectResultText(result, true)).toContain('staged test failed');
    expect(state.stagePackageDirectory).toHaveBeenCalledOnce();
    expect(state.replaceDirectory).not.toHaveBeenCalled();
  });

  it('fails safely if the captured source changes after consent', async () => {
    state.rehashPackageDirectory.mockResolvedValueOnce('b'.repeat(64));
    const result = await register(vi.fn().mockResolvedValue({ allowed: true }));

    expect(expectResultText(result, true)).toContain('Captured source package changed');
    expect(state.replaceDirectory).not.toHaveBeenCalled();
  });

  it('does not install when cancellation arrives during final source verification', async () => {
    const controller = new AbortController();
    state.rehashPackageDirectory.mockImplementationOnce(async () => {
      controller.abort();
      return DIGEST;
    });
    const { handleRegisterNode } = await getModule();
    const result = await handleRegisterNode(
      { packagePath: 'examples/read-image' },
      'execution-id',
      '/workspace/project',
      {
        chatScoped: true,
        authorize: vi.fn().mockResolvedValue({ allowed: true }),
        signal: controller.signal,
      },
    );

    expect(expectResultText(result, true)).toContain('cancelled');
    expect(state.replaceDirectory).not.toHaveBeenCalled();
  });

  it('does not install when the approved execution becomes stale during its test', async () => {
    let current = true;
    state.runCustomNodeScript.mockImplementationOnce(async () => {
      current = false;
      return { stdout: '{}', stderr: '', exitCode: 0, timedOut: false };
    });
    const { handleRegisterNode } = await getModule();
    const result = await handleRegisterNode(
      { packagePath: 'examples/read-image', test: { config: {} } },
      'execution-id',
      '/workspace/project',
      {
        chatScoped: true,
        authorize: vi.fn().mockResolvedValue({ allowed: true }),
        isExecutionCurrent: () => current,
      },
    );

    expect(expectResultText(result, true)).toContain('no longer active');
    expect(state.replaceDirectory).not.toHaveBeenCalled();
  });

  it('rechecks execution freshness immediately before replacement', async () => {
    let current = true;
    state.rehashPackageDirectory.mockImplementationOnce(async () => {
      current = false;
      return DIGEST;
    });
    const { handleRegisterNode } = await getModule();
    const result = await handleRegisterNode(
      { packagePath: 'examples/read-image' },
      'execution-id',
      '/workspace/project',
      {
        chatScoped: true,
        authorize: vi.fn().mockResolvedValue({ allowed: true }),
        isExecutionCurrent: () => current,
      },
    );

    expect(expectResultText(result, true)).toContain('no longer active');
    expect(state.replaceDirectory).not.toHaveBeenCalled();
  });

  it('rejects source manifests whose generated managed metadata would exceed the limit', async () => {
    const authorize = vi.fn().mockResolvedValue({ allowed: true });
    const inputs = Object.fromEntries(
      Array.from({ length: 3_300 }, (_, index) => [`input_${index}`, { type: 'string' }]),
    );
    const manifest = { ...MANIFEST, inputs };
    const manifestBytes = Buffer.from(JSON.stringify(manifest));
    expect(manifestBytes.byteLength).toBeLessThanOrEqual(100 * 1024);
    state.stageRegistrationPackage.mockResolvedValueOnce({
      ok: true,
      manifest,
      snapshot: {
        ...SNAPSHOT,
        manifestBytes,
        sourceManifest: manifest,
        totalBytes: manifestBytes.byteLength + SNAPSHOT.entrypointBytes.byteLength + 4,
      },
    });

    const result = await register(authorize);

    expect(expectResultText(result, true)).toContain(
      'Generated manifest exceeds 100 KiB metadata limit',
    );
    expect(authorize).not.toHaveBeenCalled();
    expect(state.stagePackageDirectory).not.toHaveBeenCalled();
    expect(state.replaceDirectory).not.toHaveBeenCalled();
  });

  it('fails safely if the installed target changes during approval', async () => {
    const changed = { digest: 'target-changed', files: [] };
    let targetRead = 0;
    state.readInstalledPackageState.mockImplementation(async (path: string) => {
      if (path.includes('/candidate')) return expectedCandidateState();
      targetRead += 1;
      return targetRead > 2 ? changed : null;
    });
    const result = await register(vi.fn().mockResolvedValue({ allowed: true }));

    expect(expectResultText(result, true)).toContain('changed while approval');
    expect(state.replaceDirectory).not.toHaveBeenCalled();
  });

  it('rejects a detached-style candidate mutation instead of trusting it as the baseline', async () => {
    state.readInstalledPackageState.mockImplementation(async (path: string) => {
      if (!path.includes('/candidate')) return null;
      return { digest: 'mutated-before-first-read', files: [] };
    });
    const result = await register(vi.fn().mockResolvedValue({ allowed: true }));

    expect(expectResultText(result, true)).toContain('install candidate changed');
    expect(state.replaceDirectory).not.toHaveBeenCalled();
  });

  it('detects candidate mutation after the final pre-swap check', async () => {
    let replacementStarted = false;
    state.readInstalledPackageState.mockImplementation(async (path: string) => {
      if (path.includes('/candidate')) return expectedCandidateState();
      if (replacementStarted) return { digest: 'post-swap-mutation', files: [] };
      return null;
    });
    state.replaceDirectory.mockImplementation(async (_source, destination, options) => {
      replacementStarted = true;
      await options.verifyDestination(destination);
    });

    const result = await register(vi.fn().mockResolvedValue({ allowed: true }));

    expect(expectResultText(result, true)).toContain(
      'Installed custom node does not match the approved package snapshot',
    );
    expect(state.replaceDirectory).toHaveBeenCalledOnce();
  });

  it('verifies the renamed target baseline before installing a replacement', async () => {
    const target = { digest: 'old-target', files: [] };
    state.readExistingRegisteredNode.mockResolvedValue({
      entrypoint: 'index.js',
      sourceMode: 'managed',
    });
    state.readInstalledPackageState.mockImplementation(async (path: string) => {
      if (path.includes('/candidate')) return expectedCandidateState();
      if (path.includes('/.read-image.backup-')) {
        return { digest: 'changed-at-swap', files: [] };
      }
      return target;
    });
    state.replaceDirectory.mockImplementation(async (_source, _destination, options) => {
      await options.verifyBackup(options.backupPath);
    });

    const result = await register(vi.fn().mockResolvedValue({ allowed: true }));

    expect(expectResultText(result, true)).toContain(
      'Installed custom node changed immediately before replacement',
    );
    expect(state.replaceDirectory).toHaveBeenCalledOnce();
  });

  it('describes a full legacy replacement including resource changes', async () => {
    const existing = {
      digest: 'old-target',
      files: [
        { path: 'manifest.json', bytes: 20, hash: 'manifest' },
        { path: 'index.js', bytes: 18, hash: 'entrypoint' },
        { path: 'cinder.png', bytes: 3, hash: 'old-resource' },
        { path: 'retired.txt', bytes: 8, hash: 'retired-resource' },
      ],
    };
    state.readInstalledPackageState.mockResolvedValue(existing);
    state.readExistingRegisteredNode.mockResolvedValue({
      entrypoint: 'index.js',
      sourceMode: 'legacy',
    });
    const authorize = vi.fn().mockResolvedValue({ allowed: false });
    await register(authorize);

    expect(authorize).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'replace',
        source: expect.objectContaining({ previous: 'console.log("old")' }),
        resources: [
          { path: 'cinder.png', bytes: 4, change: 'changed' },
          { path: 'retired.txt', bytes: 8, change: 'removed' },
        ],
      }),
      undefined,
    );
  });

  it('permits only one globally prepared registration while consent is pending', async () => {
    let decide: ((decision: { allowed: false }) => void) | undefined;
    const pending = new Promise<{ allowed: false }>((resolve) => {
      decide = resolve;
    });
    const first = register(() => pending);
    await vi.waitFor(() => expect(state.stageRegistrationPackage).toHaveBeenCalledTimes(1));
    const concurrent = await register(vi.fn().mockResolvedValue({ allowed: true }));

    expect(expectResultText(concurrent, true)).toContain('awaiting approval');
    expect(state.stageRegistrationPackage).toHaveBeenCalledTimes(1);
    decide?.({ allowed: false });
    await first;
  });

  it('reserves the per-session rate slot before copying another package', async () => {
    const { MAX_REGISTER_NODE_PER_SESSION } = await import('./register-node-support');
    const deny = vi.fn().mockResolvedValue({ allowed: false });
    for (let attempt = 0; attempt < MAX_REGISTER_NODE_PER_SESSION; attempt += 1) {
      await register(deny);
    }
    expect(state.stageRegistrationPackage).toHaveBeenCalledTimes(MAX_REGISTER_NODE_PER_SESSION);

    const result = await register(deny);

    expect(expectResultText(result, true)).toContain('Rate limit');
    expect(state.stageRegistrationPackage).toHaveBeenCalledTimes(MAX_REGISTER_NODE_PER_SESSION);
  });

  it('passes cancellation to the authorization and test boundaries', async () => {
    const controller = new AbortController();
    const authorize = vi.fn().mockImplementation(async (_preview, signal) => {
      expect(signal).toBe(controller.signal);
      controller.abort();
      return { allowed: true } as const;
    });
    const { handleRegisterNode } = await getModule();
    const result = await handleRegisterNode(
      { packagePath: 'examples/read-image', test: { config: {} } },
      'execution-id',
      '/workspace/project',
      {
        chatScoped: true,
        authorize,
        signal: controller.signal,
      },
    );

    expect(expectResultText(result, true)).toContain('cancelled');
    expect(state.runCustomNodeScript).not.toHaveBeenCalled();
  });

  it('clears stale staging and orphan authoring dirs at the start of every registration', async () => {
    await register(vi.fn().mockResolvedValue({ allowed: false }));

    expect(state.rm).toHaveBeenCalledWith('/home/testuser/.frink/nodes/.frink-register-staging', {
      recursive: true,
      force: true,
    });
    expect(state.rm).toHaveBeenCalledWith('/home/testuser/.frink/nodes/.authoring', {
      recursive: true,
      force: true,
    });
  });
});
