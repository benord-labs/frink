/**
 * Semantic validator for permission rule strings.
 *
 * `parseRule` (sibling) only validates the grammar — it accepts any identifier
 * shape including typos like `r`, lowercase `read`, or fabricated `xyz`. The
 * runtime matcher is case-sensitive (`rule-matcher.ts:50`), so non-canonical
 * tool names produce dead rules: stored, visible in Settings, never fire.
 *
 * This module adds the second layer: after grammar, check the tool name
 * against the canonical `KNOWN_TOOLS` set or the `mcp__*` open prefix. Return
 * a human-readable error message on miss, with a "did you mean `Read`?"
 * suggestion when the user mis-cased a real tool.
 *
 * Pure. No I/O. Importable from both renderer and main.
 */

import { KNOWN_TOOLS, REQUIRED_TOOLS, type RuleType } from '../types/permissions';
import { parseRule } from './rule-parser';

export type RuleValidation = { ok: true } | { ok: false; message: string };

/**
 * `Array.from(KNOWN_TOOLS)` cached at module init so the case-suggestion lookup
 * doesn't reallocate per call. Tool count is small (<20); linear scan is fine.
 */
const KNOWN_TOOLS_ARRAY: readonly string[] = Array.from(KNOWN_TOOLS);

function suggestKnownCase(toolName: string): string | undefined {
  const lower = toolName.toLowerCase();
  return KNOWN_TOOLS_ARRAY.find((known) => known.toLowerCase() === lower);
}

export function validateRuleString(rule: string, ruleType?: RuleType): RuleValidation {
  const trimmed = rule.trim();
  if (!trimmed) {
    return { ok: false, message: 'Rule cannot be empty.' };
  }

  const parsed = parseRule(trimmed);
  if ('error' in parsed) {
    return { ok: false, message: parsed.error };
  }

  // Guard against bricking the agent: a deny rule on tools the agent depends
  // on (planner exit, todo tracking, subagent dispatch) silently breaks core
  // flows. Allow + ask still work — users can scope or gate, just not deny.
  if (ruleType === 'deny' && REQUIRED_TOOLS.has(parsed.tool)) {
    return {
      ok: false,
      message: `"${parsed.tool}" is required for the agent to function — deny rules are not allowed for this tool. Use \`ask\` if you want a prompt every time.`,
    };
  }

  // MCP tools are open — any name matching `mcp__*` is permitted (the parser's
  // regex already enforces shape). No registry check.
  if (parsed.tool.startsWith('mcp__')) {
    return { ok: true };
  }

  if (KNOWN_TOOLS.has(parsed.tool)) {
    return { ok: true };
  }

  const suggestion = suggestKnownCase(parsed.tool);
  if (suggestion) {
    const replacement =
      parsed.content !== undefined
        ? `${suggestion}(${rule.slice(parsed.tool.length + 1)}`
        : suggestion;
    return {
      ok: false,
      message: `Unknown tool "${parsed.tool}". Did you mean \`${replacement.split('(')[0]}\`? Tool names are case-sensitive.`,
    };
  }

  return {
    ok: false,
    message: `Unknown tool "${parsed.tool}". Try \`Read\`, \`Write\`, \`Bash(npm:*)\`, or \`mcp__*\`. See permissions docs for the full list.`,
  };
}
