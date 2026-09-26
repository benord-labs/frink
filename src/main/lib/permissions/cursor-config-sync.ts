/**
 * Sync Frink permissions (Neon) to Cursor CLI configuration files
 *
 * Writes approved bash commands to .cursor/cli.json so Cursor CLI auto-approves them.
 * This prevents Cursor's model from seeing rejections when Frink has granted permission.
 *
 * Project-level config format (.cursor/cli.json):
 * { "permissions": { "allow": ["Shell(ls)"], "deny": [] } }
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import log from 'electron-log';
import { parseRule } from '../../../shared/lib/rule-parser';

type CursorPermissionConfig = {
  permissions: {
    allow: string[];
    deny: string[];
  };
};

/**
 * Get path to Cursor CLI config for a project
 */
function getCursorConfigPath(projectPath: string): string {
  return join(projectPath, '.cursor', 'cli.json');
}

/**
 * Read existing Cursor config or return empty config
 */
async function readCursorConfig(projectPath: string): Promise<CursorPermissionConfig> {
  const configPath = getCursorConfigPath(projectPath);

  try {
    if (existsSync(configPath)) {
      const content = await readFile(configPath, 'utf-8');
      const parsed = JSON.parse(content) as CursorPermissionConfig;
      if (!parsed.permissions) parsed.permissions = { allow: [], deny: [] };
      // Tolerate hand-edited or third-party-written configs where allow/deny
      // are non-arrays (null, string, missing). Coerce to [] rather than
      // crashing on .push() / .filter() / .includes() downstream.
      if (!Array.isArray(parsed.permissions.allow)) parsed.permissions.allow = [];
      if (!Array.isArray(parsed.permissions.deny)) parsed.permissions.deny = [];
      return parsed;
    }
  } catch (err) {
    log.warn(`Failed to read Cursor config at ${configPath}:`, err);
  }

  return {
    permissions: {
      allow: [],
      deny: [],
    },
  };
}

/**
 * Write Cursor config to project directory
 */
async function writeCursorConfig(
  projectPath: string,
  config: CursorPermissionConfig,
): Promise<void> {
  const configPath = getCursorConfigPath(projectPath);
  const configDir = join(projectPath, '.cursor');

  try {
    if (!existsSync(configDir)) {
      await mkdir(configDir, { recursive: true });
    }

    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
    log.info(`[Cursor Config] Synced permissions to ${configPath}`);
  } catch (err) {
    log.error(`Failed to write Cursor config at ${configPath}:`, err);
    throw err;
  }
}

/**
 * Translate a v2 rule string to cursor's `Shell(<base>)` token, or null if
 * cursor can't represent the rule without widening.
 *
 * Cursor's first-word match constraint: cursor matches `Shell(<token>)`
 * against `argv[0]` only — `Shell(git push)` does NOT auto-allow `git push`,
 * it would only ever match if the user ran a binary literally named "git push"
 * (impossible). Translating `Bash(git push:*)` to `Shell(git)` would WIDEN the
 * approval to all git subcommands cursor-side, which is unsafe because cursor
 * auto-approves before frink intercepts.
 *
 * Lossless translations only:
 *   Bash(npm:*)         → Shell(npm)        ← single-word + wildcard
 *   Bash(git:*)         → Shell(git)
 *   Bash(git push:*)    → null              ← would widen
 *   Bash(npm:install:*) → null              ← post-strip base contains ':',
 *                                              would write a dead token
 *   Bash(echo hello)    → null              ← cursor has no exact-match
 *   Bash                → null              ← tool-wide; never propagate
 *   Edit(...) / mcp__*  → null              ← cursor only cares about Shell
 *   <malformed>         → null
 *
 * TODO: confirm cursor's actual matching semantics from cursor's docs/source
 * if/when accessible. Today's first-word interpretation matches frink's
 * existing `extractBaseCommand` behaviour, which has been in production for
 * months without complaint.
 */
export function ruleStringToCursorToken(rule: string): string | null {
  // Trust boundary: callers (addBashRuleToCursorConfig from persist-approved-rule
  // and the tRPC mutations) have already passed `rule` through `validateRuleString`
  // before this function is reached. Grammar-only `parseRule` here is sufficient
  // because the semantic check is upstream — adding a second `validateRuleString`
  // call would be redundant work on every config sync.
  const parsed = parseRule(rule);
  if ('error' in parsed) return null;
  if (parsed.tool !== 'Bash') return null;
  if (!parsed.content) return null; // tool-wide

  const content = parsed.content;
  if (!content.endsWith(':*')) return null; // exact-match, no cursor equivalent

  const base = content.slice(0, -2);
  if (base.length === 0) return null;
  if (base.includes(' ') || base.includes(':')) return null;
  // Reject `*` and `?` in the base — cursor may treat them as wildcards, which
  // would convert frink's narrow `Bash(*:*)` rule into a tool-wide auto-approve
  // on cursor's side. Real command names never contain these characters.
  if (base.includes('*') || base.includes('?')) return null;

  return `Shell(${base})`;
}

/**
 * Add a Shell(...) entry to .cursor/cli.json derived from a v2 rule string.
 * No-op if the rule has no lossless cursor representation.
 */
export async function addBashRuleToCursorConfig(
  projectPath: string,
  ruleString: string,
): Promise<void> {
  const shellToken = ruleStringToCursorToken(ruleString);
  if (!shellToken) {
    log.debug(`[Cursor Config] Skipping unmappable rule: ${ruleString}`);
    return;
  }

  const config = await readCursorConfig(projectPath);
  if (config.permissions.allow.includes(shellToken)) {
    log.info(`[Cursor Config] Rule already allowed: ${shellToken}`);
    return;
  }

  config.permissions.allow.push(shellToken);
  await writeCursorConfig(projectPath, config);
}

/**
 * Remove the Shell(...) entry derived from a v2 rule string. No-op when the
 * file is missing, the rule is unmappable, or the token isn't present.
 */
export async function removeBashRuleFromCursorConfig(
  projectPath: string,
  ruleString: string,
): Promise<void> {
  const shellToken = ruleStringToCursorToken(ruleString);
  if (!shellToken) return;

  const configPath = getCursorConfigPath(projectPath);
  if (!existsSync(configPath)) return;

  const config = await readCursorConfig(projectPath);
  const next = config.permissions.allow.filter((t) => t !== shellToken);
  if (next.length === config.permissions.allow.length) return; // no change

  config.permissions.allow = next;
  await writeCursorConfig(projectPath, config);
}
