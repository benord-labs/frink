import { createHash } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { digestPackageFiles } from './package/expected-package-state';
import { consumeOpenFileAtMost, hashOpenFileContents } from './package/package-file-read';
import { type PackageFileHandle, packageFileSystem } from './package/package-file-system';
import {
  assertPackagePathBoundaryUnchanged,
  assertPackagePathContained,
  capturePackagePathBoundary,
  closePackagePathBoundary,
  directoryOpenFlags,
  type PackagePathBoundary,
  readBoundedDirectoryEntries,
  resolvePackageRoot,
  sameFileIdentity,
  validatePackageEntryPath,
  validatePortablePackageCollisions,
  validationError,
} from './package/package-paths';

export {
  consumeOpenFileAtMost,
  hashOpenFileContents,
  openStableFile,
  readOpenFileAtMost,
  readStableOpenFileAtMost,
} from './package/package-file-read';

export { PackageValidationError, packagePathError } from './package/package-paths';
export const MAX_PACKAGE_FILES = 256;
export const MAX_PACKAGE_DIRECTORIES = 64;
export const MAX_PACKAGE_TOTAL_BYTES = 256 * 1024 * 1024;
export const MAX_PACKAGE_METADATA_BYTES = 100 * 1024;
export const MAX_PACKAGE_JAVASCRIPT_BYTES = 1024 * 1024;
const NO_FOLLOW_OPEN_FLAG = constants.O_NOFOLLOW ?? 0;
type OpenFile = PackageFileHandle;
type FileStatus = Stats;
type PackageFile = { path: string; sourcePath: string; size: number; status: FileStatus };
type PackageDirectory = { path: string; status: FileStatus };
type PackageInventory = {
  directories: PackageDirectory[];
  files: PackageFile[];
  javaScriptBytes: number;
  totalBytes: number;
};
type PackageInventoryBuilder = PackageInventory;
type CopiedFile = PackageFile & { hash: string; captured?: Buffer };
export type PackageSnapshot = {
  digest: string;
  entrypointBytes: Buffer;
  manifestBytes: Buffer;
  modules: PackageModule[];
  resources: PackageResource[];
  resourcePaths: string[];
  sourceManifest: unknown;
  totalBytes: number;
};
export type PackageResource = { path: string; bytes: number; hash: string };
export type PackageModule = PackageResource & { source: string };
export type StagePackageDirectoryInput = {
  entrypoint: string;
  packagePath: string;
  projectRoot: string;
  stagingRoot: string;
};

export function isJavaScriptModulePath(path: string): boolean {
  const normalized = path.toLowerCase();
  return normalized.endsWith('.js') || normalized.endsWith('.mjs');
}
function addInventoryDirectory(
  builder: PackageInventoryBuilder,
  path: string,
  status: FileStatus,
): void {
  builder.directories.push({ path, status });
  if (builder.directories.length > MAX_PACKAGE_DIRECTORIES) {
    validationError(`package exceeds ${MAX_PACKAGE_DIRECTORIES} directory limit`);
  }
}
function addInventoryFile(
  builder: PackageInventoryBuilder,
  file: PackageFile,
  mode: number,
  entrypoint: string,
): void {
  if (file.path !== 'manifest.json' && file.path !== entrypoint && (mode & 0o111) !== 0) {
    validationError(`package resource "${file.path}" must not have executable permission bits`);
  }
  builder.files.push(file);
  if (builder.files.length > MAX_PACKAGE_FILES) {
    validationError(`package exceeds ${MAX_PACKAGE_FILES} file limit`);
  }
  builder.totalBytes += file.size;
  if (builder.totalBytes > MAX_PACKAGE_TOTAL_BYTES) {
    validationError('package exceeds 256 MiB total size limit');
  }
  if (isJavaScriptModulePath(file.path)) {
    if (file.size > MAX_PACKAGE_METADATA_BYTES) {
      validationError(`JavaScript module "${file.path}" exceeds 100 KiB source limit`);
    }
    builder.javaScriptBytes += file.size;
    if (builder.javaScriptBytes > MAX_PACKAGE_JAVASCRIPT_BYTES) {
      validationError('package exceeds 1 MiB aggregate JavaScript source limit');
    }
  }
}
async function collectInventoryEntry(
  builder: PackageInventoryBuilder,
  boundary: PackagePathBoundary,
  currentRoot: string,
  relativeRoot: string,
  entrypoint: string,
  name: string,
): Promise<void> {
  const path = relativeRoot ? `${relativeRoot}/${name}` : name;
  const sourcePath = join(currentRoot, name);
  const status = await lstat(sourcePath);
  if (status.isSymbolicLink()) validationError(`package entry "${path}" is a symbolic link`);
  await assertPackagePathContained(boundary, sourcePath);
  if (status.isDirectory()) {
    validatePackageEntryPath(path, 'directory', entrypoint);
    addInventoryDirectory(builder, path, status);
    await walkInventory(builder, boundary, sourcePath, path, entrypoint);
    return;
  }
  if (!status.isFile()) validationError(`package entry "${path}" is not a regular file`);
  validatePackageEntryPath(path, 'file', entrypoint);
  addInventoryFile(
    builder,
    { path, sourcePath, size: status.size, status },
    status.mode,
    entrypoint,
  );
}
async function walkInventory(
  builder: PackageInventoryBuilder,
  boundary: PackagePathBoundary,
  currentRoot: string,
  relativeRoot: string,
  entrypoint: string,
): Promise<void> {
  await assertPackagePathContained(boundary, currentRoot);
  const pathStatus = await lstat(currentRoot);
  const handle = await packageFileSystem.open(currentRoot, directoryOpenFlags());
  try {
    const before = await handle.stat();
    if (
      !pathStatus.isDirectory() ||
      !before.isDirectory() ||
      !sameFileIdentity(pathStatus, before)
    ) {
      validationError(`package directory "${relativeRoot || '.'}" changed before enumeration`);
    }
    const entries = await readBoundedDirectoryEntries(
      currentRoot,
      MAX_PACKAGE_FILES + MAX_PACKAGE_DIRECTORIES,
      `package exceeds ${MAX_PACKAGE_FILES} file or ${MAX_PACKAGE_DIRECTORIES} directory limit`,
    );
    const enumeratedPathStatus = await lstat(currentRoot);
    const enumeratedHandleStatus = await handle.stat();
    if (
      !sameFileIdentity(before, enumeratedHandleStatus) ||
      !sameFileIdentity(enumeratedPathStatus, enumeratedHandleStatus)
    ) {
      validationError(`package directory "${relativeRoot || '.'}" changed during enumeration`);
    }
    await assertPackagePathContained(boundary, currentRoot);
    for (const entry of entries) {
      await collectInventoryEntry(
        builder,
        boundary,
        currentRoot,
        relativeRoot,
        entrypoint,
        entry.name,
      );
    }
    const afterPathStatus = await lstat(currentRoot);
    const afterHandleStatus = await handle.stat();
    if (
      !sameFileIdentity(before, afterHandleStatus) ||
      !sameFileIdentity(afterPathStatus, afterHandleStatus)
    ) {
      validationError(`package directory "${relativeRoot || '.'}" changed during traversal`);
    }
    await assertPackagePathContained(boundary, currentRoot);
  } finally {
    await handle.close().catch(() => {});
  }
}
async function collectInventory(
  root: string,
  entrypoint: string,
  boundary: PackagePathBoundary,
): Promise<PackageInventory> {
  const inventory: PackageInventoryBuilder = {
    directories: [],
    files: [],
    javaScriptBytes: 0,
    totalBytes: 0,
  };
  await walkInventory(inventory, boundary, root, '', entrypoint);
  validatePortablePackageCollisions(
    inventory.directories.map((directory) => directory.path),
    inventory.files.map((file) => file.path),
  );
  if (!inventory.files.some((file) => file.path === 'manifest.json')) {
    validationError('package must contain manifest.json at its root');
  }
  if (!inventory.files.some((file) => file.path === entrypoint)) {
    validationError(`package must contain the declared entrypoint "${entrypoint}" at its root`);
  }
  const entrypointFile = inventory.files.find((file) => file.path === entrypoint);
  const manifestFile = inventory.files.find((file) => file.path === 'manifest.json');
  if ((entrypointFile?.size ?? 0) > MAX_PACKAGE_METADATA_BYTES) {
    validationError('package entrypoint exceeds 100 KiB source limit');
  }
  if ((manifestFile?.size ?? 0) > MAX_PACKAGE_METADATA_BYTES) {
    validationError('package manifest.json exceeds 100 KiB limit');
  }
  return inventory;
}
async function hashOpenFile(source: OpenFile, file: PackageFile, phase: string): Promise<string> {
  const before = await source.stat();
  if (!before.isFile() || before.size !== file.size) {
    validationError(`package entry "${file.path}" changed ${phase}`);
  }
  const hashed = await hashOpenFileContents(source, file.size);
  const after = await source.stat();
  if (hashed.bytesRead !== file.size || !sameFileIdentity(before, after)) {
    validationError(`package entry "${file.path}" changed ${phase}`);
  }
  return hashed.hash;
}
async function writeOpenFileChunk(
  destination: OpenFile,
  chunk: Buffer,
  position: number,
): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await destination.write(
      chunk,
      offset,
      chunk.byteLength - offset,
      position + offset,
    );
    offset += bytesWritten;
  }
}
async function assertSourceFileUnchanged(
  boundary: PackagePathBoundary,
  file: PackageFile,
  handle: OpenFile,
  expected: FileStatus,
  phase: string,
): Promise<void> {
  const [pathStatus, handleStatus] = await Promise.all([lstat(file.sourcePath), handle.stat()]);
  if (
    !pathStatus.isFile() ||
    !handleStatus.isFile() ||
    !sameFileIdentity(expected, handleStatus) ||
    !sameFileIdentity(pathStatus, handleStatus)
  ) {
    validationError(`package entry "${file.path}" changed ${phase}`);
  }
  await assertPackagePathContained(boundary, file.sourcePath);
}
async function copyAndHashFile(
  boundary: PackagePathBoundary,
  file: PackageFile,
  destination: string,
): Promise<CopiedFile> {
  const beforePathStatus = await lstat(file.sourcePath);
  if (beforePathStatus.isSymbolicLink() || !beforePathStatus.isFile()) {
    validationError(`package entry "${file.path}" changed type while being copied`);
  }
  if (!sameFileIdentity(file.status, beforePathStatus)) {
    validationError(`package entry "${file.path}" changed before it was copied`);
  }
  await assertPackagePathContained(boundary, file.sourcePath);
  await mkdir(dirname(destination), { recursive: true });
  const source = await packageFileSystem.open(
    file.sourcePath,
    constants.O_RDONLY | NO_FOLLOW_OPEN_FLAG,
  );
  const capture = file.path === 'manifest.json' || isJavaScriptModulePath(file.path);
  try {
    const before = await source.stat();
    if (
      !before.isFile() ||
      !sameFileIdentity(beforePathStatus, before) ||
      before.size !== file.size
    ) {
      validationError(`package entry "${file.path}" changed before it was copied`);
    }
    await assertSourceFileUnchanged(boundary, file, source, before, 'before it was copied');
    const destinationHandle = await packageFileSystem.open(
      destination,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW_OPEN_FLAG,
      0o600,
    );
    const sourceHash = createHash('sha256');
    const captured: Buffer[] = [];
    let copiedBytes: number;
    try {
      copiedBytes = await consumeOpenFileAtMost(source, file.size, async (chunk, offset) => {
        if (offset + chunk.byteLength > file.size) return;
        sourceHash.update(chunk);
        if (capture) captured.push(Buffer.from(chunk));
        await writeOpenFileChunk(destinationHandle, chunk, offset);
      });
    } finally {
      await destinationHandle.close().catch(() => {});
    }
    const after = await source.stat();
    if (copiedBytes !== file.size || !sameFileIdentity(before, after)) {
      validationError(`package entry "${file.path}" changed while being copied`);
    }
    await assertSourceFileUnchanged(boundary, file, source, before, 'while being copied');
    const staged = await packageFileSystem.open(
      destination,
      constants.O_RDONLY | NO_FOLLOW_OPEN_FLAG,
    );
    let stagedHash: string;
    try {
      stagedHash = await hashOpenFile(staged, { ...file, sourcePath: destination }, 'while staged');
    } finally {
      await staged.close().catch(() => {});
    }
    const digest = sourceHash.digest('hex');
    if (digest !== stagedHash) {
      validationError(`package entry "${file.path}" changed while being copied`);
    }
    return {
      ...file,
      hash: digest,
      ...(capture && { captured: Buffer.concat(captured, file.size) }),
    };
  } finally {
    await source.close().catch(() => {});
  }
}
async function hashSourceFile(boundary: PackagePathBoundary, file: PackageFile): Promise<string> {
  const pathStatus = await lstat(file.sourcePath);
  if (
    pathStatus.isSymbolicLink() ||
    !pathStatus.isFile() ||
    !sameFileIdentity(file.status, pathStatus)
  ) {
    validationError(`package entry "${file.path}" changed after it was copied`);
  }
  await assertPackagePathContained(boundary, file.sourcePath);
  const source = await packageFileSystem.open(
    file.sourcePath,
    constants.O_RDONLY | NO_FOLLOW_OPEN_FLAG,
  );
  try {
    await assertSourceFileUnchanged(boundary, file, source, file.status, 'after it was copied');
    const hash = await hashOpenFile(source, file, 'after it was copied');
    await assertSourceFileUnchanged(boundary, file, source, file.status, 'after it was copied');
    return hash;
  } finally {
    await source.close().catch(() => {});
  }
}
function inventoriesMatch(first: PackageInventory, second: PackageInventory): boolean {
  const identity = (status: FileStatus) => ({
    ctimeMs: status.ctimeMs,
    dev: status.dev,
    ino: status.ino,
    mtimeMs: status.mtimeMs,
    size: status.size,
  });
  const comparable = (inventory: PackageInventory) => ({
    directories: inventory.directories.map(({ path, status }) => ({ path, ...identity(status) })),
    files: inventory.files.map(({ path, status }) => ({ path, ...identity(status) })),
  });
  return JSON.stringify(comparable(first)) === JSON.stringify(comparable(second));
}
export async function stagePackageDirectory(
  input: StagePackageDirectoryInput,
): Promise<PackageSnapshot> {
  const packageRoot = await resolvePackageRoot(input.projectRoot, input.packagePath);
  const boundary = await capturePackagePathBoundary(input.projectRoot, packageRoot);
  try {
    const initial = await collectInventory(packageRoot, input.entrypoint, boundary);
    const copied: CopiedFile[] = [];
    for (const file of initial.files) {
      copied.push(await copyAndHashFile(boundary, file, join(input.stagingRoot, file.path)));
    }
    const final = await collectInventory(packageRoot, input.entrypoint, boundary);
    if (!inventoriesMatch(initial, final)) {
      validationError('package changed while being snapshotted');
    }
    for (const file of copied) {
      if ((await hashSourceFile(boundary, file)) !== file.hash) {
        validationError(`package entry "${file.path}" changed while being snapshotted`);
      }
    }
    const manifestBytes = copied.find((file) => file.path === 'manifest.json')?.captured;
    const entrypointBytes = copied.find((file) => file.path === input.entrypoint)?.captured;
    if (!manifestBytes || !entrypointBytes) validationError('package snapshot is incomplete');
    let sourceManifest: unknown;
    try {
      sourceManifest = JSON.parse(manifestBytes.toString('utf8'));
    } catch {
      validationError('package manifest.json is not valid JSON');
    }
    const capturedFiles = copied.map(({ path, size: bytes, hash }) => ({ path, bytes, hash }));
    const additionalFiles = capturedFiles.filter(
      (file) => file.path !== 'manifest.json' && file.path !== input.entrypoint,
    );
    const modules = copied
      .filter((file) => file.path !== input.entrypoint && isJavaScriptModulePath(file.path))
      .map((file) => ({
        path: file.path,
        bytes: file.size,
        hash: file.hash,
        source: file.captured?.toString('utf8') ?? '',
      }));
    const modulePaths = new Set(modules.map((module) => module.path));
    const resources = additionalFiles.filter((file) => !modulePaths.has(file.path));
    await assertPackagePathBoundaryUnchanged(boundary);
    return {
      digest: digestPackageFiles(capturedFiles),
      entrypointBytes,
      manifestBytes,
      modules,
      resources,
      resourcePaths: additionalFiles.map((resource) => resource.path),
      sourceManifest,
      totalBytes: initial.totalBytes,
    };
  } finally {
    await closePackagePathBoundary(boundary);
  }
}

export async function rehashPackageDirectory(root: string, entrypoint: string): Promise<string> {
  const boundary = await capturePackagePathBoundary(dirname(root), root);
  try {
    const initial = await collectInventory(root, entrypoint, boundary);
    const files: CopiedFile[] = [];
    for (const file of initial.files) {
      files.push({ ...file, hash: await hashSourceFile(boundary, file) });
    }
    const final = await collectInventory(root, entrypoint, boundary);
    if (!inventoriesMatch(initial, final)) validationError('package snapshot changed');
    await assertPackagePathBoundaryUnchanged(boundary);
    return digestPackageFiles(files.map(({ path, size: bytes, hash }) => ({ path, bytes, hash })));
  } finally {
    await closePackagePathBoundary(boundary);
  }
}
