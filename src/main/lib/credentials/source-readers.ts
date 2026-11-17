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

import { existsSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { CLAUDE_CONFIG_FILE_LINUX } from './detect';
import { CODEX_KEYCHAIN_SERVICE, codexKeyringAccount, resolveCodexHome } from './detect-codex';
import { type ProbeResult, probeDarwinKeychainItem } from './keychain-probe';

// Top-level regexes (perf rule).
const WINDOWS_DRIVE_PREFIX_RE = /^\/(?=[A-Za-z]:)/;

const DARWIN_KEYCHAIN_SCHEME = 'darwin-keychain://';
const FILE_SCHEME = 'file://';
// Legacy rows only: new connects can't produce it (see ALLOWED_SOURCE_PATH_SCHEMES).
const LEGACY_SECRET_TOOL_SCHEME = 'secret-tool://';

/**
 * Whitelist of accepted URI schemes for `sourcePath`. Any value persisted to
 * `claude_code_credentials.source_path` is consumed by `probeClaudePassthroughSource`,
 * which in turn dispatches to one of these probes — so the input zod schema in
 * `claude-code.ts:connectClaudePassthrough` MUST reject anything that doesn't
 * match this set, otherwise an attacker-controlled value could route to an
 * unintended probe (or a future one).
 */
export const ALLOWED_SOURCE_PATH_SCHEMES = [DARWIN_KEYCHAIN_SCHEME, FILE_SCHEME] as const;

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
  if (sourcePath.startsWith(LEGACY_SECRET_TOOL_SCHEME)) {
    return probeLegacySecretToolRow();
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
  return probeDarwinKeychainItem(CODEX_KEYCHAIN_SERVICE, await codexKeyringAccount(codexHome));
}

// Pre-sc-3807 keyring row: the CLI reads only the credentials file on Linux, and secret-tool
// prints the token, so presence is the file (decisions/claude-credential-ownership-at-spawn).
function probeLegacySecretToolRow(): ProbeResult {
  if (process.platform !== 'linux') {
    return { error: 'missing', detail: 'secret-tool source not available on this OS' };
  }
  if (!existsSync(CLAUDE_CONFIG_FILE_LINUX)) {
    return {
      error: 'missing',
      detail: 'Claude CLI on Linux reads only ~/.claude/.credentials.json',
    };
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
