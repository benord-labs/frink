import type { CustomNodeRegistrationPresentation } from '../../../../../../shared/types/permissions';
import type { InstalledPackageState } from '../package';
import type { RegisterNodeManifest, RegisterNodeTest } from '../register-node-support';
import {
  isJavaScriptModulePath,
  type PackageModule,
  type PackageResource,
  type PackageSnapshot,
} from '../resource-files';

const EXECUTION_WARNING =
  'Custom nodes execute unsandboxed with Frink process access and may run unattended in future Flow executions.';

type PreviewInput = {
  existingEntrypoint?: string;
  existingSourceMode?: 'legacy' | 'package';
  manifest: RegisterNodeManifest;
  packagePath?: string;
  previousModules: PackageModule[];
  previousSource?: string;
  snapshot: PackageSnapshot;
  targetState: InstalledPackageState | null;
  test?: RegisterNodeTest;
};

function previousResources(input: PreviewInput): Map<string, PackageResource> {
  const ignored = new Set(['manifest.json', 'package.json', input.existingEntrypoint]);
  return new Map(
    (input.targetState?.files ?? [])
      .filter((file) => !ignored.has(file.path) && !isJavaScriptModulePath(file.path))
      .map((file) => [file.path, { path: file.path, bytes: file.bytes, hash: file.hash }]),
  );
}

function moduleChanges(input: PreviewInput): CustomNodeRegistrationPresentation['modules'] {
  const previous = new Map(input.previousModules.map((module) => [module.path, module]));
  const current = input.snapshot.modules.map((module) => {
    const old = previous.get(module.path);
    previous.delete(module.path);
    return {
      path: module.path,
      current: module.source,
      previous: old?.source,
      change: old === undefined ? 'added' : old.hash === module.hash ? 'unchanged' : 'changed',
    } as const;
  });
  return [
    ...current,
    ...[...previous.values()].map((module) => ({
      path: module.path,
      current: '',
      previous: module.source,
      change: 'removed' as const,
    })),
  ];
}

function resourceChanges(input: PreviewInput): CustomNodeRegistrationPresentation['resources'] {
  const previous = previousResources(input);
  const current = input.snapshot.resources.map((resource) => {
    const old = previous.get(resource.path);
    previous.delete(resource.path);
    return {
      path: resource.path,
      bytes: resource.bytes,
      change: old === undefined ? 'added' : old.hash === resource.hash ? 'unchanged' : 'changed',
    } as const;
  });
  return [
    ...current,
    ...[...previous.values()].map((resource) => ({
      path: resource.path,
      bytes: resource.bytes,
      change: 'removed' as const,
    })),
  ];
}

export function buildRegistrationPresentation(
  input: PreviewInput,
): CustomNodeRegistrationPresentation {
  const { manifest, snapshot, test } = input;
  const replacesPackage =
    input.packagePath === undefined &&
    input.existingSourceMode === 'package' &&
    input.targetState !== null;
  return {
    type: 'custom-node-registration',
    ...(input.packagePath !== undefined && { packagePath: input.packagePath }),
    action: input.targetState === null ? 'create' : 'replace',
    ...(replacesPackage && { replacesPackage: true }),
    node: {
      name: manifest.name,
      displayName: manifest.displayName,
      description: manifest.description,
      version: manifest.version,
      entrypoint: manifest.entrypoint,
    },
    source: {
      current: snapshot.entrypointBytes.toString('utf8'),
      previous: input.previousSource,
    },
    modules: moduleChanges(input),
    resources: resourceChanges(input),
    credentialNames: Object.keys(manifest.credentials ?? {}),
    test:
      test === undefined
        ? undefined
        : { config: test.config ?? {}, timeoutMs: test.timeoutMs ?? 10_000 },
    packageDigest: snapshot.digest,
    packageBytes: snapshot.totalBytes,
    warning: EXECUTION_WARNING,
  };
}
