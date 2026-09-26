import { join } from 'node:path';
import log from 'electron-log';
import type { CustomNodeManifest } from '../../../custom-nodes/discovery';
import {
  beginCustomNodeInstall,
  CUSTOM_NODE_READER_DRAIN_TIMEOUT_MS,
  waitForCustomNodeReaders,
} from '../../../custom-nodes/installation-coordinator';
import { buildTestResult } from '../../../custom-nodes/parse-node-output';
import {
  buildCustomNodeInputConfig,
  normalizeCustomNodeManifestFields,
} from '../../../custom-nodes/runtime';
import { type McpToolResult, toolResult } from '../../tool-result';
import { expectedPackageState, type InstalledPackageState } from './package';
import { registerNodeDependencies } from './register-node-dependencies';
import {
  collectRegisterNodeScriptWarnings,
  type ExistingRegisteredNode,
  GLOBAL_REGISTER_NODE_SESSION_KEY,
  MANAGED_NODE_PACKAGE_JSON,
  MAX_REGISTER_NODE_PER_SESSION,
  normalizeRegisterNodeArgs,
  type RegisterNodeInput,
  type RegisterNodeManifest,
  type RegisterNodeTest,
  registerNodeArgsSchema,
  tryAcquireRegisterNodeSlot,
} from './register-node-support';
import type { RegisterNodeOptions } from './registration';
import { buildRegistrationPresentation } from './registration';
import {
  beginPreparedRegistration,
  defaultNodesRoot,
  prepareStagingRoot,
  registrationAborted,
  installedStatesMatch as statesMatch,
} from './registration/lifecycle';
import {
  type ResolvedRegistrationSource,
  resolveRegistrationSource,
} from './registration/resolve-input';
import { buildRegistrationSuccessResult } from './registration-result';
import {
  isJavaScriptModulePath,
  MAX_PACKAGE_JAVASCRIPT_BYTES,
  MAX_PACKAGE_METADATA_BYTES,
  type PackageModule,
  type PackageSnapshot,
  PackageValidationError,
} from './resource-files';

export { resetRegisterNodeCount } from './register-node-support';

type PreparedRegistration = {
  dir: string;
  existing: ExistingRegisteredNode | null;
  manifest: RegisterNodeManifest;
  /** User-supplied folder path for display; absent for inline registrations. */
  packagePath?: string;
  previousSource?: string;
  previousModules: PackageModule[];
  rawDir: string;
  sessionRoot: string;
  snapshot: PackageSnapshot;
  targetState: InstalledPackageState | null;
  test?: RegisterNodeTest;
};
type TestResult = ReturnType<typeof buildTestResult> | { error: string };
type RegistrationResult<T> = { ok: true; value: T } | { ok: false; error: string };
async function readTargetSnapshot(dir: string): Promise<
  RegistrationResult<{
    existing: ExistingRegisteredNode | null;
    previousSource?: string;
    previousModules: PackageModule[];
    targetState: InstalledPackageState | null;
  }>
> {
  try {
    const first = await registerNodeDependencies.readInstalledPackageState(dir);
    const existing = await registerNodeDependencies.readExistingRegisteredNode(dir);
    if (first !== null && existing === null) {
      return {
        ok: false,
        error: 'Cannot safely replace an installed node without manifest.json',
      };
    }
    const previousSource = existing
      ? (
          await registerNodeDependencies.readBoundedInstalledFile(
            dir,
            existing.entrypoint,
            MAX_PACKAGE_METADATA_BYTES,
          )
        ).toString('utf8')
      : undefined;
    const previousModules: PackageModule[] = [];
    let moduleBytes = 0;
    for (const file of first?.files ?? []) {
      if (file.path === existing?.entrypoint || !isJavaScriptModulePath(file.path)) continue;
      moduleBytes += file.bytes;
      if (file.bytes > MAX_PACKAGE_METADATA_BYTES || moduleBytes > MAX_PACKAGE_JAVASCRIPT_BYTES) {
        return { ok: false, error: 'Installed JavaScript modules exceed preview source limits' };
      }
      previousModules.push({
        path: file.path,
        bytes: file.bytes,
        hash: file.hash,
        source: (
          await registerNodeDependencies.readBoundedInstalledFile(
            dir,
            file.path,
            MAX_PACKAGE_METADATA_BYTES,
          )
        ).toString('utf8'),
      });
    }
    const second = await registerNodeDependencies.readInstalledPackageState(dir);
    if (!statesMatch(first, second)) {
      return {
        ok: false,
        error: 'Installed custom node changed while being prepared; retry',
      };
    }
    return {
      ok: true,
      value: { existing, previousModules, previousSource, targetState: second },
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
async function assemblePreparedRegistration(
  input: RegisterNodeInput,
  source: Extract<ResolvedRegistrationSource, { ok: true }>,
  nodesRoot: string,
  sessionRoot: string,
): Promise<RegistrationResult<PreparedRegistration>> {
  const rawDir = join(sessionRoot, 'raw');
  await registerNodeDependencies.mkdir(rawDir);
  const captured = await registerNodeDependencies.stageRegistrationPackage({
    packagePath: source.packagePath,
    projectRoot: source.projectRoot,
    stagingRoot: rawDir,
  });
  if (!captured.ok) return captured;
  const dir = join(nodesRoot, captured.manifest.name);
  const target = await readTargetSnapshot(dir);
  if (!target.ok) return target;
  const registration: PreparedRegistration = {
    ...target.value,
    dir,
    manifest: captured.manifest,
    packagePath: source.displayPath,
    rawDir,
    sessionRoot,
    snapshot: captured.snapshot,
    test: input.test,
  };
  const installedManifestBytes = Buffer.byteLength(
    JSON.stringify(buildManifestJson(registration), null, 2),
    'utf8',
  );
  if (installedManifestBytes > MAX_PACKAGE_METADATA_BYTES) {
    return { ok: false, error: 'Generated manifest exceeds 100 KiB metadata limit' };
  }
  return { ok: true, value: registration };
}
function buildManifestJson(registration: PreparedRegistration): Record<string, unknown> {
  const { manifest, snapshot } = registration;
  const { hadDisplayName: _hadDisplayName, ...fields } = normalizeCustomNodeManifestFields(
    manifest.name,
    manifest,
  );
  return {
    name: manifest.name,
    ...fields,
    entrypoint: manifest.entrypoint,
    credentials: manifest.credentials ?? {},
    ...(manifest.outputs !== undefined && { outputs: manifest.outputs }),
    frinkPackage: {
      version: 1,
      digest: snapshot.digest,
      resources: snapshot.resourcePaths,
      totalBytes: snapshot.totalBytes,
    },
  };
}

async function buildGeneratedClone(
  registration: PreparedRegistration,
  destination: string,
): Promise<RegistrationResult<InstalledPackageState>> {
  try {
    await registerNodeDependencies.mkdir(destination);
    const snapshot = await registerNodeDependencies.stagePackageDirectory({
      entrypoint: registration.manifest.entrypoint,
      packagePath: 'raw',
      projectRoot: registration.sessionRoot,
      stagingRoot: destination,
    });
    if (snapshot.digest !== registration.snapshot.digest) {
      return {
        ok: false,
        error: 'Captured source package changed; retry registration',
      };
    }
    const manifestContent = JSON.stringify(buildManifestJson(registration), null, 2);
    await registerNodeDependencies.writeFile(
      join(destination, 'manifest.json'),
      manifestContent,
      'utf8',
    );
    await registerNodeDependencies.writeFile(
      join(destination, 'package.json'),
      MANAGED_NODE_PACKAGE_JSON,
      'utf8',
    );
    return {
      ok: true,
      value: expectedPackageState({
        entrypoint: registration.manifest.entrypoint,
        manifestBytes: Buffer.from(manifestContent, 'utf8'),
        packageJsonBytes: Buffer.from(MANAGED_NODE_PACKAGE_JSON, 'utf8'),
        snapshot: registration.snapshot,
      }),
    };
  } catch (error) {
    if (error instanceof PackageValidationError) {
      return {
        ok: false,
        error: `Captured source package changed: ${error.message}`,
      };
    }
    throw error;
  }
}
function buildTestManifest(
  registration: PreparedRegistration,
  nodePath: string,
): CustomNodeManifest {
  return {
    ...buildManifestJson(registration),
    outputs: registration.manifest.outputs,
    nodePath,
  } as CustomNodeManifest;
}
function failedTest(error: string, testResult: TestResult): RegistrationResult<never> {
  return {
    ok: false,
    error: JSON.stringify({ success: false, error, testResult }, null, 2),
  };
}
async function runPreparedTest(
  registration: PreparedRegistration,
  signal?: AbortSignal,
): Promise<RegistrationResult<TestResult | undefined>> {
  if (!registration.test) return { ok: true, value: undefined };
  const testDir = join(registration.sessionRoot, 'test');
  const clone = await buildGeneratedClone(registration, testDir);
  if (!clone.ok) return clone;

  const input = buildCustomNodeInputConfig(
    registration.manifest.inputs ?? {},
    registration.test.config ?? {},
  );
  if (!input.ok) {
    return failedTest(
      `Custom node staged test could not run; the installed node was not changed. Test ${input.error}`,
      { error: input.error },
    );
  }
  const startedAt = Date.now();
  try {
    const result = await registerNodeDependencies.runCustomNodeScript(
      buildTestManifest(registration, testDir),
      [JSON.stringify(input.config)],
      { timeoutMs: registration.test.timeoutMs, signal, skipReadLease: true },
    );
    const testResult = buildTestResult(result, Date.now() - startedAt);
    if (result.exitCode !== 0 || result.timedOut === true || result.cancelled === true) {
      return failedTest(
        'Custom node staged test failed; the installed node was not changed',
        testResult,
      );
    }
    return { ok: true, value: testResult };
  } catch (error) {
    return failedTest('Custom node staged test could not run; the installed node was not changed', {
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    await registerNodeDependencies.rm(testDir, { recursive: true, force: true }).catch(() => {});
  }
}
async function authorizeAndTestRegistration(
  registration: PreparedRegistration,
  options: RegisterNodeOptions,
): Promise<RegistrationResult<TestResult | undefined>> {
  const presentation = buildRegistrationPresentation({
    existingEntrypoint: registration.existing?.entrypoint,
    existingSourceMode: registration.existing?.sourceMode,
    manifest: registration.manifest,
    packagePath: registration.packagePath,
    previousSource: registration.previousSource,
    previousModules: registration.previousModules,
    snapshot: registration.snapshot,
    targetState: registration.targetState,
    test: registration.test,
  });
  const authorization = await options.authorize(presentation, options.signal);
  if (!authorization.allowed) {
    return { ok: false, error: authorization.reason ?? 'Custom node registration denied' };
  }
  const cancelledAfterConsent = registrationAborted(options.signal);
  if (cancelledAfterConsent) return cancelledAfterConsent;
  const test = await runPreparedTest(registration, options.signal);
  if (!test.ok) return test;
  const cancelledAfterTest = registrationAborted(options.signal);
  return cancelledAfterTest ?? test;
}
async function installPreparedRegistration(
  registration: PreparedRegistration,
  nodesRoot: string,
  testResult: TestResult | undefined,
  options: RegisterNodeOptions,
): Promise<McpToolResult> {
  const candidateDir = join(registration.sessionRoot, 'candidate');
  const candidate = await buildGeneratedClone(registration, candidateDir);
  if (!candidate.ok) return toolResult(candidate.error, true);
  const expectedCandidateState = candidate.value;
  const nodeName = registration.manifest.name;
  registerNodeDependencies.discoverCustomNodes();
  let releaseInstall = beginCustomNodeInstall(nodeName) ?? undefined;
  if (!releaseInstall) {
    return toolResult('Another custom node installation is in progress; retry later', true);
  }
  try {
    const readersDrained = await waitForCustomNodeReaders(
      nodeName,
      CUSTOM_NODE_READER_DRAIN_TIMEOUT_MS,
    );
    if (!readersDrained) {
      return toolResult(
        `Custom node "${nodeName}" is currently running; no changes installed; retry after active step finishes.`,
        true,
      );
    }
    const cancelledBeforeInstall = registrationAborted(options.signal);
    if (cancelledBeforeInstall) return toolResult(cancelledBeforeInstall.error, true);
    const sourceDigest = await registerNodeDependencies.rehashPackageDirectory(
      registration.rawDir,
      registration.manifest.entrypoint,
    );
    if (sourceDigest !== registration.snapshot.digest) {
      return toolResult('Captured source package changed; no changes installed; retry.', true);
    }
    const currentCandidate = await registerNodeDependencies.readInstalledPackageState(candidateDir);
    if (!statesMatch(expectedCandidateState, currentCandidate)) {
      return toolResult('Prepared install candidate changed; no changes installed; retry.', true);
    }
    const currentTarget = await registerNodeDependencies.readInstalledPackageState(
      registration.dir,
    );
    if (!statesMatch(registration.targetState, currentTarget)) return staleTargetError(nodeName);
    const cancelledAtSwap = registrationAborted(options.signal);
    if (cancelledAtSwap) return toolResult(cancelledAtSwap.error, true);
    if (options.isExecutionCurrent?.() === false) {
      return toolResult('Registration execution is no longer active; no changes installed.', true);
    }
    const destinationExisted = currentTarget !== null;
    await registerNodeDependencies.replaceDirectory(candidateDir, registration.dir, {
      backupPath: join(
        nodesRoot,
        `.${nodeName}.backup-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      ),
      destinationExists: destinationExisted,
      onCleanupError: (error) => {
        log.warn('[frink_register_node] failed to remove post-swap backup', {
          name: nodeName,
          error: error instanceof Error ? error.message : String(error),
        });
      },
      onRestoreError: (error) => {
        log.error('[frink_register_node] failed to restore backup after install error', {
          name: nodeName,
          error: error instanceof Error ? error.message : String(error),
        });
      },
      verifyBackup: async (backup) => {
        const capturedTarget = await registerNodeDependencies.readInstalledPackageState(backup);
        if (!statesMatch(registration.targetState, capturedTarget)) {
          throw new Error('Installed custom node changed immediately before replacement');
        }
      },
      verifyDestination: async (destination) => {
        const installed = await registerNodeDependencies.readInstalledPackageState(destination);
        if (!statesMatch(expectedCandidateState, installed)) {
          throw new Error('Installed custom node does not match the approved package snapshot');
        }
      },
    });
    registerNodeDependencies.invalidateCustomNodesDiscoveryCache();
    releaseInstall();
    releaseInstall = undefined;
    const discovery = registerNodeDependencies.discoverCustomNodes();
    return buildRegistrationSuccessResult(
      registration,
      {
        packageSnapshot: registration.snapshot,
        scriptWarnings: collectRegisterNodeScriptWarnings(
          registration.snapshot.entrypointBytes.toString('utf8'),
        ),
        testResult,
      },
      discovery,
      destinationExisted,
    );
  } finally {
    releaseInstall?.();
  }
}
function staleTargetError(name: string): McpToolResult {
  return toolResult(
    `Custom node "${name}" changed while approval or testing was in progress; no changes installed; retry.`,
    true,
  );
}
export async function handleRegisterNode(
  args: Record<string, unknown>,
  executionId: string | undefined,
  sessionProjectPath: string | undefined,
  options: RegisterNodeOptions,
): Promise<McpToolResult> {
  const parsed = registerNodeArgsSchema.safeParse(args);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) =>
        issue.path.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message,
      )
      .join('; ');
    return toolResult(`Invalid arguments: ${details}`, true);
  }
  if (!options?.authorize) return toolResult('Registration authorization is required', true);
  if (!options.chatScoped) {
    return toolResult('frink_register_node requires an active Frink chat session', true);
  }
  const sessionKey = executionId ?? GLOBAL_REGISTER_NODE_SESSION_KEY;
  if (!tryAcquireRegisterNodeSlot(sessionKey)) {
    return toolResult(
      `Rate limit: frink_register_node is limited to ${MAX_REGISTER_NODE_PER_SESSION} calls per session. Start a new chat to reset the limit, or run the script manually in terminal to continue debugging.`,
      true,
    );
  }
  const releasePrepared = beginPreparedRegistration();
  if (!releasePrepared) {
    return toolResult('Another custom node registration is awaiting approval; retry later', true);
  }
  const nodesRoot = defaultNodesRoot();
  let sessionRoot: string | undefined;
  let nodeName: string | undefined;
  try {
    const cancelled = registrationAborted(options.signal);
    if (cancelled) return toolResult(cancelled.error, true);
    sessionRoot = await prepareStagingRoot(nodesRoot);
    const input = normalizeRegisterNodeArgs(parsed.data);
    const source = await resolveRegistrationSource(input, sessionRoot, sessionProjectPath);
    if (!source.ok) return toolResult(source.error, true);
    const prepared = await assemblePreparedRegistration(input, source, nodesRoot, sessionRoot);
    if (!prepared.ok) return toolResult(prepared.error, true);
    const registration = prepared.value;
    nodeName = registration.manifest.name;
    const approved = await authorizeAndTestRegistration(registration, options);
    if (!approved.ok) return toolResult(approved.error, true);
    return await installPreparedRegistration(registration, nodesRoot, approved.value, options);
  } catch (error) {
    registerNodeDependencies.invalidateCustomNodesDiscoveryCache();
    registerNodeDependencies.captureMainException(error, {
      surface: 'custom-node-registration',
      nodeName: nodeName ?? 'unknown',
    });
    const message = error instanceof Error ? error.message : String(error);
    return toolResult(`Failed to register custom node: ${message}`, true);
  } finally {
    if (sessionRoot) {
      await registerNodeDependencies
        .rm(sessionRoot, { recursive: true, force: true })
        .catch(() => {});
    }
    releasePrepared();
  }
}
