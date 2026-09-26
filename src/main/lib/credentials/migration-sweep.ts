/**
 * One-shot startup sweep for the claude-passthrough migration (plan: schema + migration-sweep).
 *
 * Runs AFTER Drizzle migrate / `ensureCredentialSourceColumns`, BEFORE the tRPC server
 * starts accepting requests. Safe to call on every launch — guarded by user_version.
 *
 * Goal: cleanly differentiate API-key rows from legacy OAuth-snapshot rows that the old
 * `importSystemToken` flow produced. Pre-launch (0.0.x) we have no production users, so
 * legacy snapshot rows are deleted (devs reconnect via the new passthrough flow).
 *
 * Safety rules:
 * - If `safeStorage.isEncryptionAvailable() === false` → ABORT entire sweep + log.
 *   (On Linux without keyring, every decrypt would fail and we'd wipe everything.)
 * - On per-row decrypt failure → KEEP row untouched (user moved app, signing changed).
 * - Only DELETE when the decrypted token classifies as a Claude OAuth token.
 *   Unknown shapes (proxy, OpenRouter, custom) get `source='api-key'`.
 * - Before any DELETE, write encrypted bytes (untouched) to a JSON backup in userData.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app, safeStorage } from 'electron';
import log from 'electron-log';
import { isClaudeOAuthToken } from '../../../shared/lib/anthropic-token';
import type { NodeSqliteDatabase } from '../db/node-sqlite-driver';
import { ensureDirExists } from '../fs-helpers';

const SWEEP_USER_VERSION = 2;

type CredentialRow = {
  id: string;
  type: string | null;
  account_label: string | null;
  oauth_token: string | null;
  source: string;
};

/**
 * Classify a decrypted token. Pure function — exported for testing.
 *
 * - `legacy-oauth-snapshot`: a Claude Code OAuth access token (`sk-ant-oat*`) OR a JSON
 *   blob with `claudeAiOauth.accessToken` (the historical importSystemToken shape).
 * - `api-key`: anything else, including:
 *   - Anthropic API keys (`sk-ant-api*`)
 *   - OpenRouter keys (`sk-or-v1-*`)
 *   - Proxy / custom keys we don't recognize
 *   - Garbage that decrypted "successfully" but isn't really a token
 *
 * Defaulting unknowns to `api-key` is the safe choice — the alternative is destroying
 * a working credential we don't have a regex for.
 */
export function classifyDecryptedToken(token: string): 'legacy-oauth-snapshot' | 'api-key' {
  const trimmed = token.trim();
  if (!trimmed) return 'api-key';

  if (isClaudeOAuthToken(trimmed)) {
    return 'legacy-oauth-snapshot';
  }

  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as { claudeAiOauth?: { accessToken?: string } };
      if (parsed?.claudeAiOauth?.accessToken) {
        return 'legacy-oauth-snapshot';
      }
    } catch {
      // Not JSON — fall through.
    }
  }

  return 'api-key';
}

/**
 * Pure planning logic — exported for testing.
 *
 * Given the rows enumerated from `claude_code_credentials` AND a decrypt
 * function, decide which rows to DELETE (legacy OAuth snapshots) vs which to
 * UPDATE to `source='api-key'`.
 *
 * Hard rules (never violated):
 * - `type='github'` rows are skipped entirely (managed elsewhere).
 * - Decrypt failures KEEP the row untouched (signing change / app moved).
 */
export function planSweep(
  rows: ReadonlyArray<CredentialRow>,
  decrypt: (encrypted: string) => string | null,
): {
  toDelete: CredentialRow[];
  toMarkApiKey: CredentialRow[];
  rowsKeptOnDecryptError: number;
} {
  const toDelete: CredentialRow[] = [];
  const toMarkApiKey: CredentialRow[] = [];
  let rowsKeptOnDecryptError = 0;

  for (const row of rows) {
    if (!row.oauth_token) continue;

    const decrypted = decrypt(row.oauth_token);
    if (!decrypted) {
      rowsKeptOnDecryptError++;
      continue;
    }

    if (row.type === 'github') {
      if (row.source !== 'api-key') {
        toMarkApiKey.push(row);
      }
      continue;
    }

    const classification = classifyDecryptedToken(decrypted);
    if (classification === 'legacy-oauth-snapshot') {
      toDelete.push(row);
    } else if (row.source !== 'api-key') {
      toMarkApiKey.push(row);
    }
  }

  return { toDelete, toMarkApiKey, rowsKeptOnDecryptError };
}

type SweepBackupRow = {
  id: string;
  type: string | null;
  account_label: string | null;
  encrypted_oauth_token_base64: string;
};

function writeBackup(rows: SweepBackupRow[]): string | null {
  if (rows.length === 0) return null;
  try {
    const userData = app.getPath('userData');
    const backupsDir = join(userData, 'backups');
    ensureDirExists(backupsDir);
    const filename = `credentials-pre-sweep-${Date.now()}.json`;
    const fullPath = join(backupsDir, filename);
    const payload = {
      schemaVersion: 1,
      writtenAt: new Date().toISOString(),
      note: 'Encrypted oauth_token bytes for rows that the credential-source migration sweep classified as legacy OAuth snapshots and removed from the active table. Restore by re-inserting rows with these encrypted blobs.',
      rows,
    };
    writeFileSync(fullPath, JSON.stringify(payload, null, 2), { mode: 0o600 });
    return fullPath;
  } catch (error) {
    log.error('[migration-sweep] Failed to write backup:', error);
    return null;
  }
}

type SweepResult = {
  status: 'completed' | 'aborted-no-encryption' | 'aborted-error' | 'skipped-already-ran';
  rowsInspected: number;
  rowsDeleted: number;
  rowsClassifiedApiKey: number;
  rowsKeptOnDecryptError: number;
  backupPath: string | null;
  reason?: string;
};

/**
 * Run the credential migration sweep on the given SQLite database.
 *
 * Idempotent — guarded by `PRAGMA user_version`. On second launch this returns
 * `skipped-already-ran` without inspecting any rows.
 *
 * Tracked user_version values:
 *   1 = git_remote_url canonical normalization (see db/index.ts)
 *   2 = credential-source migration sweep (this function)
 */
export function runCredentialMigrationSweep(dbInstance: NodeSqliteDatabase): SweepResult {
  const currentVersion = (dbInstance.pragma('user_version', { simple: true }) as number) ?? 0;
  if (currentVersion >= SWEEP_USER_VERSION) {
    return {
      status: 'skipped-already-ran',
      rowsInspected: 0,
      rowsDeleted: 0,
      rowsClassifiedApiKey: 0,
      rowsKeptOnDecryptError: 0,
      backupPath: null,
    };
  }

  if (!safeStorage.isEncryptionAvailable()) {
    log.warn(
      '[migration-sweep] safeStorage encryption unavailable — aborting sweep to avoid wiping every row. Will retry on next launch.',
    );
    return {
      status: 'aborted-no-encryption',
      rowsInspected: 0,
      rowsDeleted: 0,
      rowsClassifiedApiKey: 0,
      rowsKeptOnDecryptError: 0,
      backupPath: null,
      reason: 'safeStorage.isEncryptionAvailable() === false',
    };
  }

  let rows: CredentialRow[] = [];
  try {
    rows = dbInstance
      .prepare(
        'SELECT id, type, account_label, oauth_token, source FROM claude_code_credentials WHERE oauth_token IS NOT NULL',
      )
      .all() as CredentialRow[];
  } catch (error) {
    log.error('[migration-sweep] Failed to enumerate credentials:', error);
    return {
      status: 'aborted-error',
      rowsInspected: 0,
      rowsDeleted: 0,
      rowsClassifiedApiKey: 0,
      rowsKeptOnDecryptError: 0,
      backupPath: null,
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  const plan = planSweep(rows, (encrypted) => {
    try {
      const buffer = Buffer.from(encrypted, 'base64');
      return safeStorage.decryptString(buffer);
    } catch (error) {
      log.warn(
        `[migration-sweep] Decrypt failed; keeping row untouched.`,
        error instanceof Error ? error.message : 'unknown',
      );
      return null;
    }
  });
  const { toDelete, toMarkApiKey, rowsKeptOnDecryptError } = plan;

  let backupPath: string | null = null;
  if (toDelete.length > 0) {
    backupPath = writeBackup(
      toDelete.map((r) => ({
        id: r.id,
        type: r.type,
        account_label: r.account_label,
        encrypted_oauth_token_base64: r.oauth_token ?? '',
      })),
    );
    if (!backupPath) {
      log.error(
        '[migration-sweep] Backup write failed — aborting DELETEs to avoid irreversible data loss. Will retry on next launch.',
      );
      return {
        status: 'aborted-error',
        rowsInspected: rows.length,
        rowsDeleted: 0,
        rowsClassifiedApiKey: 0,
        rowsKeptOnDecryptError,
        backupPath: null,
        reason: 'backup-write-failed',
      };
    }
  }

  // Apply the classification in one transaction so a partial sweep cannot leave the rows split
  // between the old and new shape.
  const deleteStmt = dbInstance.prepare('DELETE FROM claude_code_credentials WHERE id = ?');
  const updateStmt = dbInstance.prepare(
    "UPDATE claude_code_credentials SET source = 'api-key' WHERE id = ?",
  );
  const txn = dbInstance.transaction(() => {
    for (const row of toDelete) {
      deleteStmt.run(row.id);
    }
    for (const row of toMarkApiKey) {
      updateStmt.run(row.id);
    }
    dbInstance.pragma(`user_version = ${SWEEP_USER_VERSION}`);
  });

  try {
    txn();
  } catch (error) {
    log.error('[migration-sweep] Transaction failed:', error);
    return {
      status: 'aborted-error',
      rowsInspected: rows.length,
      rowsDeleted: 0,
      rowsClassifiedApiKey: 0,
      rowsKeptOnDecryptError,
      backupPath,
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  log.info(
    `[migration-sweep] Completed. Inspected=${rows.length} deleted=${toDelete.length} markedApiKey=${toMarkApiKey.length} keptOnDecryptError=${rowsKeptOnDecryptError} backup=${backupPath ?? 'none'}`,
  );

  return {
    status: 'completed',
    rowsInspected: rows.length,
    rowsDeleted: toDelete.length,
    rowsClassifiedApiKey: toMarkApiKey.length,
    rowsKeptOnDecryptError,
    backupPath,
  };
}
