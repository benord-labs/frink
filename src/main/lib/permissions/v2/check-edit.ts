/**
 * File-op checker (Edit / Read / Write / Delete / MultiEdit / NotebookEdit).
 * Tier-1c: `isSystemDeniedPath`. Then rule eval. Pure function.
 *
 * Ticket 05 of the permissions overhaul.
 */

import { existsSync } from 'node:fs';
import * as nodePath from 'node:path';
import { expandHomePath as expandTilde } from '../../../../shared/lib/expand-home';
import { getSkillReadRoots } from '../../frink-skills-dir';
import { isPathWithinProject, resolveToRealPath } from '../path-check';
import { classifyPath } from './classify-path';
import { combineScopes, evalScope, resultFromCombined, type ScopedDocs } from './eval-rules';
import { isAutoAllowedPath, isSystemDeniedPath } from './system-denied-patterns';
import type { MatchContext, PermissionResult } from './types';

/**
 * The frink-shipped baseline manifest. Its presence in a skill dir is the trust
 * signal for the Read auto-allow: only skills Frink ships AND maintains carry it
 * (the boot provisioner writes it). A user's own skill — hand-authored, or a frink
 * REAL-COPY projection of the user's skill (which carries `.frink-projected` but no
 * baseline) — never has it, so it keeps prompting. Trust is provenance, not location.
 */
const FRINK_SHIPPED_SKILL_MARKER = '.baseline.json';

/**
 * True iff `absolute` reads inside a FRINK-SHIPPED skill dir — one whose top-level
 * skill folder (a direct child of a skill read-root) carries the baseline marker.
 * `isPathWithinProject` realpaths the input first (so the session symlink chain
 * resolves and an in-dir symlink escaping out still fails containment), then we key
 * the trust decision off the marker rather than the path. Decision:
 * frink-skills-read-permission-trust (honored across the symlink→real-copy migration).
 */
function isFrinkShippedSkillRead(absolute: string, roots: string[]): boolean {
  for (const root of roots) {
    if (!root || !isPathWithinProject(absolute, root)) continue;
    const realRoot = resolveToRealPath(root);
    const skillName = nodePath
      .relative(realRoot, resolveToRealPath(absolute))
      .split(nodePath.sep)[0];
    if (skillName && existsSync(nodePath.join(realRoot, skillName, FRINK_SHIPPED_SKILL_MARKER))) {
      return true;
    }
  }
  return false;
}

/**
 * Read-only auto-allow scope inside the chat's Claude session dir
 * (`CLAUDE_CONFIG_DIR`): exactly `pasted/**` (paste blobs — user approved the
 * content by pasting) and `projects/**\/tool-results/**` (large MCP results the
 * CLI spills to disk and the agent must read back). An allow-LIST, not the
 * whole dir: transcripts (`projects/<slug>/<uuid>.jsonl`), `shell-snapshots/`
 * (captured shell env), and `.claude.json` (account metadata) deliberately
 * keep prompting. `isAutoAllowedPath` realpaths the parent, so symlinked
 * subtrees (`skills/`, `agents/`) fail containment and fall through to the
 * skill-marker branch. `parts.includes` (not a fixed depth) because subagent
 * spill files may nest deeper; the segment check is lexical but containment is
 * already realpath-verified.
 */
function isSessionScopedRead(absolute: string, sessionDirRoot: string): boolean {
  if (isAutoAllowedPath(absolute, nodePath.join(sessionDirRoot, 'pasted'))) return true;
  if (!isAutoAllowedPath(absolute, nodePath.join(sessionDirRoot, 'projects'))) return false;
  const parts = nodePath
    .relative(nodePath.resolve(sessionDirRoot), nodePath.resolve(absolute))
    .split(nodePath.sep);
  return parts.includes('tool-results');
}

export type FileOpInput = {
  file_path?: string;
  file?: string;
  path?: string;
};

export type PathToolName = 'Edit' | 'Read' | 'Write' | 'Delete' | 'MultiEdit' | 'NotebookEdit';

/**
 * Tools the agent uses to author a plan (create, read back, rewrite). Only these
 * bypass the prompt against `planDirRoot`. Delete + NotebookEdit are excluded —
 * not part of plan authoring, so they keep prompting even inside the plans dir.
 * Distinct from `check.ts`'s `AUTO_ALLOW_TOOLS` (Glob/Grep, unconditional bypass):
 * this set is path-conditional (only inside the plans dir).
 */
const PLAN_DIR_BYPASS_TOOLS = new Set<PathToolName>(['Read', 'Write', 'Edit', 'MultiEdit']);

/** Re-exported under the v2-friendly name for check-bash + check-edit usage. */
export { expandHomePath as expandTilde } from '../../../../shared/lib/expand-home';

export function checkEdit(
  input: FileOpInput,
  docs: ScopedDocs,
  projectRoot: string,
  toolName: PathToolName = 'Edit',
  sessionDirRoot?: string,
  planDirRoot?: string,
  skillsDirRoots: string[] = getSkillReadRoots(),
): PermissionResult {
  // Field chain mirrors `tool-validation.ts:extractFilePathFromToolInput`.
  const rawPath = input.file_path ?? input.file ?? input.path;
  if (!rawPath) {
    return resultFromCombined({ decision: 'ask' }, toolName, input);
  }

  // Defense-in-depth: model could pass `~/.ssh/foo` directly.
  const filePath = expandTilde(rawPath);

  // Tier-1c (bypass-immune) — runs BEFORE auto-allow so the deny list always
  // wins. Auto-allow can never grant access to a system-denied path.
  if (isSystemDeniedPath(filePath, projectRoot)) {
    return { decision: 'deny', reason: { kind: 'safety:path', path: filePath } };
  }

  // Rule eval. picomatch is anchored — `Edit(src/**)` matches `src/a.ts`, NOT
  // `/project/src/a.ts`. Pass the project-relative form when the file is
  // inside projectRoot; absolute as fallback for outside-project paths.
  const absolute = nodePath.isAbsolute(filePath)
    ? filePath
    : nodePath.resolve(projectRoot, filePath);
  const relative = nodePath.relative(projectRoot, absolute);
  const matchPath = relative.startsWith('..') ? absolute : relative;
  const ctx: MatchContext = { resolvedPath: matchPath };

  // Auto-allow: Read tool invocations against this chat's own session dir,
  // scoped to the `isSessionScopedRead` allow-list (paste blobs + CLI
  // tool-result spill files). Read-only — Edit/Write/Delete still prompt
  // (agent shouldn't be writing into session storage). Runs AFTER tier-1c
  // system-denied (the deny list always wins) and uses `absolute` (never the
  // possibly-relative `filePath`) so a relative read can't resolve against
  // process.cwd().
  if (toolName === 'Read' && sessionDirRoot && isSessionScopedRead(absolute, sessionDirRoot)) {
    return { decision: 'allow' };
  }

  // Auto-allow: Read of a FRINK-SHIPPED skill (one carrying the baseline marker),
  // wherever it lives — the canonical `~/.frink/skills` store or a per-tool real-copy
  // dir (`~/.agents/skills`, `~/.claude/skills`, `~/.cursor/skills`). Frink's own
  // skills are first-party-trusted: the agent reads SKILL.md/references constantly and
  // they sit outside the project cwd, so they would otherwise prompt every read.
  // Read-only — Edit/Write/Delete still prompt. Runs AFTER tier-1c system-denied (a
  // secret smuggled into a skills dir still wins). The trust key is the provenance
  // marker, NOT the location: a user's own skill — hand-authored, or a frink real-copy
  // projection of it — has no baseline and keeps prompting (decision:
  // frink-skills-read-permission-trust, preserved across the symlink→copy migration).
  // Uses `absolute` (never the possibly-relative `filePath`) so a relative read can't
  // false-match a root.
  if (toolName === 'Read' && isFrinkShippedSkillRead(absolute, skillsDirRoots)) {
    return { decision: 'allow' };
  }

  // Plan-mode auto-allow: the file ops the agent uses to author its plan (read,
  // create, rewrite) against THIS chat's app-owned session plans dir short-circuit
  // with no prompt — the dir is per-chat ephemeral scratch the agent owns; prompting
  // on every plan read/write is pure friction. Like the session-dir bypass above this
  // runs AFTER tier-1c system-denied (secrets still win) and intentionally bypasses
  // user/project rules (parity with session-dir + REQUIRED_TOOLS). Delete/NotebookEdit
  // excluded — not part of plan authoring. Uses `absolute` since plan paths are absolute.
  if (
    planDirRoot &&
    PLAN_DIR_BYPASS_TOOLS.has(toolName) &&
    isAutoAllowedPath(absolute, planDirRoot)
  ) {
    return { decision: 'allow' };
  }

  const policy = evalScope(docs.policy, toolName, input, ctx);
  const project = evalScope(docs.project, toolName, input, ctx);
  const user = evalScope(docs.user, toolName, input, ctx);
  let combined = combineScopes(policy, project, user);

  // Path-location classification used for two things below:
  //  1. The project-tier tool-wide guardrail (just below).
  //  2. The `ask` prompt's `pathLocation` field that drives the renderer's
  //     3-button flow (further down).
  const pathLocation = classifyPath(absolute, projectRoot);

  // Project-scope tool-wide file-op safety net.
  //
  // Without this guardrail, a tool-wide rule like `Read` stored at project
  // scope (the natural shape from clicking "Allow Read for {project}") would
  // match ANY Read invocation regardless of path, because the matcher treats
  // `Read` (no content) as "any input for this tool" (`rule-matcher.ts:51`).
  // The user's mental model is "I'm allowing Reads inside this project", not
  // "I'm allowing every Read anywhere on the filesystem while I happen to be
  // chatting in this project". Downgrade outside-project hits to `ask` so the
  // prompt fires.
  //
  // Path-specific project-scope rules (e.g. `Read(src/**)`, `Read(/etc/hosts)`)
  // are NOT downgraded — they carry their own path semantics and trusting the
  // user's explicit glob/path is the right call.
  //
  // User-scope and policy-scope rules are not downgraded: user-scope is by
  // definition machine-wide (must be added explicitly via Settings), and
  // policy-scope is managed by an admin.
  if (combined.decision === 'allow' && combined.tier === 'project' && pathLocation === 'outside') {
    const matchedRule = combined.rule ?? '';
    const isToolWideGrant = matchedRule === toolName || matchedRule === `${toolName}(*)`;
    if (isToolWideGrant) {
      combined = { decision: 'ask' };
    }
  }

  const result = resultFromCombined(combined, toolName, input);

  // For ask decisions, attach file-op classification so the renderer can drive
  // the 3-button file-op flow (Deny / Allow once / Allow {tool} for {project}).
  // In-project paths get a tool-wide rule suggestion (`Read`, `Edit`, etc.);
  // outside paths get no persistent option.
  if (result.decision === 'ask') {
    result.prompt.pathLocation = pathLocation;
    result.prompt.suggestedRules = pathLocation === 'in-current-project' ? [toolName] : [];
  }

  return result;
}
