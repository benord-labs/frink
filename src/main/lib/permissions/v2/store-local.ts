/**
 * Local sqlite store for v2 permission rules. Backs the dispatcher's `setDocsLoader`
 * (wired in ticket 07). Bare exported async functions, db handle threaded as first arg
 * — matches the `src/main/lib/db/repos/` pattern.
 *
 * Storage shape: user rules are keyed on (rule_string, rule_type) and apply to the
 * whole machine; project rules add the project id. UNIQUE indexes dedup raw strings.
 *
 * 0.0.6 is local-only — no Neon mirror.
 * Ticket 06 of the permissions overhaul.
 */

import { and, asc, eq, sql } from 'drizzle-orm';
import type { getDatabase } from '../../db/index';
import {
  type ProjectPermissionRule,
  projectPermissionRules,
  type UserPermissionRule,
  userPermissionRules,
} from '../../db/schema';
import type { PermissionsDoc, RuleType } from './types';

type Db = ReturnType<typeof getDatabase>;

function rowsToDoc(rows: { ruleString: string; ruleType: string }[]): PermissionsDoc {
  const doc: PermissionsDoc = { allow: [], deny: [], ask: [] };
  for (const row of rows) {
    if (row.ruleType === 'allow' || row.ruleType === 'deny' || row.ruleType === 'ask') {
      doc[row.ruleType].push(row.ruleString);
    }
  }
  return doc;
}

// ============ USER SCOPE ============

export async function getUserDoc(db: Db): Promise<PermissionsDoc> {
  const rows: UserPermissionRule[] = await db
    .select()
    .from(userPermissionRules)
    // rowid (sqlite implicit auto-increment) is the deterministic tiebreaker for
    // rules added in the same millisecond; cuid2 ids aren't time-monotonic.
    .orderBy(asc(userPermissionRules.createdAt), sql`rowid`);
  return rowsToDoc(rows);
}

export async function addUserRule(
  db: Db,
  rule: string,
  type: RuleType,
): Promise<{ inserted: boolean }> {
  // raw-string dedup via UNIQUE(rule_string, rule_type); canonical-form
  // equivalence handled by upstream rule generation.
  const result = await db
    .insert(userPermissionRules)
    .values({ ruleString: rule, ruleType: type })
    .onConflictDoNothing()
    .returning({ id: userPermissionRules.id });
  return { inserted: result.length > 0 };
}

export async function removeUserRule(db: Db, rule: string, type: RuleType): Promise<void> {
  await db
    .delete(userPermissionRules)
    .where(and(eq(userPermissionRules.ruleString, rule), eq(userPermissionRules.ruleType, type)));
}

// ============ PROJECT SCOPE ============

export async function getProjectDoc(db: Db, projectId: string): Promise<PermissionsDoc> {
  const rows: ProjectPermissionRule[] = await db
    .select()
    .from(projectPermissionRules)
    .where(eq(projectPermissionRules.projectId, projectId))
    .orderBy(asc(projectPermissionRules.createdAt), sql`rowid`);
  return rowsToDoc(rows);
}

export async function addProjectRule(
  db: Db,
  projectId: string,
  rule: string,
  type: RuleType,
): Promise<{ inserted: boolean }> {
  const result = await db
    .insert(projectPermissionRules)
    .values({ projectId, ruleString: rule, ruleType: type })
    .onConflictDoNothing()
    .returning({ id: projectPermissionRules.id });
  return { inserted: result.length > 0 };
}

/**
 * True when any project allow rule equals `rule` after trimming — validateRuleString accepts padded
 * rules, so padded variants back the same Cursor token. `instr` narrows candidates in SQL.
 */
export async function hasProjectAllowRuleIgnoringPadding(
  db: Db,
  projectId: string,
  rule: string,
): Promise<boolean> {
  const canonical = rule.trim();
  if (!canonical) return false;
  const rows = await db
    .select({ ruleString: projectPermissionRules.ruleString })
    .from(projectPermissionRules)
    .where(
      and(
        eq(projectPermissionRules.projectId, projectId),
        eq(projectPermissionRules.ruleType, 'allow'),
        sql`instr(${projectPermissionRules.ruleString}, ${canonical}) > 0`,
      ),
    );
  return rows.some((row) => row.ruleString.trim() === canonical);
}

export async function removeProjectRule(
  db: Db,
  projectId: string,
  rule: string,
  type: RuleType,
): Promise<void> {
  await db
    .delete(projectPermissionRules)
    .where(
      and(
        eq(projectPermissionRules.projectId, projectId),
        eq(projectPermissionRules.ruleString, rule),
        eq(projectPermissionRules.ruleType, type),
      ),
    );
}
