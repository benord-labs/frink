/**
 * Detect existing Claude Code login on this machine.
 *
 * Reads the keychain (macOS), credentials file (Linux), or Credential Manager
 * fallback (Windows). NEVER returns the token itself — only metadata the UI
 * needs to display "Connected to {email}".
 *
 * Exactly one source is ever offered: the canonical, login-scoped entry. The
 * executor pins CLAUDE_SECURESTORAGE_CONFIG_DIR='' so the spawned CLI reads that
 * same entry, so anything else here would be unusable at spawn time.
 *
 * Presence at chat-time is re-probed by `source-readers.ts`.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import log from 'electron-log';
import { KEYCHAIN_READ_TIMEOUT_MS } from './keychain-shared';

type DetectClaudeAccountResult = {
  /** True when at least one usable Claude credential was found on this machine. */
  available: boolean;
  /** "you@example.com" when the user has signed into the Claude CLI; falls back to displayName. */
  email?: string;
  /** Friendly identifier for UI ("Claude Code Account", a workspace name, etc.). */
  displayName?: string;
  /** The canonical `Claude Code-credentials` sourcePath, when the login exists. */
  sourcePath?: string;
  /** Short user-facing reason when `available === false`. Never contains tokens. */
  hint?: string;
};

const CLAUDE_KEYCHAIN_SERVICE_PREFIX = 'Claude Code';
const LEGACY_KEYCHAIN_SERVICE = 'Claude Code-credentials';
const CLAUDE_CONFIG_FILE_LINUX = join(homedir(), '.claude', '.credentials.json');
const CLAUDE_CONFIG_FILE_WINDOWS = join(homedir(), '.claude', '.credentials.json');
const CLAUDE_USER_CONFIG_FILE = join(homedir(), '.claude.json');

/**
 * URI scheme tags so `source-readers` can dispatch by platform without re-detecting OS.
 *   darwin-keychain://<urlencoded service name>
 *   file:///abs/path
 */
function darwinKeychainUri(serviceName: string): string {
  return `darwin-keychain://${encodeURIComponent(serviceName)}`;
}

/**
 * URI scheme tag for Linux libsecret entries. Resolved at chat-time by
 * `source-readers.ts` shelling to `secret-tool lookup`.
 */
function secretToolUri(service: string, account: string): string {
  return `secret-tool://${encodeURIComponent(service)}/${encodeURIComponent(account)}`;
}

const FILE_URI_LEADING_SLASH_RE = /^[/]?/;

function fileUri(absolutePath: string): string {
  // path.join may return Windows-style backslashes; the URI form keeps forward slashes.
  return `file://${absolutePath.split('\\').join('/').replace(FILE_URI_LEADING_SLASH_RE, '/')}`;
}

type KeychainProbeResult = 'ok' | 'denied' | 'missing';

/**
 * Probe a single keychain entry. Returns:
 *   - `'ok'`     — entry exists and Frink has access (token successfully read)
 *   - `'denied'` — TCC denied (status 36 / "User interaction is not allowed").
 *                  Distinguished from `'missing'` so the caller can tell "you clicked
 *                  Don't Allow" from "there is no login" — different user fix.
 *   - `'missing'`— entry not found in the keychain (different exit status).
 *
 * Keeps `-w` (unlike the chat-time probe in `source-readers.ts`, which reads metadata
 * only). Connect is the one moment a keychain dialog is expected and in front of the
 * user, so this is where the access decision belongs — reading the secret is what makes
 * macOS ask. Frink discards the value; it only wants the exit status.
 */
function probeMacOSKeychainEntry(serviceName: string): KeychainProbeResult {
  try {
    execFileSync('security', ['find-generic-password', '-s', serviceName, '-w'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: KEYCHAIN_READ_TIMEOUT_MS,
    });
    return 'ok';
  } catch (error) {
    if (isMacOSKeychainAuthorizationError(error)) {
      return 'denied';
    }
    return 'missing';
  }
}

/**
 * Detect a `child_process` error from `security` that came from a TCC denial
 * (status 36) or an explicit user-cancel/interaction-not-allowed dialog.
 * Exported so `source-readers.ts` can map the same error class to its
 * `'denied'` result without re-implementing the heuristic.
 */
export function isMacOSKeychainAuthorizationError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const err = error as { status?: number; stderr?: string; message?: string };
  if (err.status === 36) return true;
  const stderr = (err.stderr ?? '').toLowerCase();
  const message = (err.message ?? '').toLowerCase();
  return (
    stderr.includes('user interaction is not allowed') ||
    stderr.includes('user canceled') ||
    message.includes('user interaction is not allowed') ||
    message.includes('user canceled')
  );
}

/**
 * Detect a `child_process` error from the kernel killing `security` after the
 * timeout fired (or Node's own ETIMEDOUT). We map these to the same UX as a
 * TCC denial — both leave the user with no token and require them to do
 * something (unlock keychain / re-auth).
 */
export function isMacOSKeychainTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const err = error as { code?: string | null; signal?: string | null };
  if (err.code === 'ETIMEDOUT') return true;
  if (err.signal === 'SIGTERM' || err.signal === 'SIGKILL') return true;
  return false;
}

/**
 * Read `~/.claude.json` (the CLI's settings file) for an email / userID to display
 * before the user clicks Connect. NEVER reads the credentials file — that's
 * `source-readers`'s job at chat-time.
 *
 * Exported so `credentials.ts` can use the same reader for its identity-drift
 * check at chat-time (was previously a separate `readClaudeUserEmail` copy).
 * Pre-commit DRY review (May 2026).
 */
export function readClaudeUserConfig(): {
  email?: string;
  userID?: string;
  organizationName?: string;
  accountUuid?: string;
  organizationUuid?: string;
} {
  try {
    if (!existsSync(CLAUDE_USER_CONFIG_FILE)) return {};
    const raw = readFileSync(CLAUDE_USER_CONFIG_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as {
      oauthAccount?: {
        emailAddress?: string;
        organizationName?: string;
        accountUuid?: string;
        organizationUuid?: string;
      };
      userID?: string;
    };
    const email = parsed?.oauthAccount?.emailAddress;
    const userID = parsed?.userID;
    const { organizationName, accountUuid, organizationUuid } = parsed?.oauthAccount ?? {};
    return {
      email: typeof email === 'string' ? email : undefined,
      userID: typeof userID === 'string' ? userID : undefined,
      organizationName: typeof organizationName === 'string' ? organizationName : undefined,
      accountUuid: typeof accountUuid === 'string' ? accountUuid : undefined,
      organizationUuid: typeof organizationUuid === 'string' ? organizationUuid : undefined,
    };
  } catch (error) {
    // Don't include the raw file content in the log — could contain other secrets.
    log.debug('[detect] readClaudeUserConfig failed:', sanitizeError(error));
    return {};
  }
}

function detectMacOS(): DetectClaudeAccountResult {
  // Happy path: probe the canonical service name `Claude Code-credentials`.
  // This is what `claude` CLI itself uses for its login-scoped credential, and
  // it's the right entry for Frink's passthrough — independent of any
  // workspace-scoped sub-credentials the CLI may have created in other dirs.
  const userConfig = readClaudeUserConfig();
  const canonicalProbe = probeMacOSKeychainEntry(LEGACY_KEYCHAIN_SERVICE);

  if (canonicalProbe === 'ok') {
    return {
      available: true,
      email: userConfig.email,
      displayName: userConfig.email ?? userConfig.userID ?? 'Claude Code',
      sourcePath: darwinKeychainUri(LEGACY_KEYCHAIN_SERVICE),
    };
  }

  // TCC denial: STOP HERE. Falling through to discover + probe workspace entries
  // would TCC-prompt for each one, drowning the user in dialogs after a single
  // "Don't Allow" click. They've already said no.
  if (canonicalProbe === 'denied') {
    return {
      available: false,
      hint: 'macOS denied keychain access for Frink. Re-allow access in System Settings → Privacy & Security → Keychain, or run `claude auth login` if no entry exists yet.',
    };
  }

  // Canonical entry genuinely MISSING. There is deliberately no workspace-entry fallback:
  // the executor pins CLAUDE_SECURESTORAGE_CONFIG_DIR='', which forces the spawned CLI onto
  // the unsuffixed `Claude Code-credentials` service. Connecting a workspace-scoped
  // `Claude Code-credentials-<hash>` here would record a sourcePath frink can probe but the
  // agent can never use. `claude auth login` is the only real fix.
  return {
    available: false,
    hint: 'No Claude Code login found in the macOS Keychain. Run `claude auth login` and try again.',
  };
}

const LINUX_SECRET_TOOL_SERVICE = 'Claude Code';
const LINUX_SECRET_TOOL_ACCOUNT = 'credentials';

function probeLinuxSecretService(): boolean {
  // Returns true when the secret store has a value at this (service, account).
  // Only used as a fallback when ~/.claude/.credentials.json is missing.
  //
  // execFileSync (argv form, no shell) — even though both args are
  // module-level constants today, the rule in `source-readers.ts:15-22` is
  // "no shell-string call site in credentials/", and a future caller might
  // wire in a user-derived value. Pre-commit api-security re-review (May 2026).
  // stdio: 'ignore' on stderr replaces the previous `2>/dev/null` redirect.
  try {
    const result = execFileSync(
      'secret-tool',
      ['lookup', 'service', LINUX_SECRET_TOOL_SERVICE, 'account', LINUX_SECRET_TOOL_ACCOUNT],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    return result.length > 0;
  } catch {
    return false;
  }
}

function detectLinux(): DetectClaudeAccountResult {
  // Prefer the file (canonical Claude CLI behavior). Fall back to libsecret
  // (Bug #4) — some Claude CLI installs store creds exclusively in the
  // GNOME keyring / kwallet via secret-tool.
  if (existsSync(CLAUDE_CONFIG_FILE_LINUX)) {
    const userConfig = readClaudeUserConfig();
    return {
      available: true,
      email: userConfig.email,
      displayName: userConfig.email ?? userConfig.userID ?? 'Claude Code',
      sourcePath: fileUri(CLAUDE_CONFIG_FILE_LINUX),
    };
  }

  if (probeLinuxSecretService()) {
    const userConfig = readClaudeUserConfig();
    return {
      available: true,
      email: userConfig.email,
      displayName: userConfig.email ?? userConfig.userID ?? 'Claude Code',
      sourcePath: secretToolUri(LINUX_SECRET_TOOL_SERVICE, LINUX_SECRET_TOOL_ACCOUNT),
    };
  }

  return {
    available: false,
    hint: 'No Claude Code login found at ~/.claude/.credentials.json or in the GNOME keyring. Run `claude auth login` and try again.',
  };
}

function detectWindows(): DetectClaudeAccountResult {
  // Windows passthrough is deferred per W6 — the renderer shouldn't even show the
  // Connect CTA on win32. We surface a clear hint here in case the router is
  // called directly (e.g. from a debug command).
  if (existsSync(CLAUDE_CONFIG_FILE_WINDOWS)) {
    return {
      available: false,
      hint: 'Claude passthrough on Windows is not supported yet. Use an API key instead.',
    };
  }
  return {
    available: false,
    hint: 'Claude passthrough on Windows is not supported yet. Use an API key instead.',
  };
}

/**
 * Public entrypoint. Synchronous — keychain probes are fast (<100ms each).
 */
export function detectClaudeAccount(): DetectClaudeAccountResult {
  try {
    if (process.platform === 'darwin') return detectMacOS();
    if (process.platform === 'linux') return detectLinux();
    if (process.platform === 'win32') return detectWindows();
    return {
      available: false,
      hint: `Unsupported platform: ${process.platform}.`,
    };
  } catch (error) {
    log.error('[detect] detectClaudeAccount failed:', sanitizeError(error));
    return {
      available: false,
      hint: 'Failed to read system credentials. See logs for details.',
    };
  }
}

/**
 * Strip token-like substrings out of an error before logging. Defense-in-depth —
 * keychain shell-outs may capture token text in stderr / messages on weird failures.
 */
export function sanitizeError(error: unknown): string {
  if (error == null) return '';
  let text: string;
  if (error instanceof Error) {
    text = error.message;
  } else if (typeof error === 'string') {
    text = error;
  } else {
    try {
      text = JSON.stringify(error);
    } catch {
      text = String(error);
    }
  }
  return scrubTokens(text);
}

/**
 * Replace anything that looks like a Claude OAuth or Anthropic API key with a marker.
 * Conservative: covers `sk-ant-...` (any variant) and the historical JSON envelope.
 */
function scrubTokens(input: string): string {
  return input
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, 'sk-ant-<redacted>')
    .replace(/"accessToken"\s*:\s*"[^"]+"/g, '"accessToken":"<redacted>"')
    .replace(/"refreshToken"\s*:\s*"[^"]+"/g, '"refreshToken":"<redacted>"');
}

// Re-exports needed by code that hasn't migrated yet.
export const _internal = {
  CLAUDE_KEYCHAIN_SERVICE_PREFIX,
  LEGACY_KEYCHAIN_SERVICE,
  CLAUDE_CONFIG_FILE_LINUX,
  CLAUDE_USER_CONFIG_FILE,
  darwinKeychainUri,
  fileUri,
  scrubTokens,
};
