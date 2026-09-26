/**
 * Detect an existing OpenAI Codex login on this machine.
 *
 * Codex auth is PASSTHROUGH: the `codex` CLI owns the credential (written by
 * `codex login`) under $CODEX_HOME (defaults to ~/.codex). Frink NEVER stores an
 * OpenAI key and NEVER overrides CODEX_HOME (that would break the binary's auth).
 * This module reads identity metadata ONLY — never the token — so the UI can show
 * "Connected to {email}". Token-less by design: the codex runner relies on the
 * binary's own auth at spawn, so there is no Frink token to resolve.
 *
 * Two storage backends, mirrored from
 * cloned-projects/codex/codex-rs/login/src/auth/storage.rs:
 *   - file:    $CODEX_HOME/auth.json (mode 0o600)
 *   - keyring: macOS Keychain generic-password — service "Codex Auth",
 *              account `cli|<sha256(canonical CODEX_HOME)[:16]>`.
 * `auto` (codex default) prefers keyring, else file. We read the file when present
 * and probe the keychain on macOS as a fallback.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import log from 'electron-log';
import { sanitizeError } from './detect';
import { KEYCHAIN_READ_TIMEOUT_MS } from './keychain-shared';

export const CODEX_KEYCHAIN_SERVICE = 'Codex Auth';

export type DetectCodexAccountResult = {
  /** True when the `codex` CLI has an authed identity on this machine. */
  available: boolean;
  /** "you@example.com" from the OAuth id_token, when present. */
  email?: string;
  /** Friendly identifier for UI. */
  displayName?: string;
  /** Informational marker — codex owns its own auth, Frink resolves no token. */
  sourcePath?: string;
  /** Short user-facing reason when `available === false`. Never contains tokens. */
  hint?: string;
};

/** $CODEX_HOME or ~/.codex (per codex-rs `find_codex_home`). Never overridden. */
export function resolveCodexHome(): string {
  const fromEnv = process.env.CODEX_HOME?.trim();
  return fromEnv || join(homedir(), '.codex');
}

/**
 * Stable keyring account key the `codex` CLI derives from CODEX_HOME:
 * `cli|<first-16-hex-of-sha256(canonical-path)>`. Mirrors
 * `login/src/auth/storage.rs::compute_store_key`. We can't canonicalize a path
 * that may not exist, so we hash the resolved absolute path — codex falls back to
 * the same un-canonicalized path on its `unwrap_or_else` branch.
 */
export function codexKeyringAccount(codexHome: string): string {
  const digest = createHash('sha256').update(codexHome).digest('hex');
  return `cli|${digest.slice(0, 16)}`;
}

/**
 * Pull the email claim out of an OAuth id_token JWT without verifying the
 * signature (we only need an identity label, not trust). Mirrors codex-rs
 * `token_data.rs::parse_chatgpt_jwt_claims`: email is top-level or under the
 * `https://api.openai.com/profile` claim. Returns undefined on any malformed input.
 */
export function emailFromIdToken(idToken: unknown): string | undefined {
  if (typeof idToken !== 'string') return undefined;
  const payload = idToken.split('.')[1];
  if (!payload) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8')) as {
      email?: unknown;
      'https://api.openai.com/profile'?: { email?: unknown };
    };
    const email = claims.email ?? claims['https://api.openai.com/profile']?.email;
    return typeof email === 'string' ? email : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Parse a serialized `auth.json` (or keyring blob) into identity metadata.
 * `tokens.id_token` is the raw JWT; `OPENAI_API_KEY` marks key-based auth.
 * Returns null when the blob carries no usable credential.
 */
export function parseCodexAuthBlob(raw: string): { email?: string; apiKey: boolean } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let parsed: { tokens?: { id_token?: unknown }; OPENAI_API_KEY?: unknown };
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const email = emailFromIdToken(parsed.tokens?.id_token);
  const hasTokens = !!parsed.tokens;
  const apiKey = typeof parsed.OPENAI_API_KEY === 'string' && parsed.OPENAI_API_KEY.length > 0;
  if (!hasTokens && !apiKey) return null;
  return { email, apiKey };
}

/** Probe the macOS "Codex Auth" keychain entry (keyring backend). */
function readCodexMacOSKeychain(codexHome: string): string | null {
  try {
    return execFileSync(
      'security',
      [
        'find-generic-password',
        '-s',
        CODEX_KEYCHAIN_SERVICE,
        '-a',
        codexKeyringAccount(codexHome),
        '-w',
      ],
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: KEYCHAIN_READ_TIMEOUT_MS },
    ).trim();
  } catch {
    return null;
  }
}

/**
 * Public entrypoint. Synchronous to match {@link detectClaudeAccount}.
 */
export function detectCodexAccount(): DetectCodexAccountResult {
  try {
    const codexHome = resolveCodexHome();
    const authFile = join(codexHome, 'auth.json');

    let blob: string | null = null;
    if (existsSync(authFile)) {
      blob = readFileSync(authFile, 'utf-8');
    } else if (process.platform === 'darwin') {
      blob = readCodexMacOSKeychain(codexHome);
    }

    if (!blob) {
      return {
        available: false,
        hint: 'No Codex login found. Run `codex login` and try again.',
      };
    }

    const parsed = parseCodexAuthBlob(blob);
    if (!parsed) {
      return {
        available: false,
        hint: 'Codex credentials are present but unreadable. Re-run `codex login`.',
      };
    }

    return {
      available: true,
      email: parsed.email,
      displayName: parsed.email ?? (parsed.apiKey ? 'OpenAI (API key)' : 'OpenAI'),
      sourcePath: 'codex-passthrough://local',
    };
  } catch (error) {
    log.error('[detect-codex] detectCodexAccount failed:', sanitizeError(error));
    return {
      available: false,
      hint: 'Failed to read Codex credentials. See logs for details.',
    };
  }
}
