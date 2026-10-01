/**
 * Rule matcher. Pure function — no I/O, no shell parsing, no FS access.
 *
 * The caller (ticket 03 bash parser; ticket 05 dispatcher) supplies
 * pre-computed signatures and resolved paths via `MatchContext`.
 *
 * Ticket 02 (`docs/frink/todos/permissions-overhaul/02-rule-grammar-matcher.md`).
 */

import picomatch from 'picomatch';
import { parseRule } from '../../../../shared/lib/rule-parser';
import { PATH_TOOLS } from '../../../../shared/types/permissions';
import { signaturesMatchPattern } from '../command-parser';
import type { BashCommandSignature, MatchContext } from './types';

/**
 * Memoise compiled picomatch matchers — the dispatcher (ticket 05) calls
 * `matchesRule` once per rule per tool call, so the same content is compiled
 * many times. Cache is unbounded by design: rule sets are small (<200 rules
 * per profile per claude-code precedent) and the cache key is the rule's
 * CONTENT pattern (e.g. `src/foo/**`, `npm:*`) — only stored rules feed this
 * cache, NOT validator keystrokes. `validate-rule.ts` only calls `parseRule`
 * (which has its own bounded cache), never `matchesRule`. Bounded by stored
 * rule count, not request volume.
 */
const PICOMATCH_CACHE = new Map<string, ReturnType<typeof picomatch>>();

function getMatcher(pattern: string): ReturnType<typeof picomatch> {
  let cached = PICOMATCH_CACHE.get(pattern);
  if (!cached) {
    cached = picomatch(pattern, { dot: true });
    PICOMATCH_CACHE.set(pattern, cached);
  }
  return cached;
}

function matchesMcpWildcard(
  parsedTool: string,
  toolName: string,
  identity: MatchContext['mcpIdentity'],
): boolean {
  const prefix = parsedTool.slice(0, -1);
  const ruleServer = parsedTool.slice('mcp__'.length, -'__*'.length);
  return identity ? identity.server === ruleServer : toolName.startsWith(prefix);
}

function matchesCanonicalMcpIdentity(
  parsedTool: string,
  identity: NonNullable<MatchContext['mcpIdentity']>,
): boolean {
  if (identity.server.includes('__') || identity.tool.includes('__')) return false;
  return parsedTool === `mcp__${identity.server}__${identity.tool}`;
}

export function matchesRule(
  rule: string,
  toolName: string,
  toolInput: unknown,
  context?: MatchContext,
): boolean {
  const parsed = parseRule(rule);
  if ('error' in parsed) return false;

  // MCP wildcard: rule `mcp__shortcut__*` matches `mcp__shortcut__<anything>`.
  if (parsed.tool.endsWith('__*')) {
    return (
      parsed.content === undefined &&
      matchesMcpWildcard(parsed.tool, toolName, context?.mcpIdentity)
    );
  }

  if (context?.mcpIdentity) {
    if (!matchesCanonicalMcpIdentity(parsed.tool, context.mcpIdentity)) return false;
  } else if (parsed.tool !== toolName) {
    return false;
  }
  if (parsed.content === undefined) return true; // tool-wide

  // `Edit(*)` / `Bash(*)` / etc. — bare star is tool-wide shortcut, not a glob.
  if (parsed.content === '*') return true;

  if (toolName === 'Bash') {
    return matchBashContent(parsed.content, context?.bashCommandSignature);
  }
  if (PATH_TOOLS.has(toolName)) {
    return matchPathContent(parsed.content, toolInput, context?.resolvedPath);
  }

  // Generic: literal string equality against `command` / `file_path` / etc.
  return parsed.content === stringifyInput(toolInput);
}

/**
 * Match a bash rule's content against a pre-parsed signature.
 *
 * Translates rule grammar (`:*`) → command-parser grammar (` *`) before
 * delegating to `signaturesMatchPattern`. The latter splits on space and
 * strips trailing ` *`; calling it with colon-star fails silently.
 *
 * Semantics: returns true if the signature matches. Compound commands
 * (`a && b`) get one signature each — the dispatcher (ticket 05) decides
 * whether all-must-match or any-match for the user-facing "approve" call.
 */
function matchBashContent(content: string, signature: BashCommandSignature | undefined): boolean {
  if (!signature) return false;

  // Translate trailing `:*` → ` *`. Only the trailing token uses the colon
  // delimiter; intermediate words stay separated by spaces in both grammars.
  const translated = content.endsWith(':*') ? `${content.slice(0, -2)} *` : content;

  if (translated.endsWith(' *')) {
    return signaturesMatchPattern(translated, [signature]);
  }
  return signature.fullSignature === content;
}

function matchPathContent(
  content: string,
  toolInput: unknown,
  resolvedPath: string | undefined,
): boolean {
  const target = resolvedPath ?? extractFilePath(toolInput);
  if (!target) return false;
  // picomatch uses POSIX glob grammar — forward slashes only. Rule strings are
  // authored in POSIX form (`Edit(src/**)`); targets may arrive with Windows
  // backslashes (`nodePath.relative` returns OS-native separators on Win32, and
  // raw tool inputs can carry absolute Windows paths). Normalize before match.
  const normalized = target.includes('\\') ? target.replace(/\\/g, '/') : target;
  return getMatcher(content)(normalized);
}

/**
 * Mirror of `extractFilePathFromToolInput` field chain (`file_path` → `file` → `path`)
 * from `tool-validation.ts`. Inlined here to keep the matcher pure (the source
 * helper transitively imports electron + DB).
 */
function extractFilePath(toolInput: unknown): string | undefined {
  if (!toolInput || typeof toolInput !== 'object') return undefined;
  const obj = toolInput as Record<string, unknown>;
  if (typeof obj.file_path === 'string') return obj.file_path;
  if (typeof obj.file === 'string') return obj.file;
  if (typeof obj.path === 'string') return obj.path;
  return undefined;
}

function stringifyInput(toolInput: unknown): string {
  if (toolInput == null) return '';
  if (typeof toolInput === 'string') return toolInput;
  if (typeof toolInput === 'object') {
    // Common tool-input shapes: { command }, { file_path }, etc. Fall back to JSON.
    const obj = toolInput as Record<string, unknown>;
    if (typeof obj.command === 'string') return obj.command;
    if (typeof obj.file_path === 'string') return obj.file_path;
    return JSON.stringify(toolInput);
  }
  return String(toolInput);
}
