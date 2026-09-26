import { createHash } from 'node:crypto';
import type { PackageSnapshot } from '../resource-files';
import type { InstalledFileState, InstalledPackageState } from './installed-package-state';

type ExpectedPackageStateInput = {
  entrypoint: string;
  manifestBytes: Buffer;
  packageJsonBytes: Buffer;
  snapshot: PackageSnapshot;
};

export function hashBytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function digestPackageFiles(files: readonly InstalledFileState[]): string {
  const digest = createHash('sha256');
  for (const file of files) digest.update(`${file.path}\0${file.bytes}\0${file.hash}\n`);
  return digest.digest('hex');
}

function fileState(path: string, bytes: Buffer): InstalledFileState {
  return { path, bytes: bytes.byteLength, hash: hashBytes(bytes) };
}

function compareTraversalOrder(first: InstalledFileState, second: InstalledFileState): number {
  const firstParts = first.path.split('/');
  const secondParts = second.path.split('/');
  for (let index = 0; index < Math.min(firstParts.length, secondParts.length); index += 1) {
    const order = firstParts[index].localeCompare(secondParts[index]);
    if (order !== 0) return order;
  }
  return firstParts.length - secondParts.length;
}

/** Derive the installed-package attestation exclusively from the approved source snapshot. */
export function expectedPackageState(input: ExpectedPackageStateInput): InstalledPackageState {
  const files = [
    fileState(input.entrypoint, input.snapshot.entrypointBytes),
    fileState('manifest.json', input.manifestBytes),
    fileState('package.json', input.packageJsonBytes),
    ...input.snapshot.modules.map(({ path, bytes, hash }) => ({ path, bytes, hash })),
    ...input.snapshot.resources,
  ].sort(compareTraversalOrder);
  return { digest: digestPackageFiles(files), files };
}
