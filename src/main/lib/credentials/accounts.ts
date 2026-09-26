/**
 * Account credentials for local (trpc) and remote (socket/executor) execution: `api-key` rows
 * decrypt a stored token, passthrough rows resolve token-null. Why: decisions/claude-credential-ownership-at-spawn.
 */

import { desc, eq, inArray, sql } from 'drizzle-orm';
import log from 'electron-log';
import { isAnthropicApiKey } from '../../../shared/lib/anthropic-token';
import { readClaudeUserConfig } from './detect';
import { markRowNeedsReauth, markRowResolved } from './row-state';
import { withCredentialRowOperation } from '../integrations/connection-lifecycle-operation';
import { captureMainMessage } from '../sentry/init';
import { retireRetainedSessions } from '../socket/claude-session-registry';
import { probeClaudePassthroughSource, probeCodexPassthroughSource } from './source-readers';
import { claudeCodeCredentials, getDatabase } from '../db';
import type { AIAccountType, CredentialSource } from '../db/schema';

/**
 * The executor branches on `type`. Passthrough rows are token-null by design, so their gate is
 * `passthrough` rather than token presence (decisions/claude-credential-ownership-at-spawn).
 */
export type CredentialResult = {
  token: string | null;
  label: string | null;
  isApiKey: boolean;
  type: AIAccountType;
  /** The provider binary owns its credential store; a null token is expected, not a failure. */
  passthrough?: boolean;
  /** Claude passthrough: the live account and organization, which a Claude session keys on. */
  login?: string;
};

export const MAX_DESCRIPTION_ACCOUNT_ATTEMPTS = 3;
// Claude rows only: codex auth is machine-local, and resolution paths select codex explicitly
// via inArray.
const CLAUDE_TYPE_FILTER = sql`${claudeCodeCredentials.type} = 'claude-code'`;

/**
 * Ranks currently-resolvable rows first: passthrough without `needsReauthAt`, or api-key with a
 * token. Use as the first `desc()` in `.orderBy`, before `desc(connectedAt)`. Never for id lookups.
 */
export const RESOLVABLE_FIRST_RANK = sql`((${claudeCodeCredentials.source} IN ('claude-passthrough', 'codex-passthrough') AND ${claudeCodeCredentials.needsReauthAt} IS NULL) OR ${claudeCodeCredentials.oauthToken} IS NOT NULL)`;

const PASSTHROUGH_RANK = sql`(${claudeCodeCredentials.source} IN ('claude-passthrough', 'codex-passthrough'))`;

type CredentialRow = {
  id: string;
  type?: string | null;
  oauthToken: string | null;
  accountLabel: string | null;
  source: CredentialSource | string;
  sourcePath: string | null;
  expectedEmail: string | null;
  needsReauthAt: Date | null;
};

// Token crypto extracted to its own module (SIZE wall); re-exported so existing importers keep
// resolving from this path.
export { CredentialEncryptionUnavailableError, decryptToken, encryptToken } from './token-crypto';

import { decryptToken } from './token-crypto';

/**
 * Normalize row type for credentials (migration may leave type null)
 */
function accountType(cred: { type?: string | null } | undefined): AIAccountType {
  const t = cred?.type;
  if (t === 'claude-code' || t === 'codex') return t;
  return 'claude-code';
}

function emptyResult(type: AIAccountType = 'claude-code'): CredentialResult {
  return { token: null, label: null, isApiKey: false, type };
}

/**
 * Resolved = carries a token OR is passthrough. Both execution pre-flights (socket/executor and
 * task-executor) share this so they cannot drift on what counts as authenticated (decisions/claude-credential-ownership-at-spawn).
 */
export function isResolvedCredential(
  cred: Pick<CredentialResult, 'token' | 'passthrough'>,
): boolean {
  return !!cred.token || cred.passthrough === true;
}

/**
 * Redact for logs/Sentry: keep the first character and full domain (alice@example.com ->
 * a***@example.com), so drift stays distinguishable without writing the local-part to disk.
 */
function redactEmailForLog(email: string | null | undefined): string {
  if (!email) return '<none>';
  const at = email.indexOf('@');
  if (at <= 1) return email;
  return `${email[0]}***${email.slice(at)}`;
}

/** Injection seam (anti-slop forbids module mocking in tests); production keeps the default. */
export const passthroughDeps = {
  readLiveLogin: readClaudeUserConfig,
};

export function isPassthroughSource(source: string | null | undefined): boolean {
  return source === 'claude-passthrough' || source === 'codex-passthrough';
}

// `email` undefined = identity not observable without reading the secret (codex); keep the stored one.
type LiveLoginProbe =
  | { ok: true; email?: string | null; login?: string }
  | { ok: false; transient: boolean; detail: string };

/** Is the provider's own login present on this machine right now (presence only), and as whom? */
async function probeLiveLogin(row: CredentialRow): Promise<LiveLoginProbe> {
  if (row.source !== 'codex-passthrough' && !row.sourcePath) {
    return { ok: false, transient: false, detail: 'missing sourcePath' };
  }
  // Presence only, with no expiry check: the CLI refreshes its own keychain item under a
  // shared lock (decisions/claude-credential-ownership-at-spawn).
  const result =
    row.source === 'codex-passthrough'
      ? await probeCodexPassthroughSource()
      : await probeClaudePassthroughSource(row.sourcePath ?? '');
  if ('error' in result) {
    // 'denied' (locked keychain, TCC prompt, probe timeout) is transient, so persist nothing.
    // 'missing'/'malformed' means logged out: the flag gates the UI and self-clears on a good probe.
    return { ok: false, transient: result.error === 'denied', detail: result.error };
  }
  if (row.source === 'codex-passthrough') return { ok: true };
  // The login keys a retained Claude CLI (session-key): an organization switch keeps the email.
  const { email = null, accountUuid, organizationUuid } = passthroughDeps.readLiveLogin();
  return { ok: true, email, login: [accountUuid, organizationUuid].join('/') };
}

async function resolvePassthrough(
  row: CredentialRow,
  type: AIAccountType,
): Promise<CredentialResult> {
  const probe = await probeLiveLogin(row);
  if (!probe.ok) {
    if (probe.transient) {
      captureMainMessage('passthrough keychain probe denied or timed out', 'warning', {
        surface: 'credential-probe',
      });
    } else {
      const flagged = markRowNeedsReauth(row.id, `source probe: ${probe.detail}`);
      // Signed out just now: retire idle Claude CLIs of that login (an already-flagged row did).
      if (flagged && type === 'claude-code') retireRetainedSessions('credential-change');
    }
    return emptyResult(type);
  }

  // Identity drift: the live login changed since connect (or was never captured). Adopt it
  // instead of demanding a reauth — spawns already use the live login. Label stays untouched.
  const drifted = probe.email !== undefined && probe.email !== row.expectedEmail;
  if (drifted) {
    log.info(
      `[credentials] Adopted live login for row ${row.id}: ${redactEmailForLog(row.expectedEmail)} -> ${redactEmailForLog(probe.email)}`,
    );
    // Retire idle CLIs of the previous login. A read with no email is no evidence of a switch, but
    // it clears the stored one, so any known email that differs sweeps (stored none included).
    if (probe.email) retireRetainedSessions('credential-change');
  }
  markRowResolved(row.id, drifted ? probe.email : undefined);
  return {
    // Token-null on purpose: the executor pins CLAUDE_SECURESTORAGE_CONFIG_DIR='' so the CLI
    // reads the canonical keychain item and owns rotation (decisions/claude-credential-ownership-at-spawn).
    token: null,
    label: row.accountLabel || (type === 'codex' ? 'OpenAI' : 'Claude Code'),
    isApiKey: false,
    type,
    passthrough: true,
    login: probe.login,
  };
}

async function rowToCredentialResult(row: CredentialRow | undefined): Promise<CredentialResult> {
  if (!row) return emptyResult();

  const type = accountType(row);

  // Passthrough re-probes the live login every resolution, so a re-login heals a flagged row.
  if (isPassthroughSource(row.source)) {
    return withCredentialRowOperation(row.id, () => resolvePassthrough(row, type));
  }

  if (row.needsReauthAt) {
    return emptyResult(type);
  }

  // api-key path (also covers any unmigrated rows defaulting to api-key).
  if (!row.oauthToken) {
    return emptyResult(type);
  }
  const token = decryptToken(row.oauthToken);
  if (!token) {
    return emptyResult(type);
  }
  return {
    token,
    label: row.accountLabel || 'Default',
    isApiKey: isAnthropicApiKey(token),
    type,
  };
}

function selectColumns() {
  return {
    id: claudeCodeCredentials.id,
    type: claudeCodeCredentials.type,
    oauthToken: claudeCodeCredentials.oauthToken,
    accountLabel: claudeCodeCredentials.accountLabel,
    source: claudeCodeCredentials.source,
    sourcePath: claudeCodeCredentials.sourcePath,
    expectedEmail: claudeCodeCredentials.expectedEmail,
    needsReauthAt: claudeCodeCredentials.needsReauthAt,
  };
}

async function getBestCredentialForTypes(
  types: AIAccountType[],
  preferPassthrough = false,
): Promise<CredentialResult> {
  const db = getDatabase();
  // Filter from the caller's actual type list so any group resolves.
  const typeFilter = inArray(claudeCodeCredentials.type, types);

  const defaultRow = db
    .select(selectColumns())
    .from(claudeCodeCredentials)
    .where(sql`${claudeCodeCredentials.isDefault} = 1 AND ${typeFilter}`)
    .get();

  if (defaultRow) {
    return await rowToCredentialResult(defaultRow);
  }

  // Fallback order: passthrough-without-reauth first, then api-key rows with a token, by
  // recency — authenticated rows ahead of placeholder and needs-reauth ones.
  const fallbackRow = db
    .select(selectColumns())
    .from(claudeCodeCredentials)
    .where(typeFilter)
    .orderBy(
      desc(RESOLVABLE_FIRST_RANK),
      ...(preferPassthrough ? [desc(PASSTHROUGH_RANK)] : []),
      desc(claudeCodeCredentials.connectedAt),
    )
    .limit(1)
    .get();

  return await rowToCredentialResult(fallbackRow);
}

/**
 * Get the default Claude Code OAuth token from local SQLite.
 * Async because passthrough rows resolve from the keychain at use-time.
 */
export async function getDefaultClaudeCodeToken(): Promise<CredentialResult> {
  try {
    return await getBestCredentialForTypes(['claude-code', 'codex']);
  } catch (error) {
    log.error('[getDefaultClaudeCodeToken] Failed:', error);
    return emptyResult();
  }
}

/** One provider's credential, never the other provider's default. Without a default row, a
 * subscription (passthrough) row outranks a newer API-key row. */
export async function getDefaultCredentialForType(type: AIAccountType): Promise<CredentialResult> {
  try {
    return await getBestCredentialForTypes([type], true);
  } catch (error) {
    log.error('[getDefaultCredentialForType] Failed:', error);
    return emptyResult(type);
  }
}

/**
 * Resolve an AI credential by primary key, for project-specific account overrides. The type
 * predicate is load-bearing: this table also holds GitHub PAT rows.
 */
export async function getClaudeCodeTokenById(accountId: string): Promise<CredentialResult> {
  try {
    const db = getDatabase();
    const row = db
      .select(selectColumns())
      .from(claudeCodeCredentials)
      .where(
        sql`${claudeCodeCredentials.id} = ${accountId} AND ${inArray(claudeCodeCredentials.type, ['claude-code', 'codex'])}`,
      )
      .get();
    return await rowToCredentialResult(row);
  } catch (error) {
    log.error('[getClaudeCodeTokenById] Failed:', error);
    return emptyResult();
  }
}

/**
 * Description-generation credentials: default account first, then other authenticated accounts by
 * recency, capped at MAX_DESCRIPTION_ACCOUNT_ATTEMPTS. Async because passthrough reads the keychain.
 */
export async function getDescriptionCredentialAttempts(): Promise<CredentialResult[]> {
  try {
    const db = getDatabase();

    const defaultRow = db
      .select(selectColumns())
      .from(claudeCodeCredentials)
      .where(sql`${claudeCodeCredentials.isDefault} = 1 AND ${CLAUDE_TYPE_FILTER}`)
      .get();

    // Active = api-key with token OR passthrough without needsReauthAt.
    const activeRows = db
      .select(selectColumns())
      .from(claudeCodeCredentials)
      .where(sql`${RESOLVABLE_FIRST_RANK} AND ${CLAUDE_TYPE_FILTER}`)
      .orderBy(desc(claudeCodeCredentials.connectedAt))
      .all();

    const orderedRows = defaultRow ? [defaultRow, ...activeRows] : activeRows;
    const seen = new Set<string>();
    const attempts: CredentialResult[] = [];

    for (const row of orderedRows) {
      const dedupeKey = `${row.id}:${row.accountLabel ?? ''}:${row.type ?? ''}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      const result = await rowToCredentialResult(row);
      if (!isResolvedCredential(result)) continue;
      attempts.push(result);

      if (attempts.length >= MAX_DESCRIPTION_ACCOUNT_ATTEMPTS) break;
    }

    return attempts;
  } catch (error) {
    log.error('[getDescriptionCredentialAttempts] Failed:', error);
    return [];
  }
}

/**
 * Clear a stored OAuth token by label, on a 401. Passthrough rows set `needsReauthAt` instead,
 * since their oauth_token is already NULL.
 */
export function clearClaudeCodeTokenByLabel(accountLabel: string): void {
  try {
    const db = getDatabase();
    // Look up source so we know whether to clear the token or set needsReauthAt.
    const row = db
      .select({ id: claudeCodeCredentials.id, source: claudeCodeCredentials.source })
      .from(claudeCodeCredentials)
      .where(sql`${claudeCodeCredentials.accountLabel} = ${accountLabel} AND ${CLAUDE_TYPE_FILTER}`)
      .get();
    if (!row) return;
    if (row.source === 'claude-passthrough') {
      // Under the row lock so an in-flight successful probe cannot clear this newer failure.
      void withCredentialRowOperation(row.id, async () =>
        markRowNeedsReauth(row.id, 'API returned 401'),
      );
    } else {
      db.update(claudeCodeCredentials)
        .set({ oauthToken: null })
        .where(eq(claudeCodeCredentials.id, row.id))
        .run();
    }
  } catch (error) {
    log.error('[clearClaudeCodeTokenByLabel] Failed:', error);
  }
}
