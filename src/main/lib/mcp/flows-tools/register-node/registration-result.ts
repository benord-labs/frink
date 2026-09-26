import { basename, isAbsolute } from 'node:path';
import type { discoverCustomNodes } from '../../../custom-nodes/discovery';
import { type McpToolResult, toolResult } from '../../tool-result';
import type { PackageSnapshot } from './resource-files';

type RegistrationDiscoveryResult = ReturnType<typeof discoverCustomNodes>;

type RegistrationDiscoveryReceipt = {
  synced: boolean;
  syncErrors: string[];
};

type SuccessRegistration = {
  dir: string;
  manifest: { name: string };
  packagePath?: string;
};

type SuccessfulStaging = {
  packageSnapshot: PackageSnapshot;
  scriptWarnings: string[];
  testResult?: unknown;
};

function classifyRegistrationDiscovery(
  manifestName: string,
  discovery: RegistrationDiscoveryResult,
): RegistrationDiscoveryReceipt {
  const synced = discovery.valid.some(
    (candidate) => candidate.name === manifestName && basename(candidate.nodePath) === manifestName,
  );
  const syncErrors: string[] = [];

  for (const error of discovery.errors) {
    const formatted = `[${error.dir}] ${error.error}`;
    const blocksRequestedNode = error.dir === manifestName || isAbsolute(error.dir);
    if (!synced && blocksRequestedNode) syncErrors.push(formatted);
  }

  if (!synced && syncErrors.length === 0) {
    syncErrors.push(
      `[${manifestName}] Installed node was not found by discovery after registration.`,
    );
  }
  return { synced, syncErrors };
}

function registrationDiscoveryMessage(receipt: RegistrationDiscoveryReceipt): string {
  if (!receipt.synced)
    return 'Installed locally, but the registered node was not found by discovery.';
  return 'Available locally.';
}

export function buildRegistrationSuccessResult(
  registration: SuccessRegistration,
  staged: SuccessfulStaging,
  discovery: RegistrationDiscoveryResult,
  destinationExisted: boolean,
): McpToolResult {
  const { dir, manifest } = registration;
  const receipt = classifyRegistrationDiscovery(manifest.name, discovery);
  const action = destinationExisted ? 'updated' : 'registered';
  return toolResult(
    JSON.stringify(
      {
        success: true,
        name: manifest.name,
        nodePath: dir,
        [action]: true,
        synced: receipt.synced,
        syncErrors: receipt.syncErrors.length > 0 ? receipt.syncErrors : undefined,
        ...(staged.scriptWarnings.length > 0 && {
          warnings: staged.scriptWarnings,
        }),
        ...(staged.testResult !== undefined && {
          testResult: staged.testResult,
        }),
        source: registration.packagePath === undefined ? 'inline' : 'package',
        ...(registration.packagePath !== undefined && { packagePath: registration.packagePath }),
        packageDigest: staged.packageSnapshot.digest,
        packageResources: staged.packageSnapshot.resourcePaths.length,
        packageBytes: staged.packageSnapshot.totalBytes,
        message: `Custom node "${manifest.name}" ${action}. ${registrationDiscoveryMessage(receipt)}`,
      },
      null,
      2,
    ),
  );
}
