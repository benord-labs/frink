/**
 * Token encryption at rest via Electron's safeStorage (OS keyring). Extracted from
 * credentials.ts — shared by account storage, integrations token-storage, and custom-node
 * credentials.
 */

import { safeStorage } from 'electron';

/**
 * Thrown by `encryptToken` when the OS keyring isn't available (most often on
 * a headless Linux system without `gnome-keyring` / `kwallet` running). Callers
 * MUST catch this and surface a clear UX error rather than silently writing
 * plaintext API keys to SQLite (the prior fallback left keys at-rest in cleartext).
 */
export class CredentialEncryptionUnavailableError extends Error {
  constructor() {
    super(
      'Cannot store API key: the OS keyring is not available on this machine. On Linux, install gnome-keyring (or kwallet) and re-launch Frink. On macOS/Windows this should never occur — please file a bug.',
    );
    this.name = 'CredentialEncryptionUnavailableError';
  }
}

/**
 * Encrypt token using Electron's safeStorage. Throws
 * `CredentialEncryptionUnavailableError` when the OS keyring is missing —
 * callers (`addAccount`, `updateAccountToken`, etc.) must surface this as a
 * user-facing error instead of writing plaintext.
 */
export function encryptToken(token: string): string {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new CredentialEncryptionUnavailableError();
  }
  return safeStorage.encryptString(token).toString('base64');
}

/**
 * Decrypt token using Electron's safeStorage. The no-keyring branch falls back to base64
 * decoding so rows written before the keyring hardening keep resolving (`encryptToken` no
 * longer creates such rows — re-add accounts after installing a keyring to re-encrypt).
 */
export function decryptToken(encrypted: string | null | undefined): string | null {
  if (!encrypted) return null;
  if (!safeStorage.isEncryptionAvailable()) {
    return Buffer.from(encrypted, 'base64').toString('utf-8');
  }
  const buffer = Buffer.from(encrypted, 'base64');
  return safeStorage.decryptString(buffer);
}
