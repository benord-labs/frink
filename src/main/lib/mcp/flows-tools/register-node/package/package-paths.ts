import { constants, type Dirent } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import { extname, isAbsolute, join, posix, relative, resolve, sep, win32 } from 'node:path';
import { z } from 'zod';

const MAX_PACKAGE_PATH_CHARS = 240;
const MAX_PACKAGE_PATH_SEGMENTS = 8;
const MAX_PACKAGE_SEGMENT_CHARS = 120;
const WINDOWS_DEVICE_RE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const WINDOWS_TRAILING_RE = /[. ]$/;
const WINDOWS_FORBIDDEN_CHARS = new Set('<>:"|?*');
const errorCodeSchema = z.object({ code: z.string() });

const FORBIDDEN_PACKAGE_DIRECTORIES = new Set(['.git', 'node_modules']);

const MODULE_OR_EXECUTABLE_EXTENSIONS = new Set([
  '.bat',
  '.bash',
  '.cjs',
  '.class',
  '.cmd',
  '.com',
  '.dll',
  '.dylib',
  '.exe',
  '.fish',
  '.jar',
  '.jsx',
  '.node',
  '.php',
  '.pl',
  '.ps1',
  '.py',
  '.pyw',
  '.rb',
  '.sh',
  '.so',
  '.ts',
  '.tsx',
  '.wasm',
  '.zsh',
]);

export class PackageValidationError extends Error {}

export async function readBoundedDirectoryEntries(
  path: string,
  maxEntries: number,
  limitError: string,
): Promise<Dirent[]> {
  const directory = await opendir(path, { bufferSize: Math.min(maxEntries + 1, 32) });
  const entries: Dirent[] = [];
  try {
    while (true) {
      const entry = await directory.read();
      if (!entry) break;
      entries.push(entry);
      if (entries.length > maxEntries) validationError(limitError);
    }
  } finally {
    await directory.close().catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ERR_DIR_CLOSED') throw error;
    });
  }
  entries.sort((first, second) => first.name.localeCompare(second.name));
  return entries;
}

type OpenFile = Awaited<ReturnType<typeof open>>;
type FileStatus = Awaited<ReturnType<OpenFile['stat']>>;
type DirectoryAnchor = { handle: OpenFile; path: string; status: FileStatus };

export type PackagePathBoundary = {
  anchors: DirectoryAnchor[];
  lexicalProjectRoot: string;
  lexicalProjectStatus: FileStatus;
  realPackageRoot: string;
  realProjectRoot: string;
};

export function sameFileIdentity(first: FileStatus, second: FileStatus): boolean {
  return (
    first.dev === second.dev &&
    first.ino === second.ino &&
    first.size === second.size &&
    first.mtimeMs === second.mtimeMs &&
    first.ctimeMs === second.ctimeMs
  );
}

export function directoryOpenFlags(): number {
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const directoryOnly = constants.O_DIRECTORY ?? 0;
  return constants.O_RDONLY | noFollow | directoryOnly;
}

async function openDirectoryAnchor(path: string): Promise<DirectoryAnchor> {
  const pathStatus = await lstat(path);
  if (pathStatus.isSymbolicLink() || !pathStatus.isDirectory()) {
    validationError(`package directory changed while being inspected: ${path}`);
  }
  const handle = await open(path, directoryOpenFlags());
  try {
    const status = await handle.stat();
    if (!status.isDirectory() || !sameFileIdentity(pathStatus, status)) {
      validationError(`package directory changed while being inspected: ${path}`);
    }
    return { handle, path, status };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

async function closeAnchors(anchors: DirectoryAnchor[]): Promise<void> {
  await Promise.all(anchors.map((anchor) => anchor.handle.close().catch(() => {})));
}

export async function capturePackagePathBoundary(
  projectRoot: string,
  packageRoot: string,
): Promise<PackagePathBoundary> {
  const lexicalProjectRoot = resolve(projectRoot);
  const lexicalProjectStatus = await lstat(lexicalProjectRoot);
  const [realProjectRoot, realPackageRoot] = await Promise.all([
    realpath(lexicalProjectRoot),
    realpath(packageRoot),
  ]);
  if (!isContained(realProjectRoot, realPackageRoot)) {
    validationError('package folder resolves outside its parent directory');
  }
  const anchors: DirectoryAnchor[] = [];
  let current = realProjectRoot;
  try {
    anchors.push(await openDirectoryAnchor(current));
    for (const segment of relative(realProjectRoot, realPackageRoot).split(sep)) {
      current = join(current, segment);
      anchors.push(await openDirectoryAnchor(current));
    }
    const boundary = {
      anchors,
      lexicalProjectRoot,
      lexicalProjectStatus,
      realPackageRoot,
      realProjectRoot,
    };
    await assertPackagePathContained(boundary, packageRoot);
    await assertPackagePathBoundaryUnchanged(boundary);
    return boundary;
  } catch (error) {
    await closeAnchors(anchors);
    throw error;
  }
}

export async function assertPackagePathBoundaryUnchanged(
  boundary: PackagePathBoundary,
): Promise<void> {
  const [lexicalProjectStatus, currentRealProjectRoot] = await Promise.all([
    lstat(boundary.lexicalProjectRoot),
    realpath(boundary.lexicalProjectRoot),
  ]);
  if (
    currentRealProjectRoot !== boundary.realProjectRoot ||
    !sameFileIdentity(boundary.lexicalProjectStatus, lexicalProjectStatus)
  ) {
    validationError('package parent directory changed while the package was being inspected');
  }
  for (const anchor of boundary.anchors) {
    const [pathStatus, handleStatus] = await Promise.all([
      lstat(anchor.path),
      anchor.handle.stat(),
    ]);
    if (
      !pathStatus.isDirectory() ||
      !handleStatus.isDirectory() ||
      !sameFileIdentity(anchor.status, handleStatus) ||
      !sameFileIdentity(pathStatus, handleStatus)
    ) {
      validationError('package path changed while the package was being inspected');
    }
  }
}

export async function assertPackagePathContained(
  boundary: PackagePathBoundary,
  path: string,
): Promise<void> {
  const resolvedPath = await resolvePathWithinStableRoot(
    boundary.lexicalProjectRoot,
    boundary.realProjectRoot,
    path,
  );
  if (
    !resolvedPath ||
    !(
      resolvedPath === boundary.realPackageRoot ||
      isContained(boundary.realPackageRoot, resolvedPath)
    )
  ) {
    validationError('package entry resolves outside the captured package boundary');
  }
}

export async function closePackagePathBoundary(boundary: PackagePathBoundary): Promise<void> {
  await closeAnchors(boundary.anchors);
}

function pathsCollide(first: string, second: string): boolean {
  const a = first.toLowerCase();
  const b = second.toLowerCase();
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

export function validatePackageEntryPath(
  path: string,
  kind: 'directory' | 'file',
  entrypoint: string,
): void {
  const error = portablePackagePathError(path);
  if (error) validationError(`package entry "${path}": ${error}`);
  if (path.split('/').some((segment) => FORBIDDEN_PACKAGE_DIRECTORIES.has(segment.toLowerCase()))) {
    validationError(`package entry "${path}" uses a forbidden directory`);
  }
  if (pathsCollide(path, 'package.json') || pathsCollide(path, '.frink-package.json')) {
    validationError(`package entry "${path}" collides with Frink-managed metadata`);
  }
  if (kind === 'directory') {
    if (pathsCollide(path, 'manifest.json') || pathsCollide(path, entrypoint)) {
      validationError(`package directory "${path}" collides with a managed file`);
    }
    return;
  }
  const lower = path.toLowerCase();
  if (lower === 'manifest.json' || path === entrypoint) return;
  if (lower === entrypoint.toLowerCase()) {
    validationError(`package entrypoint must use the exact manifest spelling "${entrypoint}"`);
  }
  const extension = extname(path).toLowerCase();
  if (extension === '.js' || extension === '.mjs') return;
  if (!extension || MODULE_OR_EXECUTABLE_EXTENSIONS.has(extension)) {
    validationError(
      `package entry "${path}" must be a JavaScript module or non-executable data file`,
    );
  }
}

export function validatePortablePackageCollisions(directories: string[], files: string[]): void {
  const paths = [...directories, ...files].sort();
  const seen = new Map<string, string>();
  for (const path of paths) {
    const folded = path.toLowerCase();
    const collision = seen.get(folded);
    if (collision) validationError(`package paths "${collision}" and "${path}" collide`);
    seen.set(folded, path);
  }
  for (const file of files) {
    const prefix = `${file.toLowerCase()}/`;
    const descendant = paths.find((candidate) => candidate.toLowerCase().startsWith(prefix));
    if (descendant) {
      validationError(`package file "${file}" collides with descendant "${descendant}"`);
    }
  }
}

export function validationError(message: string): never {
  throw new PackageValidationError(message);
}

function portableSegmentError(segment: string): string | null {
  if (segment === '' || segment === '.' || segment === '..') {
    return 'path contains an empty, ".", or ".." segment';
  }
  if (segment.length > MAX_PACKAGE_SEGMENT_CHARS) {
    return `path segment exceeds ${MAX_PACKAGE_SEGMENT_CHARS} characters`;
  }
  const hasForbiddenCharacter = [...segment].some(
    (character) => character.charCodeAt(0) <= 31 || WINDOWS_FORBIDDEN_CHARS.has(character),
  );
  if (
    hasForbiddenCharacter ||
    WINDOWS_DEVICE_RE.test(segment) ||
    WINDOWS_TRAILING_RE.test(segment)
  ) {
    return `path segment "${segment}" is not portable to Windows`;
  }
  return null;
}

function portablePathSpellingError(path: string): string | null {
  if (path.length === 0) return 'path must not be empty';
  if (path.length > MAX_PACKAGE_PATH_CHARS) {
    return `path exceeds ${MAX_PACKAGE_PATH_CHARS} characters`;
  }
  if (path.includes('\\') || path.startsWith('/') || win32.isAbsolute(path)) {
    return 'path must be a relative POSIX path';
  }
  if (path.normalize('NFC') !== path || posix.normalize(path) !== path) {
    return 'path must use canonical Unicode and POSIX spelling';
  }
  return null;
}

function portablePathSegmentsError(path: string): string | null {
  const segments = path.split('/');
  if (segments.length > MAX_PACKAGE_PATH_SEGMENTS) {
    return `path exceeds ${MAX_PACKAGE_PATH_SEGMENTS} segments`;
  }
  for (const segment of segments) {
    const error = portableSegmentError(segment);
    if (error) return error;
  }
  return null;
}

function portablePackagePathError(path: string): string | null {
  return portablePathSpellingError(path) ?? portablePathSegmentsError(path);
}

export function packagePathError(packagePath: string): string | null {
  if (packagePath === '' || packagePath === '.') {
    return 'packagePath must name a dedicated package subdirectory';
  }
  const portableError = portablePackagePathError(packagePath);
  if (portableError) return `packagePath ${portableError}`;
  if (
    isAbsolute(packagePath) ||
    packagePath
      .split('/')
      .some((segment) => FORBIDDEN_PACKAGE_DIRECTORIES.has(segment.toLowerCase()))
  ) {
    return 'packagePath must be a relative package directory outside .git and node_modules';
  }
  return null;
}

function isContained(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child !== '' && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

export async function resolvePathWithinStableRoot(
  lexicalRoot: string,
  expectedRealRoot: string,
  path: string,
): Promise<string | null> {
  const [currentRealRoot, resolvedPath] = await Promise.all([
    realpath(lexicalRoot),
    realpath(path),
  ]);
  if (
    currentRealRoot !== expectedRealRoot ||
    (resolvedPath !== expectedRealRoot && !isContained(expectedRealRoot, resolvedPath))
  ) {
    return null;
  }
  return resolvedPath;
}

export async function resolvePackageRoot(sourceRoot: string, packagePath: string): Promise<string> {
  const pathError = packagePathError(packagePath);
  if (pathError) validationError(pathError);

  const lexicalProjectRoot = resolve(sourceRoot);
  const lexicalPackageRoot = resolve(lexicalProjectRoot, packagePath);
  if (!isContained(lexicalProjectRoot, lexicalPackageRoot)) {
    validationError('packagePath resolves outside its base directory');
  }

  let current = lexicalProjectRoot;
  for (const segment of packagePath.split('/')) {
    current = join(current, segment);
    let status: Awaited<ReturnType<typeof lstat>>;
    try {
      status = await lstat(current);
    } catch (error) {
      const parsed = errorCodeSchema.safeParse(error);
      if (parsed.success && parsed.data.code === 'ENOENT') {
        validationError(`packagePath does not exist: ${packagePath}`);
      }
      throw error;
    }
    if (status.isSymbolicLink()) {
      validationError(`packagePath component is a symbolic link: ${segment}`);
    }
  }

  const packageStatus = await lstat(lexicalPackageRoot);
  if (!packageStatus.isDirectory()) {
    validationError('packagePath must point to a directory');
  }
  const [realProjectRoot, realPackageRoot] = await Promise.all([
    realpath(lexicalProjectRoot),
    realpath(lexicalPackageRoot),
  ]);
  if (!isContained(realProjectRoot, realPackageRoot)) {
    validationError('packagePath resolves outside its base directory');
  }
  return lexicalPackageRoot;
}
