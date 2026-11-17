import * as path from 'node:path';
import { normalizePathSlashes } from '../../../../shared/lib/path-normalization';

/** IDE config directories that trigger discovery notifications.
 *  Note: .cursor/mcp.json is excluded — MCP has its own auto-import pipeline (`runMcpImporter`). */
const IDE_CONFIG_PATTERNS = [
  '.cursor/agents/',
  '.cursor/skills/',
  '.cursor/commands/',
  '.cursor/hooks/',
  '.claude/agents/',
  '.claude/skills/',
  '.claude/commands/',
  '.claude/hooks/',
];

const TRAILING_SLASH_RE = /\/$/;

/** The IDE config pattern `filePath` falls under within `worktreePath`, or null. */
export function findIdeConfigPattern(worktreePath: string, filePath: string): string | null {
  const relPath = normalizePathSlashes(path.relative(worktreePath, filePath));
  for (const pattern of IDE_CONFIG_PATTERNS) {
    if (relPath.startsWith(pattern) || relPath === pattern.replace(TRAILING_SLASH_RE, '')) {
      return pattern;
    }
  }
  return null;
}
