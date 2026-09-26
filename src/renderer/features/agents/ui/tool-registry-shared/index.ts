import type React from 'react';
import type { TextShimmerVariant } from '../../../../components/ui/text-shimmer';
import { CODEX_SUBAGENT_TOOL_NAME } from '../../../../../shared/subagent-parts';
import type { MessagePart } from '../../stores/message-store';

/**
 * Types + value readers shared by agent-tool-registry.tsx and the per-surface entry modules split
 * out of it.
 *
 * They live here rather than in the registry because a split module importing them BACK from the
 * registry is a cycle: the registry spreads those modules into `AgentToolRegistry` at module init,
 * so a cycle leaves the spread reading an uninitialised binding and the entries silently vanish
 * from the map (caught by the MCP short-form routing test).
 */
/** Card layout for a tool part. Consumed only by {@link ToolMeta.variant}. */
type ToolVariant = 'simple' | 'collapsible';

export type ToolMeta = {
  icon: React.ComponentType<{ className?: string }>;
  title: (part: MessagePart) => string;
  subtitle?: (part: MessagePart) => string;
  /** When set, used instead of subtitle when full text should be shown (e.g. task card expanded). No truncation. */
  subtitleLong?: (part: MessagePart) => string;
  tooltipContent?: (part: MessagePart) => string;
  variant: ToolVariant;
  /** Pending title shimmer style; only `tool-planning` uses spectrum. */
  titleShimmerVariant?: TextShimmerVariant;
};

/** Safely extract a string value from a tool part's input. */
export function getStringValue(input: Record<string, unknown> | undefined, key: string): string {
  if (!input) return '';
  const value = input[key];
  return typeof value === 'string' ? value : '';
}

/** Safely extract a number value from a tool part's input. */
export function getNumberValue(input: Record<string, unknown> | undefined, key: string): number {
  if (!input) return 0;
  const value = input[key];
  return typeof value === 'number' ? value : 0;
}

const FLOW_ID_SUBTITLE_MAX = 8;

export function formatFlowIdForSubtitle(flowId: string): string {
  if (flowId.length === 0) return '';
  return flowId.length > FLOW_ID_SUBTITLE_MAX
    ? `${flowId.slice(0, FLOW_ID_SUBTITLE_MAX)}…`
    : flowId;
}

/** Directory names that usually mark the start of the interesting part of a repo path. */
const ROOT_INDICATORS = ['apps', 'packages', 'src', 'lib', 'components'];

/**
 * An absolute path re-rooted at the first recognised project directory, or null when there is no
 * such directory (callers apply their own fallback).
 *
 * Shared because two tool cards shorten paths the same way — the registry's generic card and the
 * Edit card — and had drifted into duplicate copies of this scan. They still differ in what they do
 * before and after it (the Edit card resolves worktree-relative paths first; the registry falls back
 * to the last few segments), so only the common step lives here.
 */
export function reRootAtProjectDir(filePath: string): string | null {
  if (!filePath.startsWith('/')) return null;
  const parts = filePath.split('/');
  const rootIndex = parts.findIndex((part: string) => ROOT_INDICATORS.includes(part));
  return rootIndex > 0 ? parts.slice(rootIndex).join('/') : null;
}

/** Any subagent tool part (renderer-side, regardless of input parse state). Input may be
 * partial/missing when the SDK stream truncates mid-field, so this check must stay
 * shape-agnostic — keyed off the tool identity only. Claude spawns subagents through its
 * Task/Agent tools; codex through its own collab protocol items, minted under a shared
 * pseudo-tool name so both providers land on the same card. */
export function isSubagentTaskPart(part: MessagePart): boolean {
  return (
    part.type === 'tool-Task' ||
    part.type === 'tool-Agent' ||
    part.type === `tool-${CODEX_SUBAGENT_TOOL_NAME}` ||
    part.toolName === 'Task' ||
    part.toolName === 'Agent' ||
    part.toolName === CODEX_SUBAGENT_TOOL_NAME
  );
}

/**
 * A part's lifecycle state. `data-*` parts keep theirs inside `data`: the SDK upserts a data part
 * by replacing that field alone, so a sibling top-level field would stay frozen at whatever the
 * opening chunk set and the card would never settle.
 */
export function partLifecycleState(part: MessagePart): string | undefined {
  const dataState = part.data?.state;
  return part.state ?? (dataState === undefined ? undefined : String(dataState));
}
