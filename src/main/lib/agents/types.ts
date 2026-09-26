/**
 * Type definitions for Frink Agents/Skills/Hooks Management
 *
 * Manages custom agents, skills, and hooks with project-specific scoping,
 * similar to MCP architecture but for markdown-based extensions.
 */

/**
 * Resource type classification
 */
export type AgentResourceType = 'agent' | 'skill' | 'hook';

/**
 * Source of the agent/skill/hook
 */
export type AgentSource = 'cursor' | 'claude-code' | 'frink';

/**
 * A single discovered agent/skill/hook, as surfaced on a row.
 */
type FrinkAgentEntry = {
  /** Display name */
  name: string;
  /** Type of resource */
  type: AgentResourceType;
  /** Source where this was imported from */
  source: AgentSource;
  /** Absolute path to the file */
  path: string;
  /** Description from frontmatter */
  description?: string;
  /** Whether this agent/skill is enabled */
  enabled: boolean;
};

/**
 * Aggregated agent info for UI display
 */
export type AgentInfo = {
  /** Resource name */
  name: string;
  /** Resource type */
  type: AgentResourceType;
  /** Configuration */
  config: FrinkAgentEntry;
  /** Whether it's enabled */
  enabled: boolean;
  /** Scope of this resource */
  scope: 'global' | 'project';
  /** Project path if scope is 'project' */
  projectPath?: string;
  /** File path */
  path: string;
  /** Description */
  description?: string;
  /** Which CLI type "owns" this resource (for project-scoped resources) */
  cliType?: 'cursor' | 'claude-code';
  /** Frink-shipped first-party asset (carries a `.baseline.json`) — read-only, auto-restores. */
  builtIn?: boolean;
  /**
   * True when EVERY configured tool can READ a copy of this resource (per the source-verified read-map:
   * Claude reads `.claude`, Cursor reads `.cursor`/`.agents`/`.claude`). The ONE "Follows you" promise;
   * when false it's a gap (a tool here can't see it). Hooks never bridge → always false.
   */
  followsYou?: boolean;
  /**
   * The subset of the user's configured tools that CAN read this resource — names the gap ("Only in
   * Cursor") when `followsYou` is false. Tool identity, not a dir.
   */
  readableBy?: CliType[];
  /**
   * The user-TOOL dir(s) this logical resource was scanned from (the universal `.agents` home and Frink's
   * internal `.frink` home excluded) — kept to reach every copy in the expanded row.
   */
  sources?: { source: AgentSource; path: string }[];
};

// ============================================================================
// Constants
// ============================================================================

/**
 * IDE directory names in priority order (highest priority first).
 * Used across all resource scanners for consistent discovery order.
 */
export const IDE_DIRS_PRIORITY = ['.frink', '.claude', '.cursor'] as const;

/**
 * The universal cross-tool skills home (read by Cursor/opencode/Codex/Gemini; the bridge byte-copies
 * here + into `.claude`). Presence here is the "follows you across tools" marker — it is NOT a tool of
 * its own, so it is scanned for the follows-you signal but never rendered as a per-tool source.
 */
export const UNIVERSAL_DIR = '.agents';

/** Whether a path lives in the universal `~/.agents` home (the follows-you marker). */
export function isUniversalPath(filePath: string): boolean {
  return filePath.includes(`/${UNIVERSAL_DIR}/`) || filePath.includes(`\\${UNIVERSAL_DIR}\\`);
}

/**
 * Derive AgentSource from a file's absolute path.
 * Checks which IDE directory the path belongs to.
 */
export function deriveSourceFromPath(filePath: string): AgentSource {
  if (filePath.includes('/.cursor/') || filePath.includes('\\.cursor\\')) return 'cursor';
  if (filePath.includes('/.claude/') || filePath.includes('\\.claude\\')) return 'claude-code';
  if (filePath.includes('/.frink/') || filePath.includes('\\.frink\\')) return 'frink';
  if (process.env.NODE_ENV === 'development') {
    const basename = filePath.split('/').pop() || filePath.split('\\').pop() || '(unknown)';
    // biome-ignore lint/suspicious/noConsole: intentional dev-only warning for debugging unrecognized paths
    console.warn(`[deriveSourceFromPath] Unrecognized IDE directory for file: ${basename}`);
  }
  return 'claude-code'; // Fallback for unknown paths
}

/** CLI type as stored in credentials */
export type CliType = 'cursor' | 'claude-code';

/**
 * Get IDE directory names in priority order based on the project's active CLI type.
 * - Cursor projects: .cursor first (what the CLI actually reads)
 * - Claude Code projects: .claude first
 * - No project / unknown: .frink first (backward compat for globals)
 */
export function getIdeDirPriority(cliType?: CliType): readonly string[] {
  switch (cliType) {
    case 'cursor':
      return ['.cursor', '.claude', '.frink'] as const;
    case 'claude-code':
      return ['.claude', '.cursor', '.frink'] as const;
    default:
      return IDE_DIRS_PRIORITY;
  }
}
