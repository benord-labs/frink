/* eslint-disable max-lines, max-lines-per-function */
import os from 'node:os';
import path from 'node:path';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { LAUNCH_FLAGS } from '../../../../shared/launch-flags';
import {
  AI_PROVIDER_IDS,
  aiProvider,
  PASSTHROUGH_SOURCES,
  selectableProviderIds,
} from '../../../../shared/lib/ai-providers';
import { isAnthropicApiKey } from '../../../../shared/lib/anthropic-token';
import { trackAccountConnect, trackDetectionFailure } from '../../analytics';
import { getClaudeShellEnvironment } from '../../claude';
import { ensureLoginShellEnv } from '../../platform/login-shell-env';
import { runClaudeOAuthBrowser } from '../../claude-oauth-browser';
import {
  decryptToken,
  encryptToken,
  getClaudeCodeTokenById,
  isPassthroughSource,
  RESOLVABLE_FIRST_RANK,
} from '../../credentials';
import { detectClaudeAccount } from '../../credentials/detect';
import { ALLOWED_SOURCE_PATH_SCHEMES } from '../../credentials/source-readers';
import {
  type AIAccountType,
  type CredentialSource,
  claudeCodeCredentials,
  getDatabase,
} from '../../db';
import { getChatById } from '../../db/repos/chats';
import {
  getChatAiAccount,
  getProjectAiAccount as getProjectAiAccountLocal,
  setProjectAiAccount as setProjectAiAccountLocal,
} from '../../db/repos/project-ai-accounts';
import { createId } from '../../db/utils';
import { retireRetainedSessions } from '../../socket/claude-session-registry';
import { publicProcedure, router } from '../index';

/**
 * Thin wrappers around the local project↔account repos to keep call-site syntax
 * unchanged after the project localization migration. Each wrapper binds
 * `db = getDatabase()` so callers can keep passing the original `(projectId, ...)`
 * argument lists (the local repos take `db` as their first parameter).
 */
const getProjectAiAccount = (projectId: string) =>
  getProjectAiAccountLocal(getDatabase(), projectId);
const setProjectAiAccount = (projectId: string, accountId: string | null) =>
  setProjectAiAccountLocal(getDatabase(), projectId, accountId);

// Claude account operations: cloud-sync reconciliation, token upsert, and manual-add
// label-collision guards. EXCLUDES codex by design — a codex passthrough row is machine-local
// (never synced to Neon) and must never be token-clobbered by a same-label manual add.
const CLAUDE_ACCOUNT_SCOPE = sql`(${claudeCodeCredentials.type} = 'claude-code' OR ${claudeCodeCredentials.type} IS NULL)`;

// Local default/existence management across ALL local providers INCLUDING codex. Used for
// first-account checks + default clearing/promotion so exactly one row stays isDefault=1 — e.g.
// connecting a claude account after a default codex must clear the codex default.
const LOCAL_DEFAULT_ACCOUNT_SCOPE = sql`(${inArray(claudeCodeCredentials.type, AI_PROVIDER_IDS)} OR ${claudeCodeCredentials.type} IS NULL)`;

// Account types selectable in the UI (each behind its launch flag). Hiding is selection-only:
// write/sync/dedup keep seeing hidden rows, so one can't be duplicated on sync.
const SELECTABLE_ACCOUNT_TYPES = selectableProviderIds(LAUNCH_FLAGS, process.platform);
const SELECTABLE_ACCOUNT_TYPE_SCOPE = inArray(claudeCodeCredentials.type, SELECTABLE_ACCOUNT_TYPES);
// Legacy NULL rows pre-date type-tagging and mean 'claude-code'.
const SELECTABLE_ACCOUNT_TYPE_SCOPE_WITH_NULL = sql`(${SELECTABLE_ACCOUNT_TYPE_SCOPE} OR ${claudeCodeCredentials.type} IS NULL)`;

// Among unresolvable candidates prefer a passthrough row: getResolvedAccount heals it by re-probing.
const HEALABLE_NEXT_RANK = inArray(claudeCodeCredentials.source, PASSTHROUGH_SOURCES);

/**
 * Authenticated when an api-key row has a non-null encrypted oauth_token, OR a passthrough row
 * (claude OR codex) has `needsReauthAt IS NULL`. Passthrough rows carry oauth_token = NULL by
 * design (claude resolves from the keychain, codex from the binary's own ~/.codex auth) — without
 * this distinction they'd always read "unauthenticated" and the empty-state would never clear.
 */
function isAccountAuthenticated(
  row:
    | { source?: string | null; oauthToken?: string | null; needsReauthAt?: Date | null }
    | undefined,
): boolean {
  if (!row) return false;
  if (isPassthroughSource(row.source)) {
    return !row.needsReauthAt;
  }
  return !!row.oauthToken;
}

/**
 * A flagged passthrough row may have been healed outside frink (the user simply logged back
 * into `claude` / `codex`). This selection read gates the composer, so it doubles as the reliable
 * recovery trigger: probe once (the resolution path self-heals on success) and re-read.
 */
async function reprobeFlaggedPassthrough<
  T extends { id: string; source?: string | null; needsReauthAt?: Date | null },
>(row: T | undefined): Promise<T | undefined> {
  if (!row?.needsReauthAt || !isPassthroughSource(row.source)) return row;
  await getClaudeCodeTokenById(row.id);
  // SAFETY: same table and primary key as the caller's snapshot; only nullable column values differ.
  const fresh = getDatabase()
    .select()
    .from(claudeCodeCredentials)
    .where(eq(claudeCodeCredentials.id, row.id))
    .get() as T | undefined;
  // No fallback to the stale snapshot: undefined means the row was deleted mid-probe.
  return fresh;
}

/** A login as the account surfaces show it (null if hidden); `isBlocked` marks a removed login. */
function toResolvedAccount(
  row: typeof claudeCodeCredentials.$inferSelect,
  flags: { isProjectOverride: boolean; isBlocked: boolean; projectId: string | null },
) {
  const provider = aiProvider(row.type);
  if (!provider) return null;
  return {
    id: row.id,
    label: row.accountLabel || provider.name,
    type: provider.id,
    isAuthenticated: isAccountAuthenticated(row),
    source: row.source ?? null,
    sourcePath: row.sourcePath ?? null,
    needsReauthAt: row.needsReauthAt?.toISOString() ?? null,
    expectedEmail: row.expectedEmail ?? null,
    ...flags,
  };
}

function clearLocalAccountDefaults(): void {
  getDatabase()
    .update(claudeCodeCredentials)
    .set({ isDefault: false })
    .where(LOCAL_DEFAULT_ACCOUNT_SCOPE)
    .run();
}

function persistLocalAccountToken(accountId: string, token: string): void {
  const db = getDatabase();
  db.update(claudeCodeCredentials)
    .set({
      oauthToken: encryptToken(token),
      connectedAt: new Date(),
    })
    .where(eq(claudeCodeCredentials.id, accountId))
    .run();
  retireRetainedSessions('credential-change');
}

// ============ LOCAL STORAGE ============

/**
 * If the deleted account was the default, promote another account to default.
 */
function promoteNextDefaultAccount(wasDefault: boolean | null | undefined): void {
  if (!wasDefault) return;
  const db = getDatabase();
  const remaining = db
    .select()
    .from(claudeCodeCredentials)
    .where(LOCAL_DEFAULT_ACCOUNT_SCOPE)
    .orderBy(
      desc(sql`(${claudeCodeCredentials.oauthToken} IS NOT NULL)`),
      desc(claudeCodeCredentials.connectedAt),
    )
    .limit(1)
    .get();
  if (remaining) {
    db.update(claudeCodeCredentials)
      .set({ isDefault: true })
      .where(eq(claudeCodeCredentials.id, remaining.id))
      .run();
  }
}

/**
 * Upsert an account by label: update token if exists, create new otherwise.
 * Returns the account ID (existing or new) and whether it was newly created.
 */
function upsertAccountByLabel(label: string, token: string): { id: string; isNew: boolean } {
  const db = getDatabase();
  const existing = db
    .select()
    .from(claudeCodeCredentials)
    .where(and(eq(claudeCodeCredentials.accountLabel, label), CLAUDE_ACCOUNT_SCOPE))
    .get();

  if (existing) {
    persistLocalAccountToken(existing.id, token);
    return { id: existing.id, isNew: false };
  }

  const firstAccount = db
    .select()
    .from(claudeCodeCredentials)
    .where(LOCAL_DEFAULT_ACCOUNT_SCOPE)
    .limit(1)
    .get();
  const isFirstAccount = !firstAccount;
  const newId = storeAccountToken(label, token, isFirstAccount);
  return { id: newId, isNew: true };
}

type TokenValidationResult = { valid: boolean; error?: string };

/** Validate and throw if invalid — shared guard for mutations. */
async function assertValidAccountToken(token: string): Promise<void> {
  const result = await validateAnthropicToken(token);
  if (!result.valid) {
    throw new Error(result.error ?? 'Invalid token');
  }
}

/** Validate any Anthropic token (API key or OAuth) via the /v1/models endpoint. */
async function validateAnthropicToken(token: string): Promise<TokenValidationResult> {
  const isApiKey = isAnthropicApiKey(token);
  const headers: Record<string, string> = { 'anthropic-version': '2023-06-01' };

  if (isApiKey) {
    headers['x-api-key'] = token;
  } else {
    headers.Authorization = `Bearer ${token}`;
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/models', {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(10_000),
    });

    const body = response.ok ? '' : await response.text().catch(() => '');

    if (response.ok) return { valid: true };
    // /v1/models does not support OAuth; 401 with this message means the token is OAuth and valid for CLI/import
    if (
      response.status === 401 &&
      body.includes('OAuth authentication is currently not supported')
    ) {
      return { valid: true };
    }
    if (response.status === 401) return { valid: false, error: 'Invalid API key or token' };
    if (response.status === 403) return { valid: false, error: 'Token does not have permission' };
    return { valid: false, error: `Validation failed (HTTP ${response.status})` };
  } catch {
    return { valid: false, error: 'Could not reach Anthropic API — check your network' };
  }
}

/**
 * Store token for a new account
 */
function storeAccountToken(
  accountLabel: string,
  oauthToken: string,
  isDefault: boolean = false,
  type: AIAccountType = 'claude-code',
) {
  const db = getDatabase();

  const encryptedToken = encryptToken(oauthToken);

  if (isDefault) {
    clearLocalAccountDefaults();
  }

  const newId = createId();
  db.insert(claudeCodeCredentials)
    .values({
      id: newId,
      type,
      accountLabel,
      oauthToken: encryptedToken,
      connectedAt: new Date(),
      isDefault,
    })
    .run();

  return newId;
}

/**
 * Claude Code OAuth router for desktop
 * Uses server only for sandbox creation, stores token locally
 */
export const claudeCodeRouter = router({
  /**
   * Check if user has existing CLI config (API key or proxy)
   * If true, user can skip OAuth onboarding
   * Based on PR #29 by @sa4hnd
   */
  hasExistingCliConfig: publicProcedure.query(async () => {
    const shellEnv = await ensureLoginShellEnv().then(getClaudeShellEnvironment); // profile keys
    return {
      hasConfig: !!(shellEnv.ANTHROPIC_API_KEY || shellEnv.ANTHROPIC_BASE_URL),
      hasApiKey: !!shellEnv.ANTHROPIC_API_KEY,
      baseUrl: shellEnv.ANTHROPIC_BASE_URL || null,
    };
  }),

  /**
   * Check if user has any Claude Code account connected (local check)
   */
  getIntegration: publicProcedure.query(() => {
    const db = getDatabase();
    // Check for any authenticated account (prefer default)
    const defaultAccount = db
      .select()
      .from(claudeCodeCredentials)
      .where(sql`${claudeCodeCredentials.isDefault} = 1 AND ${SELECTABLE_ACCOUNT_TYPE_SCOPE}`)
      .get();

    const anyAccount =
      defaultAccount ??
      db
        .select()
        .from(claudeCodeCredentials)
        .where(sql`${SELECTABLE_ACCOUNT_TYPE_SCOPE}`)
        .limit(1)
        .get();

    return {
      // Passthrough rows (claude + codex) carry oauth_token = NULL by design — gate on the
      // shared auth helper, not token presence, else a connected passthrough user reads disconnected.
      isConnected: isAccountAuthenticated(anyAccount),
      connectedAt: anyAccount?.connectedAt?.toISOString() ?? null,
    };
  }),

  /**
   * Start browser-based OAuth flow for Claude/Anthropic
   * Opens the browser to authenticate and handles the callback
   */
  startLocalAuth: publicProcedure
    .input(z.object({ accountLabel: z.string().min(1) }))
    .mutation(async ({ input }) => {
      let capturedAuthUrl: string | undefined;

      const result = await runClaudeOAuthBrowser((_status, authUrl) => {
        // Capture the auth URL when it becomes available
        if (authUrl) {
          capturedAuthUrl = authUrl;
        }
      });

      if (!result.success || !result.token) {
        // Include the auth URL in the error so frontend can display it as fallback
        const errorMessage = result.error || 'Authentication failed';
        const authUrl = result.authUrl || capturedAuthUrl;
        throw new Error(authUrl ? `${errorMessage}|AUTH_URL:${authUrl}` : errorMessage);
      }

      // Store the token with the provided label
      storeAccountToken(input.accountLabel, result.token);

      return { success: true };
    }),

  /**
   * Import an OAuth token with a label (upserts - updates if exists, creates if not)
   */
  importToken: publicProcedure
    .input(
      z.object({
        token: z.string().min(1),
        accountLabel: z.string().min(1),
      }),
    )
    .mutation(async ({ input }) => {
      const trimmedToken = input.token.trim();

      // Validate token before storing
      await assertValidAccountToken(trimmedToken);

      upsertAccountByLabel(input.accountLabel, trimmedToken);

      return { success: true };
    }),

  /**
   * Detect a usable Claude Code login on this machine without retaining the token.
   * Triggers the macOS TCC keychain prompt the first time it runs — deliberately, so the
   * access decision happens here rather than inside a spawned agent.
   * Resolves to the canonical login-scoped entry or nothing; there is no picker, because
   * the spawned CLI can only read that one entry.
   */
  detectClaudeAccount: publicProcedure.query(async () => {
    const detection = detectClaudeAccount();
    trackDetectionFailure('claude-code', detection.failure);
    return detection;
  }),

  /**
   * Create or update the single Claude passthrough row for this machine.
   *
   * - Stores `oauth_token = NULL`, `source = 'claude-passthrough'`, `sourcePath`,
   *   `expectedEmail` (for identity-drift checks at chat-time).
   * - Rejects when a passthrough row already exists with a different `sourcePath`
   *   on this machine — caller must `disconnectClaudePassthrough` first.
   * - Local-only by design: each machine connects independently.
   */
  connectClaudePassthrough: publicProcedure
    .input(
      z.object({
        accountLabel: z.string().min(1),
        // sourcePath is later dispatched by `source-readers.ts` to
        // `security` (argv-safe), `secret-tool` (argv-safe after the May 2026
        // pre-commit fix), or `readFileSync`. Validate the scheme up front so
        // an attacker who finds a path to call this mutation can't route to a
        // future scheme or read an arbitrary file. file:// paths are
        // additionally constrained to ~/.claude/ so a malicious renderer
        // can't ask us to read /etc/passwd or similar.
        sourcePath: z
          .string()
          .min(1)
          .max(2048)
          .refine(
            (value) => ALLOWED_SOURCE_PATH_SCHEMES.some((scheme) => value.startsWith(scheme)),
            {
              message: `sourcePath must use one of: ${ALLOWED_SOURCE_PATH_SCHEMES.join(', ')}`,
            },
          )
          .refine(
            (value) => {
              if (!value.startsWith('file://')) return true;
              try {
                const filePath = value.slice('file://'.length);
                const decoded = decodeURIComponent(filePath);
                const normalized = path.resolve(decoded);
                // Anchor to the actual ~/.claude directory so /tmp/.claude/x
                // can't sneak through. `path.resolve` collapses `..` segments,
                // so "/Users/foo/.claude/../../etc/passwd" becomes "/etc/passwd"
                // and fails the prefix check.
                const claudeDir = path.resolve(os.homedir(), '.claude');
                return normalized === claudeDir || normalized.startsWith(`${claudeDir}${path.sep}`);
              } catch {
                return false;
              }
            },
            { message: 'file:// sourcePath must reference a path under ~/.claude/' },
          ),
        expectedEmail: z.string().optional(),
        /**
         * Renderer signal: this Connect originated from the empty-state's
         * "Reconnect" CTA on an existing same-label row (Bug #E). When set,
         * the procedure CONVERTS the existing claude-code row to passthrough
         * in place instead of rejecting on label collision.
         */
        reauth: z.boolean().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      // Defense in depth: the renderer hides the "Use Claude Code login" CTA on
      // Windows, but a DevTools/automation caller could still invoke this
      // mutation. Reject server-side so we never persist an unresolvable
      // passthrough row that would just fail at chat-time.
      if (process.platform === 'win32') {
        throw new Error(
          'Claude Code login (passthrough) is not supported on Windows yet. Use an Anthropic API key instead.',
        );
      }

      const db = getDatabase();

      // Re-detect to confirm the source is still resolvable. We don't fail on
      // !available — the caller may want to "save" a connection even if the keychain
      // was just rotated; in that case `getDefaultClaudeCodeToken` will mark
      // needsReauthAt on the next chat send. Run BEFORE the transaction since it
      // shells out to `security` (slow + must not block SQLite).
      const detection = await detectClaudeAccount();
      const expectedEmail = input.expectedEmail ?? detection.email ?? null;

      // Wrap SELECT + (UPDATE | INSERT) in a transaction so two concurrent
      // Connect clicks (Bug #20) cannot both pass the existence check and both
      // insert — the second transaction sees the first's row and re-routes to
      // the UPDATE branch. drizzle's `db.transaction(cb)` invokes `cb` with a
      // tx handle (we ignore it) and returns `cb`'s value directly.
      const connectRow = () =>
        db.transaction(() => {
          const existingPassthrough = db
            .select()
            .from(claudeCodeCredentials)
            .where(eq(claudeCodeCredentials.source, 'claude-passthrough'))
            .get();

          if (existingPassthrough && existingPassthrough.sourcePath !== input.sourcePath) {
            const currentLabel = existingPassthrough.accountLabel || 'Claude Code';
            throw new Error(
              `Already connected to "${currentLabel}". Disconnect it first to switch to a different Claude login.`,
            );
          }

          const isFirstAccount =
            !existingPassthrough &&
            !db
              .select({ id: claudeCodeCredentials.id })
              .from(claudeCodeCredentials)
              .where(LOCAL_DEFAULT_ACCOUNT_SCOPE)
              .limit(1)
              .get();

          if (existingPassthrough) {
            // Outside a reauth, updating would silently rename the one Claude Code login on this
            // device when the user meant to add one, so refuse; a reauth refreshes it in place.
            if (!input.reauth) {
              const currentLabel = existingPassthrough.accountLabel || 'Claude Code';
              throw new Error(
                `You already have a Claude Code login connected on this device as "${currentLabel}". ` +
                  `Edit that account from Settings → AI providers if you want to rename it. ` +
                  `Only one Claude Code login per device is supported.`,
              );
            }
            db.update(claudeCodeCredentials)
              .set({
                accountLabel: input.accountLabel,
                expectedEmail,
                needsReauthAt: null,
                connectedAt: new Date(),
              })
              .where(eq(claudeCodeCredentials.id, existingPassthrough.id))
              .run();
            retireRetainedSessions('credential-change');
            return { accountId: existingPassthrough.id, status: 'updated' as const };
          }

          // A same-label hit means two rows for one logical account — reject, unless `input.reauth`
          // says the user is deliberately re-authing that row, which converts it in place.
          const labelCollision = db
            .select()
            .from(claudeCodeCredentials)
            .where(
              and(eq(claudeCodeCredentials.accountLabel, input.accountLabel), CLAUDE_ACCOUNT_SCOPE),
            )
            .limit(1)
            .get();

          if (labelCollision) {
            if (!input.reauth) {
              throw new Error(
                `An account named "${input.accountLabel}" already exists. Use a different label, or disconnect the existing account first.`,
              );
            }

            // Convert in place. Same id (preserves cloud sync linkage),
            // same isDefault flag. Token cleared (passthrough resolves live).
            db.update(claudeCodeCredentials)
              .set({
                source: 'claude-passthrough',
                sourcePath: input.sourcePath,
                expectedEmail,
                oauthToken: null,
                needsReauthAt: null,
                connectedAt: new Date(),
              })
              .where(eq(claudeCodeCredentials.id, labelCollision.id))
              .run();
            retireRetainedSessions('credential-change');
            return { accountId: labelCollision.id, status: 'updated' as const };
          }

          if (isFirstAccount) {
            clearLocalAccountDefaults();
          }

          const id = createId();
          db.insert(claudeCodeCredentials)
            .values({
              id,
              type: 'claude-code',
              accountLabel: input.accountLabel,
              oauthToken: null,
              connectedAt: new Date(),
              isDefault: isFirstAccount,
              source: 'claude-passthrough',
              sourcePath: input.sourcePath,
              expectedEmail,
            })
            .run();

          return { accountId: id, status: 'created' as const };
        });

      return trackAccountConnect({ provider: 'claude-code', kind: 'passthrough' }, connectRow);
    }),

  /**
   * Remove the local passthrough row. LOCAL-ONLY — never propagates to Neon
   * (passthrough rows are never synced to begin with).
   */
  disconnectClaudePassthrough: publicProcedure
    .input(z.object({ accountId: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const db = getDatabase();
      const row = db
        .select()
        .from(claudeCodeCredentials)
        .where(eq(claudeCodeCredentials.id, input.accountId))
        .get();
      if (!row) {
        throw new Error(`Account "${input.accountId}" not found`);
      }
      if (!isPassthroughSource(row.source)) {
        throw new Error(
          'disconnectClaudePassthrough only handles passthrough rows (claude/codex). Use the regular delete endpoint for API-key accounts.',
        );
      }
      db.delete(claudeCodeCredentials).where(eq(claudeCodeCredentials.id, input.accountId)).run();
      retireRetainedSessions('credential-change');
      return { success: true as const };
    }),

  // ============ MULTI-ACCOUNT ENDPOINTS ============

  /**
   * List all Claude Code accounts with their status
   */
  listAccounts: publicProcedure.query(() => {
    const db = getDatabase();
    const accounts = db
      .select()
      .from(claudeCodeCredentials)
      .where(sql`${SELECTABLE_ACCOUNT_TYPE_SCOPE}`)
      .all();

    return accounts.flatMap((acc) => {
      const provider = aiProvider(acc.type);
      if (!provider) return [];
      // Codex is passthrough (token-null), never an API key; only claude-code rows can be.
      let isApiKey = false;
      if (provider.id === 'claude-code' && acc.oauthToken) {
        try {
          const token = decryptToken(acc.oauthToken);
          if (token) {
            isApiKey = isAnthropicApiKey(token);
          }
        } catch {
          // If decryption fails, assume OAuth
        }
      }
      // Passthrough rows (claude + codex) have oauth_token = NULL by design; auth is governed by
      // needsReauthAt (the keychain / codex binary is the source of truth). Shared helper.
      const isAuthenticated = isAccountAuthenticated(acc);
      const account = {
        id: acc.id,
        label: acc.accountLabel || provider.name,
        isDefault: acc.isDefault ?? false,
        isAuthenticated,
        connectedAt: acc.connectedAt?.toISOString() ?? null,
        isApiKey,
        type: provider.id,
        // Narrow the TEXT column to the runtime union at the boundary so the
        // renderer can branch on `source` without re-narrowing every render.
        // SAFETY: rows are only written with a CredentialSource value.
        source: (acc.source ?? 'api-key') as CredentialSource,
        sourcePath: acc.sourcePath ?? null,
        needsReauthAt: acc.needsReauthAt?.toISOString() ?? null,
        expectedEmail: acc.expectedEmail ?? null,
      };
      return [account];
    });
  }),

  /**
   * Add a new account (store token with label)
   * Supports both OAuth tokens and API keys - detection is automatic based on prefix
   */
  addAccount: publicProcedure
    .input(
      z.object({
        label: z.string().min(1),
        token: z.string().min(1),
        setAsDefault: z.boolean().default(false),
        isApiKey: z.boolean().optional(),
        type: z.literal('claude-code').optional(),
      }),
    )
    .mutation(({ input }) =>
      trackAccountConnect(
        { provider: 'claude-code', kind: input.isApiKey ? 'api_key' : 'token' },
        async () => {
          const db = getDatabase();

          const existing = db
            .select()
            .from(claudeCodeCredentials)
            .where(and(eq(claudeCodeCredentials.accountLabel, input.label), CLAUDE_ACCOUNT_SCOPE))
            .get();

          if (existing) {
            throw new Error(`Account "${input.label}" already exists`);
          }

          const accountType = (input.type ?? 'claude-code') as AIAccountType;
          const trimmedToken = input.token.trim();

          await assertValidAccountToken(trimmedToken);

          // If this is the first account, make it default. Count ALL local providers (incl codex)
          // so an api-key add after a default codex isn't falsely "first" → no second default.
          const firstAccount = db
            .select()
            .from(claudeCodeCredentials)
            .where(sql`${LOCAL_DEFAULT_ACCOUNT_SCOPE}`)
            .limit(1)
            .get();
          const isFirstAccount = !firstAccount;

          const id = storeAccountToken(
            input.label,
            trimmedToken,
            input.setAsDefault || isFirstAccount,
            accountType,
          );

          return { success: true, id, status: 'created' as const };
        },
      ),
    ),

  /**
   * Set an account as the default
   */
  setDefault: publicProcedure.input(z.object({ id: z.string() })).mutation(({ input }) => {
    const db = getDatabase();

    // First verify the target account exists
    const targetAccount = db
      .select()
      .from(claudeCodeCredentials)
      .where(eq(claudeCodeCredentials.id, input.id))
      .get();

    if (!targetAccount) {
      throw new Error(`Account with id "${input.id}" not found`);
    }

    clearLocalAccountDefaults();

    // Set this one as default
    db.update(claudeCodeCredentials)
      .set({ isDefault: true })
      .where(eq(claudeCodeCredentials.id, input.id))
      .run();

    return { success: true };
  }),

  /**
   * Rename an account
   */
  renameAccount: publicProcedure
    .input(
      z.object({
        id: z.string(),
        newLabel: z.string().min(1),
      }),
    )
    .mutation(({ input }) => {
      const db = getDatabase();

      // Check if new label already exists on another account
      const existing = db
        .select()
        .from(claudeCodeCredentials)
        .where(and(eq(claudeCodeCredentials.accountLabel, input.newLabel), CLAUDE_ACCOUNT_SCOPE))
        .get();

      if (existing && existing.id !== input.id) {
        throw new Error(`Account "${input.newLabel}" already exists`);
      }

      const account = db
        .select()
        .from(claudeCodeCredentials)
        .where(eq(claudeCodeCredentials.id, input.id))
        .get();
      if (!account) {
        throw new Error(`Account with id "${input.id}" not found`);
      }

      // Project routing is keyed by credential id, so a rename cannot invalidate it.
      db.update(claudeCodeCredentials)
        .set({ accountLabel: input.newLabel })
        .where(eq(claudeCodeCredentials.id, input.id))
        .run();

      return { success: true };
    }),

  /**
   * Delete an account (removes from local SQLite and cleans up Neon project associations)
   */
  deleteAccount: publicProcedure.input(z.object({ id: z.string() })).mutation(({ input }) => {
    const db = getDatabase();

    // Get the account to check if it exists and is default
    const account = db
      .select()
      .from(claudeCodeCredentials)
      .where(eq(claudeCodeCredentials.id, input.id))
      .get();

    if (!account) {
      throw new Error(`Account with id "${input.id}" not found`);
    }

    // Project routing cascades on the credential FK, so the delete is the whole cleanup.
    db.delete(claudeCodeCredentials).where(eq(claudeCodeCredentials.id, input.id)).run();
    promoteNextDefaultAccount(account.isDefault);
    retireRetainedSessions('credential-change');

    return { success: true };
  }),

  /**
   * Update token for an existing account (re-authenticate)
   */
  updateAccountToken: publicProcedure
    .input(
      z.object({
        id: z.string(),
        token: z.string().min(1),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDatabase();

      // First verify the account exists
      const account = db
        .select()
        .from(claudeCodeCredentials)
        .where(eq(claudeCodeCredentials.id, input.id))
        .get();

      if (!account) {
        throw new Error(`Account with id "${input.id}" not found`);
      }

      // Validate the new token before storing
      const trimmedToken = input.token.trim();
      await assertValidAccountToken(trimmedToken);

      // Promote to default if none exists (e.g., synced placeholder being authenticated)
      const hasDefault = db
        .select()
        .from(claudeCodeCredentials)
        .where(sql`${claudeCodeCredentials.isDefault} = 1 AND ${CLAUDE_ACCOUNT_SCOPE}`)
        .get();
      if (!hasDefault) {
        db.update(claudeCodeCredentials)
          .set({ isDefault: true })
          .where(eq(claudeCodeCredentials.id, input.id))
          .run();
      }

      persistLocalAccountToken(input.id, trimmedToken);
      return { success: true as const };
    }),

  // ============ PROJECT-ACCOUNT MAPPING ============

  /**
   * Get the credential id of the account assigned to a project.
   * Returns null if using default account.
   */
  getProjectAccount: publicProcedure
    .input(z.object({ projectId: z.string() }))
    .query(async ({ input }) => {
      const mapping = await getProjectAiAccount(input.projectId);
      return mapping?.id ?? null;
    }),

  /**
   * Set which Claude account a project should use
   * Pass null to use default account
   */
  setProjectAccount: publicProcedure
    .input(
      z.object({
        projectId: z.string(),
        accountId: z.string().nullable(),
      }),
    )
    .mutation(async ({ input }) => {
      await setProjectAiAccount(input.projectId, input.accountId);
      return { success: true };
    }),

  /**
   * The account label and provider type for a chat (its stamped account) or for new-chat context
   * (the projectId's override), else the default account.
   *
   * `projectId` in the result is the scoped project for account-picker mutations (null = workspace default only).
   */
  getResolvedAccount: publicProcedure
    .input(
      z.object({
        chatId: z.string().optional(),
        projectId: z.string().optional(),
      }),
    )
    .query(async ({ input }) => {
      const db = getDatabase();

      // Type + auth state use the module-scope helpers (shared with listAccounts/getIntegration
      // so the three selection reads can't drift). `type` resolves to 'codex' when a codex row
      // surfaces (flag on); codex passthrough is authenticated by needsReauthAt, not a token.
      const chat = input.chatId ? await getChatById(db, input.chatId) : null;
      // A chat on a provider that is switched off here shows no login at all.
      if (chat && !SELECTABLE_ACCOUNT_TYPES.some((id) => id === chat.provider)) return null;
      const scopedProjectId = (input.chatId ? chat?.projectId : input.projectId) ?? null;
      const projectOverride = scopedProjectId ? await getProjectAiAccount(scopedProjectId) : null;
      const pinned = chat ? await getChatAiAccount(db, chat) : projectOverride;
      // A blocked chat (login removed) shows another login of its own provider, never another's.
      const scope = chat
        ? sql`${claudeCodeCredentials.type} = ${chat.provider}`
        : SELECTABLE_ACCOUNT_TYPE_SCOPE_WITH_NULL;
      if (pinned) {
        // Keyed by primary key, so no ranking. The type scope still hides a launch-flag-hidden
        // codex row even when the chat or project still points at it.
        const localAccount = db
          .select()
          .from(claudeCodeCredentials)
          .where(
            and(eq(claudeCodeCredentials.id, pinned.id), SELECTABLE_ACCOUNT_TYPE_SCOPE_WITH_NULL),
          )
          .get();
        const freshOverride = await reprobeFlaggedPassthrough(localAccount);

        // A pinned row this user cannot see (another account's, hidden type, or deleted
        // mid-probe) is no override: fall through to the user's own default account.
        if (freshOverride) {
          return toResolvedAccount(freshOverride, {
            isProjectOverride: freshOverride.id === projectOverride?.id,
            isBlocked: false,
            projectId: scopedProjectId,
          });
        }
      }

      // Any fallback for a chat stands in for a removed login: the chat is blocked until retried.
      const fallback = {
        isProjectOverride: false,
        isBlocked: Boolean(chat),
        projectId: scopedProjectId,
      };

      // Fall back to default account. More than one row could carry isDefault=1 (cloud
      // sync race or stale flag), and we want the authenticated one to win — this ranks
      // across genuine candidates rather than disambiguating one identity.
      const defaultAccount = db
        .select()
        .from(claudeCodeCredentials)
        .where(sql`${claudeCodeCredentials.isDefault} = 1 AND ${scope}`)
        .orderBy(
          desc(RESOLVABLE_FIRST_RANK),
          desc(HEALABLE_NEXT_RANK),
          desc(claudeCodeCredentials.connectedAt),
        )
        .limit(1)
        .get();

      const freshDefault = await reprobeFlaggedPassthrough(defaultAccount);
      if (freshDefault) return toResolvedAccount(freshDefault, fallback);

      // Fall back to best available account. Order: passthrough (no needsReauthAt)
      // OR api-key with token, then by recency. Without the source check passthrough
      // rows would always be ranked last and a user with one passthrough + one stale
      // api-key would always pick the wrong row.
      const anyAccount = db
        .select()
        .from(claudeCodeCredentials)
        .where(scope)
        .orderBy(
          desc(RESOLVABLE_FIRST_RANK),
          desc(HEALABLE_NEXT_RANK),
          desc(claudeCodeCredentials.connectedAt),
        )
        .limit(1)
        .get();
      const freshAny = await reprobeFlaggedPassthrough(anyAccount);
      if (freshAny) return toResolvedAccount(freshAny, fallback);

      return null;
    }),
});
