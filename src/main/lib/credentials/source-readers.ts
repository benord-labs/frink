/**
 * Probe that a Claude passthrough source (keychain entry / credentials file) EXISTS.
 * Called at chat-time by `credentials.ts` for any row whose `source = 'claude-passthrough'`.
 *
 * Frink does not read the token. The spawned `claude` binary reads the canonical
 * keychain item itself (the executor pins `CLAUDE_SECURESTORAGE_CONFIG_DIR=''`) and
 * owns rotation, expiry and cross-process refresh locking. Frink's only job here is
 * to answer "is there a login to hand the agent?" so the pre-flight can fail loud
 * instead of the CLI reporting "Not logged in" mid-run.
 *
 * There is deliberately no cache: the probe reads metadata only (~30ms, no TCC
 * prompt), so caching bought nothing and could only serve a stale answer.
 *
 * IMPORTANT — never use a shell-string child_process call here. Service / account
 * names are URL-decoded from a value we control AT WRITE TIME but that's still
 * the wrong invariant: the safe rule is "never pass user-derived strings to a
 * shell". Use `execFile` (no shell, argv array). See pre-commit api-security
 * review HIGH #1 (May 2026).
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import log from 'electron-log';
import {
  isMacOSKeychainAuthorizationError,
  isMacOSKeychainTimeoutError,
  sanitizeError,
} from './detect';
import { CODEX_KEYCHAIN_SERVICE, codexKeyringAccount, resolveCodexHome } from './detect-codex';
import { KEYCHAIN_READ_TIMEOUT_MS } from './keychain-shared';

// Promisified, non-blocking. Returning a Promise lets the event loop continue
// while `security` / `secret-tool` is queued in libuv's process pool, so chat
// IPC and SQLite reads on the main thread aren't stalled by a slow keychain.
const execFileAsync = promisify(execFile);

// Top-level regexes (perf rule).
const WINDOWS_DRIVE_PREFIX_RE = /^\/(?=[A-Za-z]:)/;

type ProbeResult = { ok: true } | { error: 'missing' | 'denied' | 'malformed'; detail?: string };

const DARWIN_KEYCHAIN_SCHEME = 'darwin-keychain://';
const FILE_SCHEME = 'file://';
const SECRET_TOOL_SCHEME = 'secret-tool://';

/**
 * Whitelist of accepted URI schemes for `sourcePath`. Any value persisted to
 * `claude_code_credentials.source_path` is consumed by `probeClaudePassthroughSource`,
 * which in turn dispatches to one of these probes — so the input zod schema in
 * `claude-code.ts:connectClaudePassthrough` MUST reject anything that doesn't
 * match this set, otherwise an attacker-controlled value could route to an
 * unintended probe (or a future one).
 */
export const ALLOWED_SOURCE_PATH_SCHEMES = [
  DARWIN_KEYCHAIN_SCHEME,
  FILE_SCHEME,
  SECRET_TOOL_SCHEME,
] as const;

/**
 * Public entrypoint. Confirms the source exists, without reading the secret.
 *
 * Errors are intentionally narrow ('missing'/'denied'/'malformed') so callers can
 * surface specific UX (e.g. "macOS denied keychain access" vs "file is gone").
 */
export async function probeClaudePassthroughSource(sourcePath: string): Promise<ProbeResult> {
  if (sourcePath.startsWith(DARWIN_KEYCHAIN_SCHEME)) {
    return probeDarwinKeychain(sourcePath);
  }
  if (sourcePath.startsWith(FILE_SCHEME)) {
    return probeFile(sourcePath);
  }
  if (sourcePath.startsWith(SECRET_TOOL_SCHEME)) {
    return probeLinuxSecretTool(sourcePath);
  }
  return { error: 'malformed', detail: `Unsupported source URI scheme: ${sourcePath}` };
}

/** Codex login presence: `$CODEX_HOME/auth.json`, else the macOS "Codex Auth" keyring item. */
export async function probeCodexPassthroughSource(): Promise<ProbeResult> {
  const codexHome = resolveCodexHome();
  const authFile = await access(join(codexHome, 'auth.json')).then(
    () => 'present' as const,
    (error: { code?: string }) => (error.code === 'ENOENT' ? 'absent' : 'unreadable'),
  );
  if (authFile === 'present') return { ok: true };
  // EACCES/EMFILE etc. say nothing about the login — transient, never a logout.
  if (authFile === 'unreadable') return { error: 'denied', detail: 'auth.json is unreadable' };
  return probeDarwinKeychainItem(CODEX_KEYCHAIN_SERVICE, codexKeyringAccount(codexHome));
}

async function probeLinuxSecretTool(sourcePath: string): Promise<ProbeResult> {
  if (process.platform !== 'linux') {
    return { error: 'missing', detail: 'secret-tool source not available on this OS' };
  }
  const remainder = sourcePath.slice(SECRET_TOOL_SCHEME.length);
  const slashIdx = remainder.indexOf('/');
  if (slashIdx === -1) {
    return { error: 'malformed', detail: 'secret-tool URI must be service/account' };
  }
  const service = decodeURIComponent(remainder.slice(0, slashIdx));
  const account = decodeURIComponent(remainder.slice(slashIdx + 1));
  if (!service || !account) {
    return { error: 'malformed', detail: 'empty secret-tool service or account' };
  }

  // `search` reports matching attributes; `lookup` would print the secret itself.
  // execFileAsync passes service/account as argv elements — no shell, no interpolation.
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      'secret-tool',
      ['search', 'service', service, 'account', account],
      { encoding: 'utf-8', timeout: KEYCHAIN_READ_TIMEOUT_MS },
    ));
  } catch (error) {
    if (isMacOSKeychainTimeoutError(error)) {
      log.warn('[source-readers] secret-tool timed out:', sanitizeError(error));
      return { error: 'denied', detail: 'secret-tool read timed out' };
    }
    log.debug('[source-readers] secret-tool search failed:', sanitizeError(error));
    return { error: 'missing', detail: 'secret-tool entry not found' };
  }
  // `search` exits 0 with EMPTY output when nothing matches — the exit code alone would
  // report a login that isn't there. The attribute listing, not the status, is the signal.
  if (!stdout.trim()) {
    return { error: 'missing', detail: 'secret-tool entry not found' };
  }
  return { ok: true };
}

async function probeDarwinKeychain(sourcePath: string): Promise<ProbeResult> {
  const serviceName = decodeURIComponent(sourcePath.slice(DARWIN_KEYCHAIN_SCHEME.length));
  if (!serviceName) {
    return { error: 'malformed', detail: 'empty keychain service name' };
  }
  return probeDarwinKeychainItem(serviceName);
}

async function probeDarwinKeychainItem(
  serviceName: string,
  account?: string,
): Promise<ProbeResult> {
  if (process.platform !== 'darwin') {
    return { error: 'missing', detail: 'darwin-keychain source not available on this OS' };
  }

  try {
    // No `-w`: that flag prints the secret and consults the item's ACL. Metadata alone
    // answers "does this login exist", costs no TCC prompt, and keeps the token out of
    // frink's memory entirely. Do not add `-w` back.
    const args = ['find-generic-password', '-s', serviceName];
    if (account) args.push('-a', account);
    await execFileAsync('security', args, {
      encoding: 'utf-8',
      // Hard cap so a locked keychain (screen saver, fresh boot before unlock)
      // can't hang the executor. After SIGTERM we treat it as a denial — transient,
      // nothing persisted; the next resolution re-probes once the keychain unlocks.
      timeout: KEYCHAIN_READ_TIMEOUT_MS,
    });
  } catch (error) {
    if (isMacOSKeychainAuthorizationError(error) || isMacOSKeychainTimeoutError(error)) {
      log.warn('[source-readers] keychain access denied/timed out:', sanitizeError(error));
      return { error: 'denied', detail: 'macOS denied keychain access or the read timed out' };
    }
    log.debug('[source-readers] keychain probe failed:', sanitizeError(error));
    return { error: 'missing', detail: 'keychain entry not found' };
  }
  return { ok: true };
}

function probeFile(sourcePath: string): ProbeResult {
  // Strip the scheme — keep three slashes so absolute paths survive.
  const filePath = sourcePath.slice(FILE_SCHEME.length).replace(WINDOWS_DRIVE_PREFIX_RE, '');
  // Above replace is for Windows; macOS/Linux paths start with '/' which we want to keep.
  const cleanPath =
    process.platform === 'win32' ? filePath : filePath.startsWith('/') ? filePath : `/${filePath}`;

  if (!existsSync(cleanPath)) {
    return { error: 'missing', detail: `file not found: ${cleanPath}` };
  }
  return { ok: true };
}
