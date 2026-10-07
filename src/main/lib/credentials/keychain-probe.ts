// Metadata-only macOS keychain probe, shared by source-readers.ts and detect-codex.ts; its
// own module because `source-readers` already imports `detect-codex`.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import log from 'electron-log';
import {
  isMacOSKeychainAuthorizationError,
  isMacOSKeychainTimeoutError,
  sanitizeError,
} from './detect';
import { KEYCHAIN_READ_TIMEOUT_MS } from './keychain-shared';

// Non-blocking, so a slow keychain can't stall chat IPC or SQLite reads on the main thread.
const execFileAsync = promisify(execFile);

export type ProbeResult =
  | { ok: true }
  | { error: 'missing' | 'denied' | 'malformed'; detail?: string };

export async function probeDarwinKeychainItem(
  serviceName: string,
  account?: string,
): Promise<ProbeResult> {
  if (process.platform !== 'darwin') {
    return { error: 'missing', detail: 'darwin-keychain source not available on this OS' };
  }

  try {
    // No `-w`: it prints the secret and raises the item's ACL prompt. Metadata alone
    // answers "does this login exist". Do not add `-w` back.
    const args = ['find-generic-password', '-s', serviceName];
    if (account) args.push('-a', account);
    await execFileAsync('security', args, {
      encoding: 'utf-8',
      // Hard cap so a locked keychain can't hang the caller. The resulting SIGTERM reads
      // as a transient denial: nothing is persisted and the next resolution re-probes.
      timeout: KEYCHAIN_READ_TIMEOUT_MS,
    });
  } catch (error) {
    if (isMacOSKeychainAuthorizationError(error) || isMacOSKeychainTimeoutError(error)) {
      log.warn('[keychain-probe] keychain access denied/timed out:', sanitizeError(error));
      return { error: 'denied', detail: 'macOS denied keychain access or the read timed out' };
    }
    log.debug('[keychain-probe] keychain probe failed:', sanitizeError(error));
    return { error: 'missing', detail: 'keychain entry not found' };
  }
  return { ok: true };
}
