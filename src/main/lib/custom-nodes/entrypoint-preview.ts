import type { Stats } from 'node:fs';
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { resolveCustomNodeEntrypoint, resolveExistingContainedCustomNodePath } from './runtime';

/** Max bytes read for entrypoint preview via IPC (security + performance). */
export const MAX_ENTRYPOINT_READ_BYTES = 512 * 1024;

type PreviewManifest = {
  name: string;
  entrypoint: string;
};

export function findCustomNodeManifest<T extends { name: string }>(
  manifests: readonly T[],
  nodeName: string,
): T | undefined {
  return manifests.find((manifest) => manifest.name === nodeName);
}

type EntrypointPreviewDependencies = {
  discoverCustomNodes: (nodesDir: string) => { valid: PreviewManifest[] };
  nodeNamePattern: RegExp;
};

export type CustomNodeEntrypointPreviewResult =
  | {
      ok: true;
      path: string;
      content: string;
      truncated: boolean;
      language: 'javascript';
    }
  | { ok: false; error: string };

type PreviewOperationFailure = { ok: false; error: string };
type PreviewOperationResult<T> = { ok: true; value: T } | PreviewOperationFailure;

type EntrypointBytes = {
  buffer: Buffer;
  truncated: boolean;
};

function previewOperationSucceeded<T>(value: T): PreviewOperationResult<T> {
  return { ok: true, value };
}

function previewOperationFailed(error: string): PreviewOperationFailure {
  return { ok: false, error };
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function statEntrypoint(entrypointPath: string): PreviewOperationResult<Stats> {
  let stats: Stats;
  try {
    stats = statSync(entrypointPath);
  } catch (error) {
    return previewOperationFailed(errorMessage(error, 'Failed to stat entrypoint'));
  }
  if (!stats.isFile()) {
    return previewOperationFailed('Entrypoint is not a file');
  }
  return previewOperationSucceeded(stats);
}

function readEntrypointBytes(
  entrypointPath: string,
  entrypointSize: number,
): PreviewOperationResult<EntrypointBytes> {
  const truncated = entrypointSize > MAX_ENTRYPOINT_READ_BYTES;
  const readLength = truncated ? MAX_ENTRYPOINT_READ_BYTES : entrypointSize;
  let buffer = Buffer.alloc(readLength);
  let fileDescriptor: number | undefined;
  try {
    fileDescriptor = openSync(entrypointPath, 'r');
    const bytesRead = readSync(fileDescriptor, buffer, 0, readLength, 0);
    buffer = buffer.subarray(0, bytesRead);
    return previewOperationSucceeded({ buffer, truncated });
  } catch (error) {
    return previewOperationFailed(errorMessage(error, 'Failed to read entrypoint'));
  } finally {
    if (fileDescriptor !== undefined) closeSync(fileDescriptor);
  }
}

function decodeEntrypointContent(
  buffer: Buffer,
  truncated: boolean,
): PreviewOperationResult<string> {
  let content: string;
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return previewOperationFailed('Entrypoint is not valid UTF-8 text');
  }
  if (truncated) {
    content += '\n\n// … truncated (file exceeds preview limit)';
  }
  return previewOperationSucceeded(content);
}

/**
 * Read a bounded UTF-8 preview of a custom node's entrypoint for the flow editor.
 * Path-safe: realpath + must stay under resolved nodes root and inside the node folder.
 */
export function readCustomNodeEntrypointPreviewFromDisk(
  dependencies: EntrypointPreviewDependencies,
  defaultNodesDir: string,
  nodeName: string,
  nodesDir: string = defaultNodesDir,
): CustomNodeEntrypointPreviewResult {
  if (typeof nodeName !== 'string' || !dependencies.nodeNamePattern.test(nodeName)) {
    return previewOperationFailed('Invalid custom node name');
  }
  if (!existsSync(nodesDir)) {
    return previewOperationFailed('Custom nodes directory does not exist');
  }
  if (!existsSync(join(nodesDir, nodeName))) {
    return previewOperationFailed(`Node "${nodeName}" not found locally`);
  }
  let nodeDirectory: string;
  try {
    nodeDirectory = resolveExistingContainedCustomNodePath(nodesDir, nodeName);
  } catch (error) {
    const message = errorMessage(error, 'Failed to resolve node path');
    return previewOperationFailed(
      message.includes('outside node directory') ? 'Node path outside nodes directory' : message,
    );
  }

  const manifest = findCustomNodeManifest(
    dependencies.discoverCustomNodes(nodesDir).valid,
    nodeName,
  );
  if (!manifest) {
    return previewOperationFailed(`Node "${nodeName}" not found or invalid manifest`);
  }
  const entrypoint = manifest.entrypoint.trim();

  let entrypointPath: PreviewOperationResult<string>;
  try {
    entrypointPath = previewOperationSucceeded(
      resolveCustomNodeEntrypoint(nodeDirectory, entrypoint),
    );
  } catch (error) {
    entrypointPath = previewOperationFailed(errorMessage(error, 'Failed to resolve entrypoint'));
  }
  if (!entrypointPath.ok) return entrypointPath;

  const entrypointStats = statEntrypoint(entrypointPath.value);
  if (!entrypointStats.ok) return entrypointStats;

  const entrypointBytes = readEntrypointBytes(entrypointPath.value, entrypointStats.value.size);
  if (!entrypointBytes.ok) return entrypointBytes;

  const content = decodeEntrypointContent(
    entrypointBytes.value.buffer,
    entrypointBytes.value.truncated,
  );
  if (!content.ok) return content;

  return {
    ok: true,
    path: entrypointPath.value,
    content: content.value,
    truncated: entrypointBytes.value.truncated,
    language: 'javascript',
  };
}
