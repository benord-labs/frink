import { formatMcpToolName, parseMcpToolFullName } from '../../../../shared/lib/mcp-tool-name';
import { appStore } from '../../../lib/jotai-store';
import { type Message, type MessagePart, messageAtomFamily } from '../stores/message-store';

/**
 * Detects external integration WRITES recorded in chat turns, so rollback can warn that
 * reverting Frink's chat/code won't undo changes already made in Shortcut/Slack/etc.
 *
 * Scope is intentionally limited to MCP integration tools (`tool-mcp__<server>__<action>`):
 * shell (`run_command`/bash) and http_request writes are NOT reliably detectable, so they are
 * never flagged — the warn is an honest safety net, not a guarantee.
 */

const TOOL_PART_PREFIX = 'tool-';
const TOKEN_SPLIT_RE = /[_-]+/;

// A tool whose action name contains one of these verbs (as a token) is treated as a write.
// Read verbs (list/get/search/...) are excluded by omission. Matching on tokens — not a prefix —
// is required because real tool names carry the verb as a SUFFIX (`stories-update`, `stories-create-comment`).
const WRITE_VERBS = new Set([
  'create',
  'update',
  'delete',
  'remove',
  'add',
  'set',
  'post',
  'send',
  'complete',
  'assign',
  'unassign',
  'move',
  'merge',
  'archive',
  'close',
  'upload',
]);

export type ExternalSideEffect = { tool: string; label: string };

function externalWriteForPart(part: MessagePart): ExternalSideEffect | null {
  if (!part.type.startsWith(`${TOOL_PART_PREFIX}mcp__`)) return null;
  // Only successfully-executed writes count — a failed/aborted mutation changed nothing.
  if (part.state !== 'output-available' || part.output?.success === false) return null;

  const parsed = parseMcpToolFullName(part.type.slice(TOOL_PART_PREFIX.length));
  if (!parsed) return null;

  const tokens = parsed.toolName.toLowerCase().split(TOKEN_SPLIT_RE);
  if (!tokens.some((token) => WRITE_VERBS.has(token))) return null;

  return { tool: part.type, label: `${parsed.serverName}: ${formatMcpToolName(parsed.toolName)}` };
}

/** External integration writes performed within a single message's parts. */
export function externalSideEffectsForMessage(msg: Message): ExternalSideEffect[] {
  if (!msg.parts) return [];
  const out: ExternalSideEffect[] = [];
  for (const part of msg.parts) {
    const hit = externalWriteForPart(part);
    if (hit) out.push(hit);
  }
  return out;
}

/**
 * External writes in the range that a rollback to `fromUserMsgId` would discard
 * (that message through the end of the chat). De-duplicated by label for display.
 */
export function detectExternalSideEffects(
  orderedMsgIds: string[],
  fromUserMsgId: string,
): ExternalSideEffect[] {
  const start = orderedMsgIds.indexOf(fromUserMsgId);
  if (start === -1) return [];

  const seen = new Set<string>();
  const out: ExternalSideEffect[] = [];
  for (let i = start; i < orderedMsgIds.length; i++) {
    const msg = appStore.get(messageAtomFamily(orderedMsgIds[i]));
    if (!msg) continue;
    for (const effect of externalSideEffectsForMessage(msg)) {
      if (seen.has(effect.label)) continue;
      seen.add(effect.label);
      out.push(effect);
    }
  }
  return out;
}
