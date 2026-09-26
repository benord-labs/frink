import type { Stats } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { resolveContainedCustomNodePath } from '../../../../custom-nodes/runtime';
import {
  hashOpenFileContents,
  MAX_PACKAGE_DIRECTORIES,
  MAX_PACKAGE_FILES,
  MAX_PACKAGE_METADATA_BYTES,
  MAX_PACKAGE_TOTAL_BYTES,
  openStableFile,
  PackageValidationError,
  readStableOpenFileAtMost,
} from '../resource-files';
import { digestPackageFiles } from './expected-package-state';
import { type PackageFileHandle, packageFileSystem } from './package-file-system';
import {
  directoryOpenFlags,
  readBoundedDirectoryEntries,
  resolvePathWithinStableRoot,
  sameFileIdentity,
} from './package-paths';

export type InstalledFileState = { path: string; bytes: number; hash: string };
export type InstalledPackageState = {
  digest: string;
  files: InstalledFileState[];
};

const MAX_INSTALLED_PACKAGE_BYTES = MAX_PACKAGE_TOTAL_BYTES + 2 * MAX_PACKAGE_METADATA_BYTES;
const MAX_INSTALLED_PACKAGE_FILES = MAX_PACKAGE_FILES + 1;
const errorCodeSchema = z.object({ code: z.string() });

type OpenFile = PackageFileHandle;
type FileStatus = Stats;
type InstalledBoundary = {
  handle: OpenFile;
  lexicalRoot: string;
  realRoot: string;
  status: FileStatus;
};
type InstalledInventory = {
  directories: number;
  files: InstalledFileState[];
  totalBytes: number;
};

function stateError(message: string): never {
  throw new PackageValidationError(`installed node ${message}`);
}

async function captureInstalledBoundary(root: string): Promise<InstalledBoundary> {
  const lexicalRoot = resolve(root);
  const pathStatus = await lstat(lexicalRoot);
  if (pathStatus.isSymbolicLink() || !pathStatus.isDirectory()) {
    stateError('target is not a directory');
  }
  const handle = await packageFileSystem.open(lexicalRoot, directoryOpenFlags());
  try {
    const status = await handle.stat();
    if (!status.isDirectory() || !sameFileIdentity(pathStatus, status)) {
      stateError('target changed while being inspected');
    }
    const realRoot = await realpath(lexicalRoot);
    const boundary = { handle, lexicalRoot, realRoot, status };
    await assertInstalledBoundary(boundary);
    return boundary;
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

async function assertInstalledBoundary(boundary: InstalledBoundary): Promise<void> {
  const [pathStatus, handleStatus, currentRealRoot] = await Promise.all([
    lstat(boundary.lexicalRoot),
    boundary.handle.stat(),
    realpath(boundary.lexicalRoot),
  ]);
  if (
    currentRealRoot !== boundary.realRoot ||
    !pathStatus.isDirectory() ||
    !handleStatus.isDirectory() ||
    !sameFileIdentity(boundary.status, handleStatus) ||
    !sameFileIdentity(pathStatus, handleStatus)
  ) {
    stateError('target changed while being inspected');
  }
}

async function assertInstalledEntryStable(
  boundary: InstalledBoundary,
  path: string,
): Promise<void> {
  if (!(await resolvePathWithinStableRoot(boundary.lexicalRoot, boundary.realRoot, path))) {
    stateError('entry resolves outside the installed package');
  }
}

async function hashRegularFile(
  boundary: InstalledBoundary,
  path: string,
  relativePath: string,
  pathStatus: FileStatus,
): Promise<InstalledFileState> {
  if (pathStatus.isSymbolicLink() || !pathStatus.isFile()) {
    stateError(`entry "${relativePath}" is not a regular file`);
  }
  const { before, handle } = await openStableFile(
    path,
    pathStatus,
    () => assertInstalledEntryStable(boundary, path),
    () => stateError(`entry "${relativePath}" changed`),
  );
  try {
    const hashed = await hashOpenFileContents(handle, before.size);
    const [after, afterPathStatus] = await Promise.all([handle.stat(), lstat(path)]);
    if (
      hashed.bytesRead !== before.size ||
      !sameFileIdentity(before, after) ||
      !sameFileIdentity(afterPathStatus, after)
    ) {
      stateError(`entry "${relativePath}" changed`);
    }
    await assertInstalledEntryStable(boundary, path);
    return { path: relativePath, bytes: before.size, hash: hashed.hash };
  } finally {
    await handle.close().catch(() => {});
  }
}

async function collectInstalledEntry(
  boundary: InstalledBoundary,
  inventory: InstalledInventory,
  directory: string,
  relativeRoot: string,
  name: string,
): Promise<void> {
  const relativePath = relativeRoot ? `${relativeRoot}/${name}` : name;
  const path = join(directory, name);
  const status = await lstat(path);
  if (status.isSymbolicLink()) stateError(`entry "${relativePath}" is a symbolic link`);
  await assertInstalledEntryStable(boundary, path);
  if (status.isDirectory()) {
    inventory.directories += 1;
    if (inventory.directories > MAX_PACKAGE_DIRECTORIES) {
      stateError(`exceeds ${MAX_PACKAGE_DIRECTORIES} directory limit`);
    }
    await walkInstalledDirectory(boundary, inventory, path, relativePath);
    return;
  }
  if (!status.isFile()) stateError(`entry "${relativePath}" is not a regular file`);
  if (inventory.files.length >= MAX_INSTALLED_PACKAGE_FILES) {
    stateError(`exceeds ${MAX_INSTALLED_PACKAGE_FILES} file limit`);
  }
  inventory.totalBytes += status.size;
  if (inventory.totalBytes > MAX_INSTALLED_PACKAGE_BYTES) {
    stateError('exceeds installed size limit');
  }
  inventory.files.push(await hashRegularFile(boundary, path, relativePath, status));
}

async function assertInstalledDirectoryIdentity(
  handle: OpenFile,
  directory: string,
  expected: FileStatus,
  label: string,
  phase: string,
): Promise<void> {
  const [pathStatus, handleStatus] = await Promise.all([lstat(directory), handle.stat()]);
  if (!sameFileIdentity(expected, handleStatus) || !sameFileIdentity(pathStatus, handleStatus)) {
    stateError(`directory "${label}" changed ${phase}`);
  }
}

async function walkInstalledDirectory(
  boundary: InstalledBoundary,
  inventory: InstalledInventory,
  directory: string,
  relativeRoot: string,
): Promise<void> {
  await assertInstalledEntryStable(boundary, directory);
  const pathStatus = await lstat(directory);
  if (pathStatus.isSymbolicLink() || !pathStatus.isDirectory()) {
    stateError(`entry "${relativeRoot || '.'}" is not a directory`);
  }
  const handle = await packageFileSystem.open(directory, directoryOpenFlags());
  try {
    const before = await handle.stat();
    if (!before.isDirectory() || !sameFileIdentity(pathStatus, before)) {
      stateError(`directory "${relativeRoot || '.'}" changed`);
    }
    await assertInstalledEntryStable(boundary, directory);
    const entries = await readBoundedDirectoryEntries(
      directory,
      MAX_INSTALLED_PACKAGE_FILES + MAX_PACKAGE_DIRECTORIES,
      `installed node exceeds ${MAX_INSTALLED_PACKAGE_FILES} file or ${MAX_PACKAGE_DIRECTORIES} directory limit`,
    );
    await assertInstalledDirectoryIdentity(
      handle,
      directory,
      before,
      relativeRoot || '.',
      'during enumeration',
    );
    for (const entry of entries) {
      await collectInstalledEntry(boundary, inventory, directory, relativeRoot, entry.name);
    }
    await assertInstalledDirectoryIdentity(
      handle,
      directory,
      before,
      relativeRoot || '.',
      'during traversal',
    );
    await assertInstalledEntryStable(boundary, directory);
  } finally {
    await handle.close().catch(() => {});
  }
}

async function collectInstalledFiles(boundary: InstalledBoundary): Promise<InstalledFileState[]> {
  const inventory: InstalledInventory = { directories: 0, files: [], totalBytes: 0 };

  await walkInstalledDirectory(boundary, inventory, boundary.lexicalRoot, '');
  return inventory.files;
}

export async function readInstalledPackageState(
  root: string,
): Promise<InstalledPackageState | null> {
  try {
    await lstat(root);
  } catch (error) {
    const parsed = errorCodeSchema.safeParse(error);
    if (parsed.success && parsed.data.code === 'ENOENT') return null;
    throw error;
  }
  const boundary = await captureInstalledBoundary(root);
  try {
    const files = await collectInstalledFiles(boundary);
    await assertInstalledBoundary(boundary);
    return { digest: digestPackageFiles(files), files };
  } finally {
    await boundary.handle.close().catch(() => {});
  }
}

export async function readBoundedInstalledFile(
  root: string,
  relativePath: string,
  maxBytes: number,
): Promise<Buffer> {
  const boundary = await captureInstalledBoundary(root);
  try {
    const path = resolveContainedCustomNodePath(boundary.lexicalRoot, relativePath);
    const pathStatus = await lstat(path);
    if (pathStatus.isSymbolicLink() || !pathStatus.isFile()) {
      stateError(`entry "${relativePath}" is not a regular file`);
    }
    if (pathStatus.size > maxBytes) stateError(`entry "${relativePath}" exceeds size limit`);
    const { before, handle } = await openStableFile(
      path,
      pathStatus,
      () => assertInstalledEntryStable(boundary, path),
      () => stateError(`entry "${relativePath}" changed`),
    );
    try {
      const { bytes, stable } = await readStableOpenFileAtMost(handle, path, before, before.size);
      if (!stable) {
        stateError(`entry "${relativePath}" changed`);
      }
      await assertInstalledEntryStable(boundary, path);
      return bytes;
    } finally {
      await handle.close().catch(() => {});
    }
  } finally {
    await boundary.handle.close().catch(() => {});
  }
}
