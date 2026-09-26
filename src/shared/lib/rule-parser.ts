/**
 * Rule grammar parser. Pure function, no I/O.
 *
 * Grammar:
 *   rule         := tool | tool '(' content ')'
 *   tool         := regular-tool | mcp-server ('__*' | '__' mcp-tool | '__' mcp-resource-method)
 *   content      := non-empty string with backslash escapes for ( and )
 *
 * MCP server + tool segments allow `-` because `.mcp.json` server keys are
 * conventionally hyphenated (`shortcut-frink`, `figma-mcp`). The suffix is
 * REQUIRED — bare `mcp__shortcut` is silent-dead at the matcher (never matches)
 * so we reject it at parse to force `mcp__shortcut__*` or an exact tool.
 *
 * Examples:
 *   Bash                              → { tool: 'Bash' }
 *   Bash(npm:*)                       → { tool: 'Bash', content: 'npm:*' }
 *   Bash(echo \(\))                   → { tool: 'Bash', content: 'echo ()' }
 *   mcp__shortcut__*                  → { tool: 'mcp__shortcut__*' }
 *   mcp__shortcut__create_story       → { tool: 'mcp__shortcut__create_story' }
 *   mcp__shortcut-frink__stories-list → { tool: 'mcp__shortcut-frink__stories-list' }
 *   mcp__context7__resources/read      → { tool: 'mcp__context7__resources/read' }
 *
 * Ticket 02 (`docs/frink/todos/permissions-overhaul/02-rule-grammar-matcher.md`).
 */

import type { ParsedRule } from '../types/permissions';

const REGULAR_TOOL_REGEX = /^[A-Za-z][A-Za-z0-9_]*$/;
// Server and tool segments must start AND end with alphanumeric; hyphens/
// underscores only allowed between alphanumerics. Rejects boundary chars like
// `mcp__-shortcut__tool` and `mcp__shortcut__tool-` which would otherwise pass
// a naive `[A-Za-z0-9_-]+` and never match a real server (security review,
// `api-security-reviewer` 2026-05-25).
const MCP_SEGMENT = '[A-Za-z0-9](?:[A-Za-z0-9_-]*[A-Za-z0-9])?';
const MCP_RESOURCE_METHOD = 'resources/(?:read|list|templates/list)';
const MCP_TOOL_REGEX = new RegExp(
  `^mcp__${MCP_SEGMENT}(?:__\\*|__(?:${MCP_SEGMENT}|${MCP_RESOURCE_METHOD}))$`,
);

function isValidToolName(name: string): boolean {
  // Names starting with `mcp__` must follow the MCP grammar strictly; the
  // regular regex would otherwise accept "mcp__" (no server segment) because
  // underscores are in `[A-Za-z0-9_]*`.
  return name.startsWith('mcp__') ? MCP_TOOL_REGEX.test(name) : REGULAR_TOOL_REGEX.test(name);
}

/**
 * Memoise parsed rules — same hot-path argument as the picomatch cache in
 * `rule-matcher.ts`. Rule strings are user-authored, but the validator at
 * `validate-rule.ts` runs on every keystroke `onBlur` and ruleType change,
 * so the input set can grow per session. Cap with a FIFO evict (Map
 * iteration order = insertion order) to prevent unbounded growth under
 * sustained unique input.
 */
export const PARSE_CACHE_MAX = 200;
const PARSE_CACHE = new Map<string, ParsedRule>();

export function parseRule(rule: string): ParsedRule {
  const cached = PARSE_CACHE.get(rule);
  if (cached) return cached;
  const result = parseRuleUncached(rule);
  if (PARSE_CACHE.size >= PARSE_CACHE_MAX) {
    // FIFO eviction: drop the oldest entry. Hot-path rules are re-parsed
    // each tool call so they'll be re-cached immediately; cold one-off
    // typos from the validator should be the ones to fall out.
    const oldest = PARSE_CACHE.keys().next().value;
    if (oldest !== undefined) PARSE_CACHE.delete(oldest);
  }
  PARSE_CACHE.set(rule, result);
  return result;
}

/**
 * Escape rule content for embedding in `Tool(content)`: the parser reads `)`
 * as end-of-content, so `node -e "console.log(1)"` must become `\(`/`\)`.
 */
export function escapeRuleContent(content: string): string {
  return content.replace(/[()]/g, '\\$&');
}

/** Test/maintenance helper: drop all cached parses. */
export function clearParseCache(): void {
  PARSE_CACHE.clear();
}

/** Test/maintenance helper: current cache occupancy. */
export function parseCacheSize(): number {
  return PARSE_CACHE.size;
}

function parseRuleUncached(rule: string): ParsedRule {
  if (!rule) return { error: 'empty rule' };

  let state: 'tool' | 'content' | 'after-content' = 'tool';
  let toolBuf = '';
  let contentBuf = '';
  let escapeNext = false;

  for (let i = 0; i < rule.length; i++) {
    const ch = rule[i];

    if (state === 'after-content') {
      return { error: `trailing characters after ')' at index ${i}` };
    }

    if (escapeNext) {
      // Only ( and ) are escapable. Other `\X` sequences pass through verbatim
      // (preserve the backslash) — keeps `Bash(echo \\n)` content as `echo \n`.
      const target = state === 'content' ? 'content' : 'tool';
      const append = ch === '(' || ch === ')' ? ch : `\\${ch}`;
      if (target === 'content') contentBuf += append;
      else toolBuf += append;
      escapeNext = false;
      continue;
    }

    if (ch === '\\') {
      escapeNext = true;
      continue;
    }

    if (state === 'tool') {
      if (ch === '(') {
        if (!toolBuf) return { error: 'empty tool name' };
        if (!isValidToolName(toolBuf)) return { error: `invalid tool name "${toolBuf}"` };
        state = 'content';
        continue;
      }
      if (ch === ')') return { error: `unexpected ')' at index ${i}` };
      toolBuf += ch;
      continue;
    }

    // state === 'content'
    if (ch === ')') {
      state = 'after-content';
      continue;
    }
    contentBuf += ch;
  }

  if (escapeNext) return { error: 'trailing escape' };

  if (state === 'tool') {
    if (!isValidToolName(toolBuf)) return { error: `invalid tool name "${toolBuf}"` };
    return { tool: toolBuf };
  }

  if (state === 'content') return { error: "unmatched '('" };

  // state === 'after-content'
  if (!contentBuf) return { error: 'empty content' };
  if (!isValidToolName(toolBuf)) return { error: `invalid tool name "${toolBuf}"` };
  // MCP wildcard tools (`mcp__server__*`) cannot have content — they're already
  // a wildcard. Allowing it produces dead rules the matcher always rejects.
  if (toolBuf.endsWith('__*')) return { error: 'MCP wildcard tool cannot have content' };
  return { tool: toolBuf, content: contentBuf };
}
