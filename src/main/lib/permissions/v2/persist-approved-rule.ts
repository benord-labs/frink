/**
 * Shared persistence path for renderer-approved rules; `validateToolPermission` routes here.
 *
 * Trust boundary: `promptResult.ruleString` comes from the renderer over
 * IPC and must be validated via `validateRuleString` before being written
 * to sqlite. `validateRuleString` layers grammar (`parseRule`) + tool-name
 * semantics (known-tool / `mcp__*` prefix) + required-tool deny block.
 * Invalid rules are dropped with a warning — the approval still counts
 * as "Allow once" (no persistence).
 */

import log from 'electron-log';
import { validateRuleString } from '../../../../shared/lib/validate-rule';
import type { getDatabase } from '../../db';
import { addBashRuleToCursorConfig } from '../cursor-config-sync';
import { addProjectRule, addUserRule } from './store-local';
import type { RuleType } from './types';

type ApprovedRulePayload = {
  scope?: 'project' | 'user';
  ruleString?: string;
  ruleType?: RuleType;
};

type Db = ReturnType<typeof getDatabase>;

export async function persistApprovedRule(params: {
  db: Db;
  projectPath: string;
  project: { id: string } | null;
  promptResult: ApprovedRulePayload;
  /** True when the approved tool is Bash — triggers cursor-config sync for project-scope. */
  isBash: boolean;
  /** Log tag prefix (e.g. "[Permission]", "[claude.ts]", "[executor]"). */
  logTag: string;
}): Promise<void> {
  const { db, projectPath, project, promptResult, isBash, logTag } = params;

  // scope === undefined → "Allow once" → no persistence.
  if (!promptResult.scope || !promptResult.ruleString) return;

  const ruleType: RuleType = promptResult.ruleType ?? 'allow';

  // Trust-boundary validation: the renderer is untrusted; reject malformed
  // rules, unknown tool names, and deny rules on required tools.
  const validation = validateRuleString(promptResult.ruleString, ruleType);
  if (!validation.ok) {
    log.warn(
      `${logTag} Ignoring invalid ruleString from renderer:`,
      validation.message,
      promptResult.ruleString,
    );
    return;
  }

  if (promptResult.scope === 'project') {
    if (!project) {
      log.warn(`${logTag} Allow-for-project clicked without project context: ${projectPath}`);
      return;
    }
    try {
      await addProjectRule(db, project.id, promptResult.ruleString, ruleType);
      if (isBash) {
        // Cursor config is project-scoped (`<projectPath>/.cursor/cli.json`).
        await addBashRuleToCursorConfig(projectPath, promptResult.ruleString);
      }
    } catch (err) {
      log.warn(
        `${logTag} Failed to persist approved project rule:`,
        err instanceof Error ? err.message : String(err),
      );
    }
    return;
  }

  // scope === 'user'
  try {
    await addUserRule(db, promptResult.ruleString, ruleType);
  } catch (err) {
    log.warn(
      `${logTag} Failed to persist approved user rule:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}
