import type { Stats } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { JsonValue } from '../../../../../../shared/types/permissions';
import {
  MAX_PACKAGE_METADATA_BYTES,
  openStableFile,
  readStableOpenFileAtMost,
} from '../resource-files';
import {
  assertPackagePathBoundaryUnchanged,
  assertPackagePathContained,
  capturePackagePathBoundary,
  closePackagePathBoundary,
  PackageValidationError,
  resolvePackageRoot,
} from './package-paths';

type PackageManifestInput = { packagePath: string; projectRoot: string };
type PackageManifest = { bytes: Buffer; packageRoot: string; value: JsonValue };
type PackageBoundary = Awaited<ReturnType<typeof capturePackagePathBoundary>>;
const errorCodeSchema = z.object({ code: z.string() });
const UNSTABLE_OPEN_CODES = new Set(['ELOOP', 'ENOENT', 'ENOTDIR']);

function manifestError(message: string): never {
  throw new PackageValidationError(`package manifest.json ${message}`);
}

async function openStablePackageManifest(
  boundary: PackageBoundary,
  path: string,
  pathStatus: Stats,
) {
  return openStableFile(
    path,
    pathStatus,
    () => assertPackagePathContained(boundary, path),
    () => manifestError('changed before it could be read'),
    (error) => {
      const parsed = errorCodeSchema.safeParse(error);
      if (parsed.success && UNSTABLE_OPEN_CODES.has(parsed.data.code)) {
        manifestError('changed before it could be read');
      }
    },
  );
}

function parseManifestJson(bytes: Buffer): JsonValue {
  try {
    return z.json().parse(JSON.parse(bytes.toString('utf8')));
  } catch {
    manifestError('is not valid JSON');
  }
}

export async function readPackageManifest(input: PackageManifestInput): Promise<PackageManifest> {
  const packageRoot = await resolvePackageRoot(input.projectRoot, input.packagePath);
  const boundary = await capturePackagePathBoundary(input.projectRoot, packageRoot);
  const path = join(packageRoot, 'manifest.json');
  try {
    let pathStatus: Stats;
    try {
      pathStatus = await lstat(path);
    } catch (error) {
      const parsed = errorCodeSchema.safeParse(error);
      if (parsed.success && parsed.data.code === 'ENOENT') manifestError('is missing');
      throw error;
    }
    if (pathStatus.isSymbolicLink() || !pathStatus.isFile()) {
      manifestError('must be a regular file, not a symbolic link');
    }
    if (pathStatus.size > MAX_PACKAGE_METADATA_BYTES) manifestError('exceeds 100 KiB limit');
    await assertPackagePathContained(boundary, path);

    const { before, handle } = await openStablePackageManifest(boundary, path, pathStatus);
    try {
      const { bytes, stable } = await readStableOpenFileAtMost(
        handle,
        path,
        before,
        MAX_PACKAGE_METADATA_BYTES,
      );
      if (bytes.byteLength > MAX_PACKAGE_METADATA_BYTES) manifestError('exceeds 100 KiB limit');
      if (!stable) {
        manifestError('changed while being read');
      }
      await assertPackagePathContained(boundary, path);
      const value = parseManifestJson(bytes);
      await assertPackagePathBoundaryUnchanged(boundary);
      return { bytes, packageRoot, value };
    } finally {
      await handle.close().catch(() => {});
    }
  } finally {
    await closePackagePathBoundary(boundary);
  }
}
