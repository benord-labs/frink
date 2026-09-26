/**
 * Copy for the at-switch "what changes" toast (sc-840 / PCH-7b). Fired when a
 * user switches the coding tool behind their work (per-project or workspace
 * default). Leads with what followed them, then the two honest deltas.
 *
 * The deltas mirror the "What follows you" table in user-docs/portable-across-tools.md
 * (the Tool-limits row) + the cross-family model reset (CROSS_FLAVOR_OMIT) — that doc
 * is the reference; this is its prose form for the transient toast. Keep in sync by
 * hand (one short string per verified tool: claude-code, codex).
 */

import { toast } from 'sonner';

type ToolType = 'claude-code' | 'codex';

const TOOL_LABEL: Record<ToolType, string> = {
  'claude-code': 'Claude',
  codex: 'OpenAI',
};

const SWITCH_DESCRIPTION: Record<ToolType, string> = {
  'claude-code':
    "Your MCP servers, skills, commands & agents came with you. Two things change: agent tool limits are now fully enforced (exact per-tool rules), and agent models reset to Claude's default.",
  // Codex runs through the app-server with the permission gate enforcing exact
  // per-tool rules, like Claude — so no advisory caveat.
  codex:
    "Your MCP servers, skills, commands & agents came with you. Two things change: agent tool limits are now fully enforced (exact per-tool rules), and agent models reset to OpenAI's default.",
};

/**
 * The at-switch toast title + description, or `null` when there is no tool change
 * to announce (same tool, or the new tool is unknown — the caller then shows its
 * plain fallback toast). A `null` resolved old type means the workspace default
 * (Claude Code).
 */
export function describeToolSwitch(
  oldType: ToolType | null | undefined,
  newType: ToolType | null | undefined,
): { title: string; description: string } | null {
  if (!newType) return null;
  const from = oldType ?? 'claude-code';
  if (from === newType) return null;
  return {
    title: `Now running on ${TOOL_LABEL[newType]}`,
    description: SWITCH_DESCRIPTION[newType],
  };
}

/**
 * Fire the at-switch toast: the "what changed" message when the tool actually
 * changed, otherwise the caller's plain `fallback`. Shared by both switch
 * surfaces (the header AccountIndicator and Settings → AccountsList) so the
 * toast shape stays identical.
 */
export function notifyToolSwitch(
  oldType: ToolType | null | undefined,
  newType: ToolType | null | undefined,
  fallback: string,
): void {
  const message = describeToolSwitch(oldType, newType);
  if (message) {
    // 12s: the ~35-word description needs a comfortable single-pass read (sonner
    // also pauses on hover/focus); plain fallbacks use the default duration.
    toast.success(message.title, { description: message.description, duration: 12000 });
  } else {
    toast.success(fallback);
  }
}
