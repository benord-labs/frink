/**
 * Classify rules in a ScopeSection bucket into tool families: Bash / file ops
 * / MCP (sub-grouped by server) / other. Purely presentational — the
 * underlying storage stays a flat array per `RuleType`.
 *
 * Used by Settings → Permissions to render rules in family-tab UI (sc-731).
 * MCP server name is derived via `parseMcpToolFullName` and works for both
 * exact rules (`mcp__server__tool`) and wildcards (`mcp__server__*`).
 */

import { PATH_TOOLS, type PermissionsDoc, type RuleType } from '../types/permissions';
import { parseMcpToolFullName } from './mcp-tool-name';
import { parseRule } from './rule-parser';

export type RuleFamily = 'bash' | 'file' | 'mcp' | 'other';

export function classifyRule(ruleString: string): { family: RuleFamily; server?: string } {
  const parsed = parseRule(ruleString);
  if ('error' in parsed) return { family: 'other' };
  if (parsed.tool === 'Bash') return { family: 'bash' };
  if (PATH_TOOLS.has(parsed.tool)) return { family: 'file' };
  if (parsed.tool.startsWith('mcp__')) {
    // Bare `mcp__server` (no suffix) is rejected by parseRule today, so this
    // branch only fires when there's a `__<tool>` or `__*` suffix.
    const mcp = parseMcpToolFullName(parsed.tool);
    if (!mcp) return { family: 'other' };
    return { family: 'mcp', server: mcp.serverName };
  }
  return { family: 'other' };
}

export type FamilyTabBucket = { allow: string[]; deny: string[]; ask: string[] };
export type FamilyTab = {
  /** Stable id ('bash', 'file', 'mcp', 'other'). */
  key: string;
  /** Display label ('Bash', 'File ops', 'MCP', 'Other'). */
  label: string;
  /** Rules of this family split by RuleType. */
  bucket: FamilyTabBucket;
};

/** A tab that always renders regardless of whether the scope has matching rules. */
export type RequiredTab = { key: string; label: string };

/**
 * Families shown in every scope so the family-tab row is identical across
 * Project / User / Policy sections — an empty one renders an empty state rather
 * than vanishing. All MCP rules group under a single "MCP" tab (servers are
 * shown per-rule inside), so the tab row stays fixed regardless of which
 * servers a scope references.
 */
export const BASE_REQUIRED_TABS: readonly RequiredTab[] = [
  { key: 'bash', label: 'Bash' },
  { key: 'file', label: 'File ops' },
  { key: 'mcp', label: 'MCP' },
];

const TYPE_ORDER: readonly RuleType[] = ['allow', 'deny', 'ask'];

/**
 * Build the ordered tab list for a ScopeSection. Order: Bash, File ops, MCP
 * (all servers grouped), Other.
 *
 * `required` tabs are always present (with possibly-empty buckets); other
 * families appear only when the doc has matching rules. Pass `[]` (default) to
 * get tabs strictly for the families present in `doc`.
 */
export function buildFamilyTabs(
  doc: PermissionsDoc,
  required: readonly RequiredTab[] = [],
): FamilyTab[] {
  const tabs = new Map<string, FamilyTab>();
  const ensure = (key: string, label: string): FamilyTab => {
    let tab = tabs.get(key);
    if (!tab) {
      tab = { key, label, bucket: { allow: [], deny: [], ask: [] } };
      tabs.set(key, tab);
    }
    return tab;
  };
  // Seed always-on tabs first so they keep their canonical leading order and
  // render even when the scope has no rules of that family.
  for (const { key, label } of required) ensure(key, label);
  for (const type of TYPE_ORDER) {
    for (const rule of doc[type]) {
      const { family } = classifyRule(rule);
      if (family === 'mcp') ensure('mcp', 'MCP').bucket[type].push(rule);
      else if (family === 'bash') ensure('bash', 'Bash').bucket[type].push(rule);
      else if (family === 'file') ensure('file', 'File ops').bucket[type].push(rule);
      else ensure('other', 'Other').bucket[type].push(rule);
    }
  }
  const ordered: FamilyTab[] = [];
  for (const key of ['bash', 'file', 'mcp', 'other']) {
    const tab = tabs.get(key);
    if (tab) ordered.push(tab);
  }
  return ordered;
}
