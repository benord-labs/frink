/* eslint-disable max-lines, max-lines-per-function */

import { Button } from '@benord-labs/frink-primitives';
import { useSetAtom } from 'jotai';
import { ChevronsUpDown, Check, ClipboardList } from 'lucide-react';
import { memo, useEffect, useMemo, useState } from 'react';
import { TextShimmer } from '../../../components/ui/text-shimmer';
import { cn } from '../../../lib/utils';
import { currentTaskToolsAtomFamily } from '../atoms';
import type { MessagePart } from '../stores/message-store';
import { StickyToolList } from './StickyToolList';
import { getToolStatus } from './agent-tool-registry';

/**
 * Format a task subject with its ID prefix.
 * Returns "1. Subject" format for consistent display across the app.
 *
 * @param taskId - The task ID (usually a number as string)
 * @param subject - The task subject/title
 * @returns Formatted string like "1. Subject"
 */
function formatTaskSubject(taskId: string, subject: string): string {
  return `${taskId}. ${subject}`;
}

// ============================================================================
// Types
// ============================================================================

type TaskChange = {
  id: string;
  subject: string;
  description?: string;
  activeForm?: string;
  changeType: 'created' | 'status_changed' | 'updated' | 'deleted';
  oldStatus?: 'pending' | 'in_progress' | 'completed';
  newStatus?: 'pending' | 'in_progress' | 'completed';
  updatedFields?: string[];
  blockedByIds?: string[];
  blocksIds?: string[];
};

// Full task state at a point in time (for snapshot history)
type TaskSnapshot = {
  id: string;
  subject: string;
  description?: string;
  activeForm?: string;
  status: 'pending' | 'in_progress' | 'completed';
  blockedBy?: string[];
  blocks?: string[];
};

// ============================================================================
// Task Snapshot History Cache
// ============================================================================

// Snapshots keyed by groupKey (first toolCallId of each group)
// Map<subChatId, Map<groupKey, Map<taskId, TaskSnapshot>>>
// Each entry is the snapshot AFTER that group was applied
const snapshotHistoryCache = new Map<string, Map<string, Map<string, TaskSnapshot>>>();

// Track group order to find "previous" snapshot
// Map<subChatId, groupKey[]>
const groupOrderCache = new Map<string, string[]>();

/**
 * Clear cached task snapshots for a specific subchat.
 * Call this when a subchat is closed/unmounted to prevent memory leaks.
 */
export function clearTaskSnapshotCache(subChatId: string) {
  snapshotHistoryCache.delete(subChatId);
  groupOrderCache.delete(subChatId);
}

// Task info for read-only display (TaskList, TaskGet)
type TaskInfo = {
  id: string;
  subject: string;
  rawSubject?: string; // Unformatted subject for headers
  description?: string;
  status: 'pending' | 'in_progress' | 'completed';
  blockedBy?: string[];
  blocks?: string[];
  owner?: string;
};

// Tool output shapes (MessagePart.output is Record<string, unknown>)
type TaskOutputShape = {
  id?: string;
  subject?: string;
  description?: string;
  activeForm?: string;
  status?: 'pending' | 'in_progress' | 'completed';
  blockedBy?: string[];
  blocks?: string[];
  owner?: string;
};
type StatusChangeShape = {
  from?: 'pending' | 'in_progress' | 'completed';
  to?: 'pending' | 'in_progress' | 'completed';
};

type AgentTaskToolsGroupProps = {
  parts: MessagePart[];
  chatStatus?: string;
  isStreaming: boolean;
  subChatId: string;
};

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Merge arrays for dependency updates (adds new items to existing)
 */
function mergeArrays(existing?: string[], toAdd?: string[]): string[] | undefined {
  if (!existing && !toAdd) return undefined;
  const result = new Set([...(existing || []), ...(toAdd || [])]);
  return result.size > 0 ? Array.from(result) : undefined;
}

/**
 * Build/update task snapshot from parts
 * Incrementally updates the snapshot with data from the current group
 * Only processes TaskCreate and TaskUpdate - these are the source of truth for task state.
 * TaskList/TaskGet are read operations that don't add new state information.
 */
function updateTaskSnapshotFromParts(
  parts: MessagePart[],
  existingSnapshot: Map<string, TaskSnapshot>,
): Map<string, TaskSnapshot> {
  const tasks = new Map(existingSnapshot);

  for (const part of parts) {
    // Skip streaming parts
    if (part?.state === 'input-streaming') continue;

    // TaskCreate - add new task with pending status
    if (part?.type === 'tool-TaskCreate') {
      const outTask = part.output?.task as TaskOutputShape | undefined;
      const id = outTask?.id;
      if (id) {
        const input = part.input ?? {};
        tasks.set(id, {
          id,
          subject: (input.subject as string | undefined) ?? 'Task',
          description: input.description as string | undefined,
          activeForm: input.activeForm as string | undefined,
          status: 'pending',
        });
      }
    }

    // TaskUpdate - update existing task
    if (part?.type === 'tool-TaskUpdate') {
      const taskId = part.input?.taskId as string | undefined;
      if (!taskId) continue;

      if ((part.input?.status as string) === 'deleted') {
        tasks.delete(taskId);
        continue;
      }

      const existing = tasks.get(taskId);
      const statusChange = part.output?.statusChange as StatusChangeShape | undefined;
      const input = part.input ?? {};

      tasks.set(taskId, {
        id: taskId,
        subject: (input.subject as string | undefined) ?? existing?.subject ?? `Task #${taskId}`,
        description: (input.description as string | undefined) ?? existing?.description,
        activeForm: (input.activeForm as string | undefined) ?? existing?.activeForm,
        status:
          statusChange?.to ??
          (input.status as 'pending' | 'in_progress' | 'completed' | undefined) ??
          existing?.status ??
          'pending',
        blockedBy: mergeArrays(existing?.blockedBy, input.addBlockedBy as string[] | undefined),
        blocks: mergeArrays(existing?.blocks, input.addBlocks as string[] | undefined),
      });
    }

    // TaskList - update snapshot with all listed tasks (authoritative source of truth)
    if (part?.type === 'tool-TaskList' && Array.isArray(part.output?.tasks)) {
      const taskListOutput = part.output.tasks as TaskOutputShape[];
      for (const task of taskListOutput) {
        const id = task.id;
        if (id) {
          const existing = tasks.get(id);
          tasks.set(id, {
            id,
            subject: task.subject ?? 'Task',
            description: task.description ?? existing?.description,
            activeForm: task.activeForm ?? existing?.activeForm, // Preserve UI-only field
            status: task.status ?? 'pending',
            blockedBy: task.blockedBy,
            blocks: task.blocks,
          });
        }
      }
    }

    // TaskGet - update snapshot with the retrieved task (authoritative source of truth)
    if (part?.type === 'tool-TaskGet' && part.output?.task) {
      const task = part.output.task as TaskOutputShape;
      const id = task.id;
      if (id) {
        const existing = tasks.get(id);
        tasks.set(id, {
          id,
          subject: task.subject ?? 'Task',
          description: task.description ?? existing?.description,
          activeForm: task.activeForm ?? existing?.activeForm, // Preserve UI-only field
          status: task.status ?? 'pending',
          blockedBy: task.blockedBy,
          blocks: task.blocks,
        });
      }
    }
  }

  return tasks;
}

/**
 * Sort helper for task IDs - sorts numerically when possible, falls back to string comparison
 */
function compareTaskIds(a: string, b: string): number {
  const numA = parseInt(a, 10);
  const numB = parseInt(b, 10);
  if (!Number.isNaN(numA) && !Number.isNaN(numB)) {
    return numA - numB;
  }
  return a.localeCompare(b);
}

type ExtractedChanges = {
  changes: TaskChange[];
  taskSubjects: Map<string, string>;
};

type ExtractedReadData = {
  taskList: TaskInfo[] | null; // From TaskList
  taskGet: TaskInfo | null; // From TaskGet
};

/**
 * Extract changes from parts array - only shows what ACTUALLY changed in this group
 * Does NOT build a full task list - just the diffs
 * Also returns taskSubjects map for resolving dependency names within this group
 *
 * @param snapshotSubjects - Optional map of task subjects from snapshot history (for cross-group resolution)
 */
function extractChangesFromParts(
  parts: MessagePart[],
  snapshotSubjects?: Map<string, string>,
): ExtractedChanges {
  if (!parts || !Array.isArray(parts)) return { changes: [], taskSubjects: new Map() };

  const changes: TaskChange[] = [];
  const seenTaskIds = new Set<string>();

  // Collect task subjects - start with snapshot data, then override with current group's TaskCreate
  // Only TaskCreate is needed here - it's the source of truth for task subjects.
  // TaskList/TaskGet are read operations that don't provide new subject information.
  const taskSubjects = new Map<string, string>();

  // Start with snapshot subjects (cross-group data) if available
  if (snapshotSubjects) {
    for (const [id, subject] of snapshotSubjects) {
      taskSubjects.set(id, subject);
    }
  }

  // Then override with TaskCreate from current group's parts (more recent/accurate)
  for (const part of parts) {
    if (part?.type === 'tool-TaskCreate') {
      const outTask = part.output?.task as TaskOutputShape | undefined;
      const id = outTask?.id;
      const subject = part.input?.subject as string | undefined;
      if (id && subject) {
        taskSubjects.set(id, formatTaskSubject(id, subject));
      }
    }

    // Also collect subjects from TaskList (provides task data for dependency resolution)
    if (part?.type === 'tool-TaskList' && Array.isArray(part.output?.tasks)) {
      const taskListOutput = part.output.tasks as TaskOutputShape[];
      for (const task of taskListOutput) {
        const id = task.id;
        const subject = task.subject;
        if (id && subject) {
          taskSubjects.set(id, formatTaskSubject(id, subject));
        }
      }
    }

    // Also collect subject from TaskGet (provides task data for the retrieved task)
    if (part?.type === 'tool-TaskGet' && part.output?.task) {
      const task = part.output.task as TaskOutputShape;
      const id = task.id;
      const subject = task.subject;
      if (id && subject) {
        taskSubjects.set(id, formatTaskSubject(id, subject));
      }
    }
  }

  for (const part of parts) {
    if (!part) continue;

    // --- TaskCreate ---
    if (part.type === 'tool-TaskCreate') {
      const outTask = part.output?.task as TaskOutputShape | undefined;
      const id = outTask?.id;

      // Skip if no ID yet (still streaming)
      if (!id) continue;

      // Avoid duplicates
      if (seenTaskIds.has(id)) continue;
      seenTaskIds.add(id);

      const input = part.input ?? {};
      const rawSubject = (input.subject as string | undefined) ?? 'Task';
      const formattedSubject = formatTaskSubject(id, rawSubject);

      changes.push({
        id,
        subject: formattedSubject,
        description: input.description as string | undefined,
        activeForm: input.activeForm as string | undefined,
        changeType: 'created',
        newStatus: 'pending',
      });
    }

    // --- TaskUpdate ---
    if (part.type === 'tool-TaskUpdate') {
      const taskId = part.input?.taskId as string | undefined;
      if (!taskId) continue;

      const input = part.input ?? {};
      // Get subject from input (with prefix), or lookup from taskSubjects (includes snapshot data), or fallback
      const inputSubject = input.subject as string | undefined;
      const subject = inputSubject
        ? formatTaskSubject(taskId, inputSubject)
        : (taskSubjects.get(taskId) ?? formatTaskSubject(taskId, `Task #${taskId}`));

      // Check if this task was already in our changes (e.g., created then updated in same group)
      const existingIdx = changes.findIndex((c) => c.id === taskId);

      if ((input.status as string) === 'deleted') {
        if (existingIdx !== -1) {
          // Created then deleted in same group - just remove it
          changes.splice(existingIdx, 1);
        } else {
          changes.push({
            id: taskId,
            subject,
            changeType: 'deleted',
          });
        }
        continue;
      }

      // Collect all changes from this update
      const statusChange = part.output?.statusChange as StatusChangeShape | undefined;
      const updatedFields = (part.output?.updatedFields as string[] | undefined) ?? [];
      const blockedBy = input.addBlockedBy as string[] | undefined;
      const blocks = input.addBlocks as string[] | undefined;

      // If no existing entry, create one
      if (existingIdx === -1) {
        // Check if this is a status change - either from output.statusChange or input.status
        const inputStatus = input.status as string | undefined;
        const isStatusChange = statusChange || (inputStatus && inputStatus !== 'deleted');

        const newChange: TaskChange = {
          id: taskId,
          subject,
          changeType: isStatusChange ? 'status_changed' : 'updated',
        };
        if (statusChange) {
          newChange.oldStatus = statusChange.from;
          newChange.newStatus = statusChange.to;
        } else if (inputStatus && inputStatus !== 'deleted') {
          // Fallback to input status when API doesn't return statusChange
          newChange.newStatus = inputStatus as 'pending' | 'in_progress' | 'completed';
        }
        if (updatedFields.length > 0) {
          newChange.updatedFields = updatedFields;
        }
        if (blockedBy) newChange.blockedByIds = blockedBy;
        if (blocks) newChange.blocksIds = blocks;

        changes.push(newChange);
      } else {
        // Update existing entry
        const existing = changes[existingIdx];

        // Handle status change
        if (statusChange) {
          existing.newStatus = statusChange.to;
          if (existing.changeType !== 'created') {
            existing.changeType = 'status_changed';
            existing.oldStatus = statusChange.from;
          }
        }

        // Merge updated fields
        if (updatedFields.length > 0) {
          existing.updatedFields = [...(existing.updatedFields || []), ...updatedFields];
        }

        // Add dependency info
        if (blockedBy) existing.blockedByIds = blockedBy;
        if (blocks) existing.blocksIds = blocks;
      }
    }

    // TaskList and TaskGet are handled separately for read-only display
  }

  return { changes, taskSubjects };
}

/**
 * Extract read-only task data from TaskList and TaskGet parts
 */
function extractReadDataFromParts(parts: MessagePart[]): ExtractedReadData {
  if (!parts || !Array.isArray(parts)) return { taskList: null, taskGet: null };

  let taskList: TaskInfo[] | null = null;
  let taskGet: TaskInfo | null = null;

  for (const part of parts) {
    if (!part) continue;

    // TaskList - extract all tasks
    if (part.type === 'tool-TaskList' && Array.isArray(part.output?.tasks)) {
      const tasks = part.output.tasks as TaskOutputShape[];
      taskList = tasks.map((task: TaskOutputShape) => {
        const id = task.id ?? '';
        const rawSubject = task.subject ?? 'Task';
        return {
          id,
          subject: id ? formatTaskSubject(id, rawSubject) : rawSubject,
          description: task.description,
          status: task.status ?? 'pending',
          blockedBy: task.blockedBy,
          blocks: task.blocks,
          owner: task.owner,
        };
      });
    }

    // TaskGet - extract single task
    if (part.type === 'tool-TaskGet' && part.output?.task) {
      const task = part.output.task as TaskOutputShape;
      const id = task.id ?? '';
      const rawSubject = task.subject ?? 'Task';
      taskGet = {
        id,
        subject: id ? formatTaskSubject(id, rawSubject) : rawSubject,
        rawSubject,
        description: task.description,
        status: task.status ?? 'pending',
        blockedBy: task.blockedBy,
        blocks: task.blocks,
        owner: task.owner,
      };
    }
  }

  return { taskList, taskGet };
}

/**
 * Get human-readable description of the change
 * Returns null for "created" since header already says "Created X tasks"
 */
function getChangeDescription(change: TaskChange): string | null {
  switch (change.changeType) {
    case 'created':
      return null; // Header already says "Created X tasks"
    case 'deleted':
      return 'Deleted';
    case 'status_changed':
      if (change.newStatus === 'in_progress') return 'Started';
      if (change.newStatus === 'completed') return 'Completed';
      if (change.newStatus === 'pending') return 'Reset to pending';
      return 'Updated';
    case 'updated':
      // For dependency updates, we'll show the details in the component
      if (change.updatedFields?.includes('blockedBy') || change.updatedFields?.includes('blocks')) {
        return null; // Details shown separately
      }
      return 'Updated';
    default:
      return 'Changed';
  }
}

// ============================================================================
// In Progress Icon - pie segment style (matches older todo list)
// ============================================================================

const InProgressIcon = ({ size = 14 }: { size?: number }) => {
  const cx = size / 2;
  const cy = size / 2;
  const outerRadius = (size - 1) / 2;
  const innerRadius = outerRadius - 1.5;

  // Single filled segment (like 1/4 pie)
  const startAngle = -90; // Start from top
  const endAngle = 0;

  const startRad = (startAngle * Math.PI) / 180;
  const endRad = (endAngle * Math.PI) / 180;

  const x1 = cx + innerRadius * Math.cos(startRad);
  const y1 = cy + innerRadius * Math.sin(startRad);
  const x2 = cx + innerRadius * Math.cos(endRad);
  const y2 = cy + innerRadius * Math.sin(endRad);

  const pathData = `M ${cx} ${cy} L ${x1} ${y1} A ${innerRadius} ${innerRadius} 0 0 1 ${x2} ${y2} Z`;

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className="text-muted-foreground shrink-0"
      role="img"
      aria-label="Task status"
    >
      {/* Outer border circle */}
      <circle
        cx={cx}
        cy={cy}
        r={outerRadius}
        fill="none"
        stroke="currentColor"
        strokeWidth={0.5}
        opacity={0.3}
      />
      {/* Filled segment */}
      <path d={pathData} fill="currentColor" opacity={0.7} />
    </svg>
  );
};

// ============================================================================
// Change Status Icon Component
// ============================================================================

const ChangeStatusIcon = ({ change }: { change: TaskChange }) => {
  // For status changes, show the new status icon
  if (change.changeType === 'status_changed' || change.changeType === 'created') {
    const status = change.newStatus ?? 'pending';

    switch (status) {
      case 'completed':
        return (
          <div
            className="w-3.5 h-3.5 rounded-full bg-muted flex items-center justify-center shrink-0"
            style={{ border: '0.5px solid hsl(var(--border))' }}
          >
            <Check className="w-2 h-2 text-muted-foreground" />
          </div>
        );
      case 'in_progress':
        return <InProgressIcon />;
      default:
        return (
          <div
            className="w-3.5 h-3.5 rounded-full flex items-center justify-center shrink-0"
            style={{ border: '1px solid hsl(var(--muted-foreground) / 0.3)' }}
          />
        );
    }
  }

  // For other changes (updated, deleted), show a neutral icon
  return (
    <div
      className="w-3.5 h-3.5 rounded-full flex items-center justify-center shrink-0"
      style={{ border: '1px solid hsl(var(--muted-foreground) / 0.3)' }}
    />
  );
};

// ============================================================================
// Task Status Icon (for read-only display)
// ============================================================================

const TaskStatusIcon = ({ status }: { status: 'pending' | 'in_progress' | 'completed' }) => {
  switch (status) {
    case 'completed':
      return (
        <div
          className="w-3.5 h-3.5 rounded-full bg-muted flex items-center justify-center shrink-0"
          style={{ border: '0.5px solid hsl(var(--border))' }}
        >
          <Check className="w-2 h-2 text-muted-foreground" />
        </div>
      );
    case 'in_progress':
      return <InProgressIcon />;
    default:
      return (
        <div
          className="w-3.5 h-3.5 rounded-full flex items-center justify-center shrink-0"
          style={{ border: '1px solid hsl(var(--muted-foreground) / 0.3)' }}
        />
      );
  }
};

// ============================================================================
// Blocking Tasks List (nested list of tasks that block this task)
// ============================================================================

const BlockingTasksList = memo(function BlockingTasksList({
  blockedByIds,
  taskSubjects,
  taskSnapshot,
}: {
  blockedByIds: string[];
  taskSubjects: Map<string, string>;
  taskSnapshot: Map<string, TaskSnapshot>;
}) {
  if (!blockedByIds || blockedByIds.length === 0) return null;

  // Sort by task ID for consistent order
  const sortedIds = [...blockedByIds].sort(compareTaskIds);

  return (
    <div className="mt-2 space-y-1.5">
      {sortedIds.map((id) => {
        const subject = taskSubjects.get(id) ?? `#${id}`;
        // Get actual status from snapshot, fallback to pending
        const status = taskSnapshot.get(id)?.status ?? 'pending';

        return (
          <div key={id} className="flex items-center gap-2">
            <TaskStatusIcon status={status} />
            <span className="text-xs text-muted-foreground/70">{subject}</span>
          </div>
        );
      })}
    </div>
  );
});

// ============================================================================
// Task Info Item (for TaskList and TaskGet display)
// ============================================================================

const TaskInfoItem = memo(function TaskInfoItem({
  task,
  isLast,
  taskSubjects,
  taskSnapshot,
}: {
  task: TaskInfo;
  isLast: boolean;
  taskSubjects: Map<string, string>;
  taskSnapshot: Map<string, TaskSnapshot>;
}) {
  // Check if task has blockedBy dependencies
  const hasBlockedBy = task.blockedBy && task.blockedBy.length > 0;

  // Build "blocks" text (keep as text since it's less important)
  let blocksDesc: string | null = null;
  if (task.blocks && task.blocks.length > 0) {
    const deps = task.blocks.map((id) => taskSubjects.get(id) ?? `#${id}`).join(', ');
    blocksDesc = `blocks ${deps}`;
  }

  return (
    <div
      className={cn('flex items-start gap-2 px-2.5 py-2', !isLast && 'border-b border-border/30')}
    >
      <div className="h-4 flex items-center shrink-0">
        <TaskStatusIcon status={task.status} />
      </div>
      <div className="flex-1 min-w-0 flex flex-col">
        <span className="text-xs text-muted-foreground">{task.subject}</span>
        {hasBlockedBy && task.blockedBy && (
          <BlockingTasksList
            blockedByIds={task.blockedBy}
            taskSubjects={taskSubjects}
            taskSnapshot={taskSnapshot}
          />
        )}
        {blocksDesc && <p className="text-xs text-muted-foreground/70 mt-0.5">{blocksDesc}</p>}
        {task.owner && (
          <p className="text-xs text-muted-foreground/70 mt-0.5">owner: {task.owner}</p>
        )}
      </div>
    </div>
  );
});

// ============================================================================
// Change Item Component
// ============================================================================

const ChangeItem = memo(function ChangeItem({
  change,
  isLast,
  taskSubjects,
  taskSnapshot,
}: {
  change: TaskChange;
  isLast: boolean;
  taskSubjects: Map<string, string>;
  taskSnapshot: Map<string, TaskSnapshot>;
}) {
  const statusSuffix = getChangeDescription(change);
  const displayText =
    change.newStatus === 'in_progress' && change.activeForm ? change.activeForm : change.subject;

  // Check for blockedBy dependencies
  const hasBlockedBy = change.blockedByIds && change.blockedByIds.length > 0;

  // Build "blocks" text (keep as text since it's less important)
  let blocksDesc: string | null = null;
  if (change.blocksIds && change.blocksIds.length > 0) {
    const deps = change.blocksIds.map((id) => taskSubjects.get(id) ?? `#${id}`).join(', ');
    blocksDesc = `blocks ${deps}`;
  }

  return (
    <div
      className={cn('flex items-start gap-2 px-2.5 py-2', !isLast && 'border-b border-border/30')}
    >
      <div className="h-4 flex items-center shrink-0">
        <ChangeStatusIcon change={change} />
      </div>
      <div className="flex-1 min-w-0 flex flex-col">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-xs text-muted-foreground">{displayText}</span>
          {statusSuffix && <span className="text-xs text-muted-foreground/60">{statusSuffix}</span>}
        </div>
        {change.description && change.changeType === 'created' && (
          <p className="text-xs text-muted-foreground/70 mt-0.5 line-clamp-2">
            {change.description}
          </p>
        )}
        {hasBlockedBy && change.blockedByIds && (
          <BlockingTasksList
            blockedByIds={change.blockedByIds}
            taskSubjects={taskSubjects}
            taskSnapshot={taskSnapshot}
          />
        )}
        {blocksDesc && <p className="text-xs text-muted-foreground/70 mt-0.5">{blocksDesc}</p>}
      </div>
    </div>
  );
});

// ============================================================================
// Main Component
// ============================================================================

export const AgentTaskToolsGroup = memo(function AgentTaskToolsGroup({
  parts,
  chatStatus,
  isStreaming,
  subChatId,
}: AgentTaskToolsGroupProps) {
  // Build snapshots using linear history
  // Each group gets its own snapshot keyed by groupKey (first toolCallId)
  // previousSnapshot = state before this group, currentSnapshot = state after
  const { previousSnapshot, currentSnapshot } = useMemo(() => {
    const emptySnapshot = new Map<string, TaskSnapshot>();

    if (!subChatId) {
      return { previousSnapshot: emptySnapshot, currentSnapshot: emptySnapshot };
    }

    const groupKey = parts[0]?.toolCallId ?? '';
    if (!groupKey) {
      return { previousSnapshot: emptySnapshot, currentSnapshot: emptySnapshot };
    }

    // Get or create caches for this subChat
    let historyMap = snapshotHistoryCache.get(subChatId);
    if (!historyMap) {
      historyMap = new Map();
      snapshotHistoryCache.set(subChatId, historyMap);
    }

    let groupOrder = groupOrderCache.get(subChatId);
    if (!groupOrder) {
      groupOrder = [];
      groupOrderCache.set(subChatId, groupOrder);
    }

    // Find previous snapshot based on group order
    let previousSnapshot = emptySnapshot;
    const groupIndex = groupOrder.indexOf(groupKey);

    if (groupIndex > 0) {
      // This group exists in order, get the one before it
      const prevGroupKey = groupOrder[groupIndex - 1];
      previousSnapshot = historyMap.get(prevGroupKey) ?? emptySnapshot;
    } else if (groupIndex === -1 && groupOrder.length > 0) {
      // New group, use the last group's snapshot as previous
      const lastGroupKey = groupOrder[groupOrder.length - 1];
      previousSnapshot = historyMap.get(lastGroupKey) ?? emptySnapshot;
    }

    // Build current snapshot from previous + this group's parts
    const currentSnapshot = updateTaskSnapshotFromParts(parts, previousSnapshot);

    // Store in history
    historyMap.set(groupKey, currentSnapshot);

    // Add to order if not present
    if (groupIndex === -1) {
      groupOrder.push(groupKey);
    }

    return { previousSnapshot, currentSnapshot };
  }, [parts, subChatId]);

  // Sync the FULL accumulated task snapshot to Jotai atom for details sidebar.
  // We read the last group's snapshot from the cache (which accumulates all previous groups)
  // instead of syncing each group's partial snapshot, avoiding race conditions
  // where intermediate groups overwrite the full state.
  const taskToolsAtom = useMemo(
    () => currentTaskToolsAtomFamily(subChatId || 'default'),
    [subChatId],
  );
  const setTaskToolsState = useSetAtom(taskToolsAtom);

  useEffect(() => {
    if (!currentSnapshot) return;
    if (!subChatId) return;

    // Get the full accumulated snapshot: last group in the order has all tasks
    const groupOrder = groupOrderCache.get(subChatId);
    const historyMap = snapshotHistoryCache.get(subChatId);
    if (!groupOrder || !historyMap || groupOrder.length === 0) return;

    const lastGroupKey = groupOrder[groupOrder.length - 1];
    const fullSnapshot = historyMap.get(lastGroupKey);
    if (!fullSnapshot || fullSnapshot.size === 0) return;

    const tasks = Array.from(fullSnapshot.values()).map((snap) => ({
      id: snap.id,
      subject: snap.subject,
      description: snap.description,
      activeForm: snap.activeForm,
      status: snap.status,
    }));
    // Sort by ID for consistent order
    tasks.sort((a, b) => {
      const numA = parseInt(a.id, 10);
      const numB = parseInt(b.id, 10);
      if (!Number.isNaN(numA) && !Number.isNaN(numB)) return numA - numB;
      return a.id.localeCompare(b.id);
    });
    setTaskToolsState({ tasks });
  }, [currentSnapshot, subChatId, setTaskToolsState]);

  // Build snapshot subjects map for cross-group task name resolution
  // This needs to be computed BEFORE extractChangesFromParts so it can be passed in
  const snapshotSubjects = useMemo(() => {
    const subjects = new Map<string, string>();

    // Add from previous snapshot (tasks created before this group)
    for (const [id, task] of previousSnapshot) {
      subjects.set(id, formatTaskSubject(id, task.subject));
    }

    // Add from current snapshot (includes this group's new tasks from updateTaskSnapshotFromParts)
    for (const [id, task] of currentSnapshot) {
      subjects.set(id, formatTaskSubject(id, task.subject));
    }

    return subjects;
  }, [previousSnapshot, currentSnapshot]);

  // Extract changes and task subjects from this group
  // Pass snapshotSubjects for cross-group task name resolution
  const { changes, taskSubjects } = useMemo(
    () => extractChangesFromParts(parts, snapshotSubjects),
    [parts, snapshotSubjects],
  );

  // Enhanced taskSubjects: merge snapshot subjects with current group's extracted data
  const enhancedTaskSubjects = useMemo(() => {
    const subjects = new Map(snapshotSubjects);

    // Override with current group's extracted data (most accurate)
    for (const [id, subject] of taskSubjects) {
      subjects.set(id, subject);
    }

    return subjects;
  }, [snapshotSubjects, taskSubjects]);

  // Extract read-only data from TaskList and TaskGet
  const { taskList, taskGet } = useMemo(() => extractReadDataFromParts(parts), [parts]);

  // Check if any part is still pending (for shimmer effects)
  const anyPending = useMemo(() => {
    return parts.some((part) => {
      const { isPending } = getToolStatus(part, chatStatus);
      return isPending;
    });
  }, [parts, chatStatus]);

  // Determine what to show
  const hasChanges = changes.length > 0;
  const hasTaskList = taskList !== null && taskList.length > 0;
  const hasTaskGet = taskGet !== null;
  const hasAnything = hasChanges || hasTaskList || hasTaskGet;

  // Read-only data (TaskList/TaskGet) should be collapsed by default
  const isReadOnly = !hasChanges && (hasTaskList || hasTaskGet);
  const [isExpanded, setIsExpanded] = useState(false);

  // If no data, return null or loading state
  if (!hasAnything) {
    if (isStreaming || anyPending) {
      return (
        <div className="mx-2">
          <div className="rounded-lg border border-border bg-muted/30 px-2.5 py-1.5">
            <div className="flex items-center gap-1.5">
              <ClipboardList className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
              <span className="text-xs font-medium whitespace-nowrap shrink-0">
                <TextShimmer
                  as="span"
                  duration={1.2}
                  className="inline-flex items-center text-xs leading-none h-4 m-0"
                >
                  Updating tasks...
                </TextShimmer>
              </span>
            </div>
          </div>
        </div>
      );
    }
    return null;
  }

  // Generate header text based on what we're showing
  let headerText = 'Tasks';

  if (hasChanges) {
    // Count changes by type for header
    const createdCount = changes.filter((c) => c.changeType === 'created').length;
    const completedCount = changes.filter((c) => c.newStatus === 'completed').length;
    const startedCount = changes.filter((c) => c.newStatus === 'in_progress').length;

    if (createdCount > 0 && createdCount === changes.length) {
      headerText = `Created ${createdCount} task${createdCount > 1 ? 's' : ''}`;
    } else if (completedCount > 0 && completedCount === changes.length) {
      headerText = `Completed ${completedCount} task${completedCount > 1 ? 's' : ''}`;
    } else if (startedCount > 0 && startedCount === changes.length) {
      headerText = `Started ${startedCount} task${startedCount > 1 ? 's' : ''}`;
    } else {
      headerText = `${changes.length} task update${changes.length > 1 ? 's' : ''}`;
    }
  } else if (hasTaskList && taskList) {
    const taskCount = taskList.length;
    headerText = `List ${taskCount} task${taskCount > 1 ? 's' : ''}`;
  } else if (hasTaskGet && taskGet) {
    // For TaskGet, we'll use a custom header with bold "Read task" prefix
    // The headerText will be used as a flag to trigger special rendering
    headerText = `__TASK_GET__${taskGet.id}__${taskGet.rawSubject ?? taskGet.subject}`;
  }

  // Determine items to render
  // Priority: changes > taskList > taskGet
  // If we have changes, show changes. Otherwise show read data.
  // Always sort by task ID for consistent display order
  const itemsToRender: Array<{ type: 'change' | 'task'; data: TaskChange | TaskInfo }> = [];

  if (hasChanges) {
    // Sort changes by task ID
    const sortedChanges = [...changes].sort((a, b) => compareTaskIds(a.id, b.id));
    for (const change of sortedChanges) {
      itemsToRender.push({ type: 'change', data: change });
    }
  } else if (hasTaskList && taskList) {
    // Sort task list by task ID
    const sortedTasks = [...taskList].sort((a, b) => compareTaskIds(a.id, b.id));
    for (const task of sortedTasks) {
      itemsToRender.push({ type: 'task', data: task });
    }
  } else if (hasTaskGet && taskGet) {
    itemsToRender.push({ type: 'task', data: taskGet });
  }

  return (
    <StickyToolList sticky={isStreaming}>
      {/* Header */}
      {isReadOnly ? (
        // fallow-ignore-next-line code-duplication
        <Button
          variant="ghost"
          size="auto"
          className={cn(
            'w-full justify-start text-left font-normal',
            'border border-border bg-muted/30 px-2.5 py-1.5 stuck:glass-float',
            !isExpanded ? 'rounded-lg' : 'rounded-t-lg border-b-0',
          )}
          onClick={() => setIsExpanded(!isExpanded)}
          aria-expanded={isExpanded}
        >
          <div className="flex items-center gap-1.5">
            <ClipboardList className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
            {headerText.startsWith('__TASK_GET__') ? (
              <span className="text-xs flex-1">
                <span className="font-medium text-foreground">Read task</span>
                <span className="text-muted-foreground ml-1">
                  {(() => {
                    const parts = headerText.replace('__TASK_GET__', '').split('__');
                    const taskId = parts[0];
                    const taskSubject = parts.slice(1).join('__');
                    return `${taskId}. ${taskSubject}`;
                  })()}
                </span>
              </span>
            ) : (
              <span className="text-xs font-medium text-foreground flex-1">{headerText}</span>
            )}
            {isReadOnly && (
              <ChevronsUpDown className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
            )}
          </div>
        </Button>
      ) : (
        <div
          className={cn(
            'border border-border bg-muted/30 px-2.5 py-1.5 stuck:glass-float',
            'rounded-t-lg border-b-0',
          )}
        >
          <div className="flex items-center gap-1.5">
            <ClipboardList className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
            {headerText.startsWith('__TASK_GET__') ? (
              <span className="text-xs flex-1">
                <span className="font-medium text-foreground">Read task</span>
                <span className="text-muted-foreground ml-1">
                  {(() => {
                    const parts = headerText.replace('__TASK_GET__', '').split('__');
                    const taskId = parts[0];
                    const taskSubject = parts.slice(1).join('__');
                    return `${taskId}. ${taskSubject}`;
                  })()}
                </span>
              </span>
            ) : (
              <span className="text-xs font-medium text-foreground flex-1">{headerText}</span>
            )}
          </div>
        </div>
      )}

      {/* Items list */}
      {(!isReadOnly || isExpanded) && (
        <div className="rounded-b-lg border border-border bg-muted/20 shadow-xl shadow-background max-h-[400px] overflow-y-auto stuck:glass-float stuck:shadow-none">
          {itemsToRender.map((item, idx) => {
            const isLast = idx === itemsToRender.length - 1;
            if (item.type === 'change') {
              const change = item.data as TaskChange;
              return (
                <ChangeItem
                  key={`${change.id}-${change.changeType}`}
                  change={change}
                  isLast={isLast}
                  taskSubjects={enhancedTaskSubjects}
                  taskSnapshot={currentSnapshot}
                />
              );
            } else {
              const task = item.data as TaskInfo;
              return (
                <TaskInfoItem
                  key={`task-${task.id}`}
                  task={task}
                  isLast={isLast}
                  taskSubjects={enhancedTaskSubjects}
                  taskSnapshot={currentSnapshot}
                />
              );
            }
          })}
        </div>
      )}
    </StickyToolList>
  );
});
