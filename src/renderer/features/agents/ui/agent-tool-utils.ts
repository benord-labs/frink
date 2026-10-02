import { shallow } from 'zustand/shallow';
import { TERMINAL_TOOL_PART_STATES } from '../../../../shared/types/assistant-message';
import type { MessagePart } from '../stores/message-store';

/** Safely get a string from a tool output object (e.g. stdout, stderr, output). */
export function getOutputString(output: Record<string, unknown> | undefined, key: string): string {
  if (!output) return '';
  const value = output[key];
  return typeof value === 'string' ? value : '';
}

/** Safely get a number from a tool output object, trying multiple keys (e.g. exitCode, exit_code). */
export function getOutputNumber(
  output: Record<string, unknown> | undefined,
  ...keys: string[]
): number | undefined {
  if (!output) return undefined;
  for (const key of keys) {
    const value = output[key];
    if (typeof value === 'number') return value;
  }
  return undefined;
}

/**
 * Compare two part objects by their significant fields.
 * Returns true if they are equal.
 *
 * `input`/`output` are compared one level deep (`zustand/shallow`), never serialised: both part
 * producers (the AI SDK `Chat` state and the shared assistant-parts reducer) replace those
 * payloads wholesale and the message store re-copies `input` on every sync, so top-level value
 * identity is the change signal. Serialising a multi-MB tool output per memo compare was an
 * out-of-memory path.
 *
 * NOTE: Do NOT use a module-level cache here. React 18 Concurrent Mode can
 * call memo comparators multiple times for the same pending render (if a
 * render is interrupted and restarted). A cache with side effects would be
 * updated on the first call and then report "no change" on the second call
 * for the same data, silently skipping re-renders (e.g. thinking tokens
 * stop streaming after the first few).
 */
function arePartsEqual(prev: MessagePart, next: MessagePart): boolean {
  if (prev.toolCallId !== next.toolCallId) return false;
  if (prev.type !== next.type) return false;

  if (!prev.toolCallId) {
    return prev.state === next.state;
  }

  return (
    prev.state === next.state &&
    shallow(prev.input, next.input) &&
    shallow(prev.output, next.output)
  );
}

/**
 * Whether a tool call is over. Completed tools don't need to react to chatStatus changes, so the
 * memo comparator can ignore that prop for them.
 */
function isToolCompleted(part: MessagePart): boolean {
  return part.output != null || TERMINAL_TOOL_PART_STATES.has(part.state ?? '');
}

/**
 * Memo comparator for tool part props.
 * Used with React.memo() to prevent unnecessary re-renders when
 * parent component re-renders but the tool's actual data hasn't changed.
 *
 * This is critical for streaming performance - when ai-sdk updates messages,
 * it creates new object references for all parts, but most parts haven't
 * actually changed. This comparator checks the actual values.
 *
 * OPTIMIZATION: Completed tools don't re-render on chatStatus changes.
 */
export function areToolPropsEqual(
  prevProps: { part: MessagePart; chatStatus?: string; subChatId?: string },
  nextProps: { part: MessagePart; chatStatus?: string; subChatId?: string },
): boolean {
  // A card whose message moved to another sub-chat must read from that sub-chat.
  if (prevProps.subChatId !== nextProps.subChatId) return false;
  // First check if the tool data itself changed
  const partsEqual = arePartsEqual(prevProps.part, nextProps.part);

  if (!partsEqual) return false;

  // If tool is completed, it doesn't care about chatStatus changes
  if (isToolCompleted(nextProps.part)) {
    return true;
  }

  // For pending tools, chatStatus matters (determines spinner vs completed)
  if (prevProps.chatStatus !== nextProps.chatStatus) return false;

  return true;
}

/**
 * Compare function for AgentExploringGroup which has parts array.
 */
export function areExploringGroupPropsEqual(
  prevProps: { parts: MessagePart[]; chatStatus?: string; isStreaming: boolean },
  nextProps: { parts: MessagePart[]; chatStatus?: string; isStreaming: boolean },
): boolean {
  const prevParts = prevProps.parts || [];
  const nextParts = nextProps.parts || [];

  if (prevParts.length !== nextParts.length) return false;

  for (let i = 0; i < prevParts.length; i++) {
    if (!arePartsEqual(prevParts[i], nextParts[i])) return false;
  }

  // If all parts are completed, don't care about chatStatus or isStreaming
  const allCompleted = nextParts.every(isToolCompleted);
  if (allCompleted) {
    return true;
  }

  // For pending groups, these matter
  if (prevProps.chatStatus !== nextProps.chatStatus) return false;
  if (prevProps.isStreaming !== nextProps.isStreaming) return false;

  return true;
}

/**
 * Check if a file path is a plan file.
 * Plan files are stored in the claude-sessions directory under /plans/
 */
export function isPlanFile(filePath: string): boolean {
  // Check for official plan location in claude-sessions
  if (filePath.includes('claude-sessions') && filePath.includes('/plans/')) {
    return true;
  }
  // Also check for plan files by name pattern (for backwards compatibility)
  const fileName = filePath.split('/').pop()?.toLowerCase() || '';
  if (fileName.includes('plan') && fileName.endsWith('.md')) {
    return true;
  }
  return false;
}

/**
 * Compare function for AgentAskUserQuestionTool which has different props structure.
 * Uses direct prev vs next comparison (pure — no side-effect caches).
 */
export function areAskUserQuestionPropsEqual(
  prevProps: {
    input: Record<string, unknown>;
    result?: unknown;
    errorText?: string;
    state: string;
    isError?: boolean;
    isStreaming?: boolean;
    toolCallId?: string;
  },
  nextProps: {
    input: Record<string, unknown>;
    result?: unknown;
    errorText?: string;
    state: string;
    isError?: boolean;
    isStreaming?: boolean;
    toolCallId?: string;
  },
): boolean {
  if (prevProps.toolCallId !== nextProps.toolCallId) return false;

  if (!nextProps.toolCallId) {
    return prevProps.state === nextProps.state;
  }

  if (
    prevProps.state !== nextProps.state ||
    prevProps.isError !== nextProps.isError ||
    prevProps.errorText !== nextProps.errorText ||
    JSON.stringify(prevProps.input ?? {}) !== JSON.stringify(nextProps.input ?? {}) ||
    JSON.stringify(prevProps.result ?? {}) !== JSON.stringify(nextProps.result ?? {})
  ) {
    return false;
  }

  // If tool has result, it's completed - don't care about isStreaming
  if (nextProps.result !== undefined) {
    return true;
  }

  // For pending state, isStreaming matters
  if (prevProps.isStreaming !== nextProps.isStreaming) return false;

  return true;
}
