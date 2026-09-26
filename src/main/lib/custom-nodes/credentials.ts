/**
 * Custom node credential management.
 *
 * Stores per-node credentials in the local SQLite `node_credentials` table.
 * All credentials are generic encrypted secrets injected as env vars at execution time.
 *
 * Env var injection:
 *   manifest.credentials[key].envVar or "{KEY_UPPER}" (e.g. "github" → "GITHUB")
 */

import { eq, sql } from 'drizzle-orm';
import log from 'electron-log';
import { decryptToken, encryptToken } from '../credentials';
import { getDatabase, nodeCredentials } from '../db';
import { createId } from '../db/utils';
import type { CustomNodeManifest, ManifestCredential } from './discovery';

type CredentialStatus = {
  key: string;
  label: string;
  configured: boolean;
};

type NodeCredentialRow = {
  id: string;
  nodeName: string;
  credentialKey: string;
  encryptedValue: string;
};

/** Return the env var name for a credential key + manifest entry. */
export function resolveCredentialEnvVar(key: string, cred: ManifestCredential): string {
  if (cred.envVar) return cred.envVar;
  return key.toUpperCase();
}

/** Get the status of all declared credentials for a node. */
export function getCredentialStatuses(
  nodeName: string,
  manifest: CustomNodeManifest,
): CredentialStatus[] {
  const db = getDatabase();
  const rows = db
    .select()
    .from(nodeCredentials)
    .where(eq(nodeCredentials.nodeName, nodeName))
    .all() as NodeCredentialRow[];

  const rowsByKey = new Map(rows.map((r) => [r.credentialKey, r]));

  return Object.entries(manifest.credentials).map(([key, cred]) => ({
    key,
    label: cred.label ?? key,
    configured: rowsByKey.has(key),
  }));
}

/**
 * Save (or update) a credential for a node.
 * Value is the raw secret — encrypted with safeStorage before storage.
 */
export function setCredential(nodeName: string, key: string, value: string): void {
  const db = getDatabase();
  const encrypted = encryptToken(value);

  db.insert(nodeCredentials)
    .values({
      id: createId(),
      nodeName,
      credentialKey: key,
      encryptedValue: encrypted,
    })
    .onConflictDoUpdate({
      target: [nodeCredentials.nodeName, nodeCredentials.credentialKey],
      set: { encryptedValue: encrypted },
    })
    .run();
}

/** Remove a credential for a node. */
export function clearCredential(nodeName: string, key: string): void {
  const db = getDatabase();
  db.delete(nodeCredentials)
    .where(
      sql`${nodeCredentials.nodeName} = ${nodeName} AND ${nodeCredentials.credentialKey} = ${key}`,
    )
    .run();
}

/** Remove all stored credentials for a node (e.g. when the node is deleted from disk and cloud). */
export function clearCredentialsForNode(nodeName: string): void {
  const db = getDatabase();
  db.delete(nodeCredentials).where(eq(nodeCredentials.nodeName, nodeName)).run();
}

/**
 * Resolve all credentials for a custom node into env var key-value pairs.
 * Used by the shell executor before spawning the child process.
 */
type ResolveCredentialsResult =
  | { ok: true; envVars: Record<string, string> }
  | { ok: false; missing: string[] };

export function resolveNodeCredentialEnvVars(
  manifest: CustomNodeManifest,
): ResolveCredentialsResult {
  const db = getDatabase();
  const missing: string[] = [];
  const envVars: Record<string, string> = {};

  for (const [key, cred] of Object.entries(manifest.credentials)) {
    const row = db
      .select()
      .from(nodeCredentials)
      .where(
        sql`${nodeCredentials.nodeName} = ${manifest.name} AND ${nodeCredentials.credentialKey} = ${key}`,
      )
      .get() as NodeCredentialRow | undefined;

    if (!row) {
      if (cred.required !== false) missing.push(key);
      continue;
    }

    const decrypted = decryptToken(row.encryptedValue);
    if (!decrypted) {
      log.warn(
        `[node-credentials] failed to decrypt credential "${key}" for node "${manifest.name}"`,
      );
      if (cred.required !== false) missing.push(key);
      continue;
    }

    const envVar = resolveCredentialEnvVar(key, cred);
    envVars[envVar] = decrypted;
  }

  if (missing.length > 0) {
    return { ok: false, missing };
  }
  return { ok: true, envVars };
}
