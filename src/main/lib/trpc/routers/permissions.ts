/**
 * Permissions Router (v2 only)
 *
 * Backs the four-button prompt + the Settings → Agents/Permissions tab. v1
 * procedures + their store/repo dependencies were removed in ticket 14.
 */

import { z } from 'zod';
import { validateRuleString } from '../../../../shared/lib/validate-rule';
import { getDatabase } from '../../db';
import { syncProjectRuleToCursorDurably } from '../../permissions/cursor-sync-pending';
import {
  addProjectRule,
  addUserRule,
  getProjectDoc,
  getUserDoc,
  removeProjectRule,
  removeUserRule,
} from '../../permissions/v2/store-local';
import { getPolicyDoc } from '../../permissions/v2/store-policy';
import { SYSTEM_DENIED_PATTERNS } from '../../permissions/v2/system-denied-patterns';
import type { PermissionsDoc } from '../../permissions/v2/types';
import { publicProcedure, router } from '../index';

const RULE_TYPE = z.enum(['allow', 'deny', 'ask']);

type AddRuleResult =
  | { ok: true }
  | { ok: false; error: 'validation' | 'duplicate'; message: string };

export const permissionsRouter = router({
  /**
   * Get system-denied path patterns (read-only, for display purposes).
   * These paths are hardcoded in backend and NEVER allowed.
   */
  getSystemDeniedPaths: publicProcedure.query((): readonly string[] => {
    return SYSTEM_DENIED_PATTERNS;
  }),

  /** Project-tier rules for a given project. Empty doc if project has no rules. */
  listProjectRules: publicProcedure
    .input(z.object({ projectId: z.string() }))
    .query(async ({ input }): Promise<PermissionsDoc> => {
      return getProjectDoc(getDatabase(), input.projectId);
    }),

  /** User-tier rules (this machine). Empty doc when none are stored. */
  listUserRules: publicProcedure.query(async (): Promise<PermissionsDoc> => {
    return getUserDoc(getDatabase());
  }),

  /** Policy-tier rules (read-only managed file). Global per-machine. */
  getPolicyDoc: publicProcedure.query(async (): Promise<PermissionsDoc> => {
    return getPolicyDoc();
  }),

  /**
   * Add a rule at project scope.
   * - `validation` error → rule string failed `validateRuleString` (grammar,
   *   unknown tool name, or deny on a `REQUIRED_TOOLS` member).
   * - `duplicate` error → rule already exists (UNIQUE constraint hit).
   */
  addProjectRule: publicProcedure
    .input(
      z.object({
        projectId: z.string(),
        ruleString: z.string(),
        ruleType: RULE_TYPE,
      }),
    )
    .mutation(async ({ input }): Promise<AddRuleResult> => {
      const validation = validateRuleString(input.ruleString, input.ruleType);
      if (!validation.ok) {
        return { ok: false, error: 'validation', message: validation.message };
      }
      const db = getDatabase();
      const { inserted } = await addProjectRule(
        db,
        input.projectId,
        input.ruleString,
        input.ruleType,
      );
      if (input.ruleType === 'allow') {
        await syncProjectRuleToCursorDurably(db, input.projectId, input.ruleString);
      }
      if (!inserted) {
        return { ok: false, error: 'duplicate', message: 'Rule already exists' };
      }
      return { ok: true };
    }),

  /** Add a rule at user scope (this machine). */
  addUserRule: publicProcedure
    .input(z.object({ ruleString: z.string(), ruleType: RULE_TYPE }))
    .mutation(async ({ input }): Promise<AddRuleResult> => {
      const validation = validateRuleString(input.ruleString, input.ruleType);
      if (!validation.ok) {
        return { ok: false, error: 'validation', message: validation.message };
      }
      const { inserted } = await addUserRule(getDatabase(), input.ruleString, input.ruleType);
      if (!inserted) {
        return { ok: false, error: 'duplicate', message: 'Rule already exists' };
      }
      return { ok: true };
    }),

  /** Remove a project-tier rule (idempotent); allow rules are also re-synced to `.cursor/cli.json`. */
  removeProjectRule: publicProcedure
    .input(
      z.object({
        projectId: z.string(),
        ruleString: z.string(),
        ruleType: RULE_TYPE,
      }),
    )
    .mutation(async ({ input }): Promise<void> => {
      const db = getDatabase();
      await removeProjectRule(db, input.projectId, input.ruleString, input.ruleType);
      if (input.ruleType === 'allow') {
        await syncProjectRuleToCursorDurably(db, input.projectId, input.ruleString);
      }
    }),

  /** Remove a user-tier rule. Idempotent (no-op if not present). */
  removeUserRule: publicProcedure
    .input(z.object({ ruleString: z.string(), ruleType: RULE_TYPE }))
    .mutation(async ({ input }): Promise<void> => {
      await removeUserRule(getDatabase(), input.ruleString, input.ruleType);
    }),
});
