/**
 * Codex CLI binary resolver.
 *
 * Only the bundled, permission-aware Codex build satisfies the app-server contract, and only when
 * its `CODEX_VERSION` stamp (scripts/binaries/build-codex-frink.mjs) matches this app's patch.
 *
 * Auth is passthrough: Frink never stores an OpenAI key. The spawned
 * `codex app-server` reads the user's `codex login` credentials (OS keyring /
 * ~/.codex), so the resolver only needs to LOCATE the binary, not authenticate.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import codexManifest from '../../../../../patches/codex/manifest.json';
import { captureMainMessage } from '../../sentry/init';
import { getBundledBinaryPath } from '../bundled-binary';

/** Must match `codexVersionStamp` in scripts/binaries/build-codex-frink.mjs. */
const EXPECTED_STAMP = `${codexManifest.version}+frink.${codexManifest.patchSha256.slice(0, 12)}`;

// Memoize the bundled-binary probe for the app lifetime.
let bundledChecked = false;
let bundledPath: string | null = null;
let bundledStale = false;

function readStamp(binaryPath: string): string {
  return readFileSync(path.join(path.dirname(binaryPath), 'CODEX_VERSION'), 'utf8').trim();
}

/**
 * Absolute path to the bundled permission-aware `codex` binary, or null when absent or built
 * from a different patch than this app expects.
 */
function getBundledCodexBinaryPath(): string | null {
  if (bundledChecked) return bundledPath;
  try {
    const candidate = getBundledBinaryPath('codex');
    if (existsSync(candidate)) {
      // Stale until the stamp proves otherwise: a pre-stamp build has no CODEX_VERSION at all.
      bundledStale = true;
      if (readStamp(candidate) === EXPECTED_STAMP) {
        bundledStale = false;
        bundledPath = candidate;
      }
    }
  } catch {
    bundledPath = null;
  }
  if (bundledStale) {
    // A shipped build with a stale or unstamped Codex is a packaging defect, not a user error.
    captureMainMessage('Bundled Codex binary does not match the expected patch stamp', 'error', {
      surface: 'codex-binary',
    });
  }
  bundledChecked = true;
  return bundledPath;
}

/**
 * Resolve only the bundled permission-aware Codex binary.
 */
export function resolveCodexBinary(): string | null {
  return getBundledCodexBinaryPath();
}

/** Reset the resolver caches (test-only — exported so tests need no internal access). */
export function clearCodexBinaryCache(): void {
  bundledChecked = false;
  bundledPath = null;
  bundledStale = false;
}

/**
 * User-facing message when the bundled binary is missing or stale. Developer diagnosis lives in
 * the Sentry capture above and the resolver docblock, never in the chat.
 */
export function getCodexCliMissingMessage(): string {
  return 'Codex isn’t working in this copy of Frink — part of the install is missing or out of date. Reinstall Frink to fix this.';
}
