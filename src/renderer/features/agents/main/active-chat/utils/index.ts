/**
 * Utility functions for active chat
 */

import type { MessagePart } from '../../../stores/message-store';
import { isSubagentTaskPart } from '../../../ui/agent-tool-registry';

export { isExecutionLevelFailure } from './execution-error-classification';
// Message helpers
export { copyMessageContent, hasUnapprovedPlan } from './message-helpers';
export { resolveAutoCompletionAction } from './task-completion-policy';
export {
  clearFlowRunEndedErrorSignal,
  createTaskExecutionErrorSignal,
} from './task-execution-error-signal';
export { getTaskRefetchInterval, invalidateTaskQueries } from './task-query';
export {
  accountGateRefetchInterval,
  ACCOUNT_NOT_READY_TOAST_MESSAGE_SEND,
  ACCOUNT_NOT_READY_TOAST_MESSAGE_START_CHAT,
  showAccountNotReadyToast,
  type UnauthAccountForSend,
} from './toasts';

/**
 * UTF-8 safe base64 encoding (btoa doesn't support Unicode)
 */
export const utf8ToBase64 = (str: string): string => {
  const bytes = new TextEncoder().encode(str);
  const binString = Array.from(bytes, (byte) => String.fromCodePoint(byte)).join('');
  return btoa(binString);
};

/**
 * Get the ID of the first sub-chat by creation date
 */
export const getFirstSubChatId = (
  subChats: Array<{ id: string; createdAt?: Date | string | null }> | undefined,
): string | null => {
  if (!subChats?.length) return null;
  const sorted = [...subChats].sort(
    (a, b) =>
      (a.createdAt ? new Date(a.createdAt).getTime() : 0) -
      (b.createdAt ? new Date(b.createdAt).getTime() : 0),
  );
  return sorted[0]?.id ?? null;
};

/** Read-only lookups that get grouped when run together. Exploring needs 3+; task tools group at 1. */
const EXPLORING_TOOLS = new Set([
  'tool-Read',
  'tool-Grep',
  'tool-Glob',
  'tool-WebSearch',
  'tool-WebFetch',
]);

const TASK_TOOLS = new Set(['tool-TaskCreate', 'tool-TaskUpdate', 'tool-TaskGet', 'tool-TaskList']);

export type ExploringGroup = { type: 'exploring-group'; parts: MessagePart[] };
export type TaskGroup = { type: 'task-group'; parts: MessagePart[] };

export function isExploringGroup(part: MessagePart | ExploringGroup): part is ExploringGroup {
  return part.type === 'exploring-group';
}

export function isTaskGroup(part: MessagePart | TaskGroup | ExploringGroup): part is TaskGroup {
  return part.type === 'task-group';
}

/** Group runs of 3+ consecutive exploring tools; shorter runs stay as individual parts. */
export function groupExploringTools(
  parts: MessagePart[],
  nestedToolIds: Set<string>,
): Array<MessagePart | ExploringGroup> {
  const result: Array<MessagePart | ExploringGroup> = [];
  let currentGroup: MessagePart[] = [];

  const flush = () => {
    if (currentGroup.length >= 3) result.push({ type: 'exploring-group', parts: currentGroup });
    else result.push(...currentGroup);
    currentGroup = [];
  };

  for (const part of parts) {
    // Nested tools render inside their parent card, so they never join a group.
    const isNested = part.toolCallId && nestedToolIds.has(part.toolCallId);
    if (EXPLORING_TOOLS.has(part.type) && !isNested) {
      currentGroup.push(part);
    } else {
      flush();
      result.push(part);
    }
  }
  flush();
  return result;
}

/** Same shape, threshold 1 — a lone task tool still renders as its own group card. */
export function groupTaskTools(
  parts: MessagePart[],
  nestedToolIds: Set<string>,
): Array<MessagePart | TaskGroup> {
  const result: Array<MessagePart | TaskGroup> = [];
  let currentGroup: MessagePart[] = [];

  const flush = () => {
    if (currentGroup.length >= 1) result.push({ type: 'task-group', parts: currentGroup });
    currentGroup = [];
  };

  for (const part of parts) {
    const isNested = part.toolCallId && nestedToolIds.has(part.toolCallId);
    if (TASK_TOOLS.has(part.type) && !isNested) {
      currentGroup.push(part);
    } else {
      flush();
      result.push(part);
    }
  }
  flush();
  return result;
}

/**
 * Group a message's parts into subagent parents and their nested children.
 *
 * A subagent's children (`tool-Task`/`tool-Agent`) arrive with a composite
 * `"<parentToolCallId>:<childId>"` toolCallId (built upstream from the SDK's
 * `parent_tool_use_id`). A part counts as nested only when the prefix before the
 * first `:` matches a subagent parent's toolCallId in THIS message — so a regular
 * tool whose id merely contains a colon is never swallowed, and parallel
 * subagents in one message keep their children in separate buckets.
 *
 * Grandchildren attribute to the TOP-level parent, so a sub-subagent's work renders flat under the
 * top card rather than as a true 2-level tree. They reach it two ways: an `a:b:c` id splits to `a`
 * directly, while a sub-Task dispatched mid-turn names only its immediate parent (`b:c`, because
 * upstream cannot resolve `b` to `a:b` without an id map that a wake burst would empty). The
 * last-segment lookup below closes that gap here, where the whole message is in hand.
 */
/** Hop limit when walking a subagent chain to its card — deeper than any real dispatch nests. */
const MAX_SUBAGENT_DEPTH = 8;

export function buildNestedToolsMap(parts: MessagePart[]): {
  nestedToolsMap: Map<string, MessagePart[]>;
  nestedToolIds: Set<string>;
} {
  const nestedToolsMap = new Map<string, MessagePart[]>();
  const nestedToolIds = new Set<string>();
  const taskPartIds = new Set(
    parts
      .filter((p: MessagePart) => isSubagentTaskPart(p) && p.toolCallId)
      .map((p) => p.toolCallId),
  );
  /** A nested subagent's own id (`a:b`) keyed by the raw id its children name it with (`b`). */
  const subTaskByRawId = new Map<string, string>();
  for (const taskId of taskPartIds) {
    if (!taskId?.includes(':')) continue;
    subTaskByRawId.set(taskId.slice(taskId.lastIndexOf(':') + 1), taskId);
  }

  for (const part of parts) {
    if (part.toolCallId?.includes(':')) {
      const parentId = resolveTopLevelTaskId(
        part.toolCallId.split(':')[0],
        taskPartIds,
        subTaskByRawId,
      );
      // Unresolvable stays visible in the timeline: hiding a part whose bucket no card reads would
      // delete it from the UI outright, which is worse than showing it in the wrong place.
      if (parentId) {
        const bucket = nestedToolsMap.get(parentId);
        if (bucket) bucket.push(part);
        else nestedToolsMap.set(parentId, [part]);
        nestedToolIds.add(part.toolCallId);
      }
    }
  }

  return { nestedToolsMap, nestedToolIds };
}

/**
 * Walk a part's parent chain up to the top-level card that actually renders it, or undefined when
 * the chain leads nowhere in this message. Chains are shallow, so the hop count is bounded rather
 * than relying on the ids to be acyclic.
 */
function resolveTopLevelTaskId(
  prefix: string,
  taskPartIds: Set<string | undefined>,
  subTaskByRawId: Map<string, string>,
): string | undefined {
  let current = prefix;
  for (let hop = 0; hop < MAX_SUBAGENT_DEPTH; hop++) {
    if (taskPartIds.has(current) && !current.includes(':')) return current;
    const owningTask = taskPartIds.has(current) ? current : subTaskByRawId.get(current);
    if (!owningTask) return undefined;
    current = owningTask.split(':')[0];
  }
  return undefined;
}
