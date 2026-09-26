import { createHash } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { type PackageFileHandle, packageFileSystem } from './package-file-system';
import { sameFileIdentity } from './package-paths';

const COPY_BUFFER_BYTES = 1024 * 1024;
const NO_FOLLOW_OPEN_FLAG = constants.O_NOFOLLOW ?? 0;

export async function consumeOpenFileAtMost(
  source: PackageFileHandle,
  maxBytes: number,
  consume: (chunk: Buffer, offset: number) => void | Promise<void>,
): Promise<number> {
  const buffer = Buffer.allocUnsafe(Math.min(COPY_BUFFER_BYTES, maxBytes + 1));
  let offset = 0;
  while (offset <= maxBytes) {
    const length = Math.min(buffer.byteLength, maxBytes + 1 - offset);
    const { bytesRead } = await source.read(buffer, 0, length, offset);
    if (bytesRead === 0) break;
    await consume(buffer.subarray(0, bytesRead), offset);
    offset += bytesRead;
  }
  return offset;
}

export async function readOpenFileAtMost(
  source: PackageFileHandle,
  maxBytes: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const bytesRead = await consumeOpenFileAtMost(source, maxBytes, (chunk) => {
    chunks.push(Buffer.from(chunk));
  });
  return Buffer.concat(chunks, bytesRead);
}

export async function openStableFile(
  path: string,
  pathStatus: Stats,
  assertContained: () => Promise<void>,
  changed: () => never,
  onOpenError?: (error: Error) => void,
): Promise<{ before: Stats; handle: PackageFileHandle }> {
  await assertContained();
  let handle: PackageFileHandle;
  try {
    handle = await packageFileSystem.open(path, constants.O_RDONLY | NO_FOLLOW_OPEN_FLAG);
  } catch (error) {
    onOpenError?.(error instanceof Error ? error : new Error(String(error)));
    throw error;
  }
  try {
    const before = await handle.stat();
    if (!sameFileIdentity(pathStatus, before)) changed();
    await assertContained();
    if (!sameFileIdentity(await lstat(path), before)) changed();
    return { before, handle };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

export async function readStableOpenFileAtMost(
  source: PackageFileHandle,
  path: string,
  expected: Stats,
  maxBytes: number,
): Promise<{ bytes: Buffer; stable: boolean }> {
  const bytes = await readOpenFileAtMost(source, maxBytes);
  const [after, pathStatus] = await Promise.all([source.stat(), lstat(path)]);
  return {
    bytes,
    stable:
      sameFileIdentity(expected, after) &&
      sameFileIdentity(pathStatus, after) &&
      bytes.byteLength === expected.size,
  };
}

export async function hashOpenFileContents(
  source: PackageFileHandle,
  maxBytes: number,
): Promise<{ bytesRead: number; hash: string }> {
  const hash = createHash('sha256');
  const bytesRead = await consumeOpenFileAtMost(source, maxBytes, (chunk) => {
    hash.update(chunk);
  });
  return { bytesRead, hash: hash.digest('hex') };
}
