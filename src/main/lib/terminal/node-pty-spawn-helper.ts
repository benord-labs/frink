import { chmodSync, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import log from 'electron-log';
import { captureMainMessage } from '../sentry/init';

const nodeRequire = createRequire(import.meta.url);

const ASAR_ARCHIVE_SEGMENT = /app\.asar([/\\])/;

/**
 * Candidate spawn-helper paths in node-pty's own loader probe order
 * (build/Release → build/Debug → prebuilds/<platform>-<arch>), remapped out of
 * the asar archive since binaries under asarUnpack live in app.asar.unpacked.
 */
export function spawnHelperCandidates(
  resolveNodePty: () => string = () => nodeRequire.resolve('node-pty'),
): string[] {
  const packageRoot = path.dirname(path.dirname(resolveNodePty()));
  return [
    path.join(packageRoot, 'build', 'Release', 'spawn-helper'),
    path.join(packageRoot, 'build', 'Debug', 'spawn-helper'),
    path.join(packageRoot, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'),
  ].map((candidate) => candidate.replace(ASAR_ARCHIVE_SEGMENT, 'app.asar.unpacked$1'));
}

/**
 * node-pty's published 1.1.0 tarball ships prebuilds/darwin-* spawn-helper
 * without the exec bit (microsoft/node-pty#850 — fixed upstream Jan 2026 but
 * only released on the `beta` dist-tag), so posix_spawnp fails with EACCES for
 * every shell. Repair the bit on the candidate node-pty will actually load.
 * Delete once microsoft/node-pty#919 ships a patched release we can pin.
 */
export function ensureSpawnHelperExecutable(): void {
  if (process.platform === 'win32') return;
  try {
    for (const candidate of spawnHelperCandidates()) {
      if (!existsSync(candidate)) continue;
      const mode = statSync(candidate).mode;
      if ((mode & 0o111) === 0) chmodSync(candidate, mode | 0o755);
      return;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn(`[terminal] spawn-helper exec-bit repair failed: ${message}`);
    // The spawn attempt proceeds and may fail EACCES — monitor the repair itself.
    captureMainMessage('spawn-helper exec-bit repair failed', 'warning', { message });
  }
}
