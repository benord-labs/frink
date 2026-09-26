/* eslint-disable max-lines, max-lines-per-function */

import { Button } from '@benord-labs/frink-primitives';
import { useAtom } from 'jotai';
import {
  Circle,
  Check,
  Minimize2,
  Maximize2,
  ArrowRight,
  ChevronsRight,
  Loader2,
  ClipboardList,
} from 'lucide-react';
import { memo, type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TextShimmer } from '../../../components/ui/text-shimmer';
import { cn } from '../../../lib/utils';
import { currentTodosAtomFamily } from '../atoms';
import { StickyToolList } from './StickyToolList';
import { AgentToolCall } from './agent-tool-call';
import { getToolStatus } from './agent-tool-registry';
import { areToolPropsEqual } from './agent-tool-utils';

// Style objects - hoisted to module level for performance
const BORDER_STYLE = { border: '0.5px solid hsl(var(--border))' } as const;

type TodoItem = {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm?: string;
};

type AgentTodoToolProps = {
  part: {
    type: string;
    toolCallId: string;
    state?: string;
    input?: {
      todos?: TodoItem[];
    };
    output?: {
      oldTodos?: TodoItem[];
      newTodos?: TodoItem[];
    };
  };
  chatStatus?: string;
  subChatId?: string; // Required for syncing todos across tool calls
};

type TodoChange = {
  todo: TodoItem;
  oldStatus?: TodoItem['status'];
  newStatus: TodoItem['status'];
  index: number;
};

type ChangeType = 'creation' | 'single' | 'multiple';

type DetectedChanges = {
  type: ChangeType;
  items: TodoChange[];
};

// Detect what changed between old and new todos
function detectChanges(oldTodos: TodoItem[], newTodos: TodoItem[]): DetectedChanges {
  // If no old todos, this is a creation - show full list ONCE
  if (!oldTodos || oldTodos.length === 0) {
    return {
      type: 'creation',
      items: newTodos.map((todo, index) => ({
        todo,
        newStatus: todo.status,
        index,
      })),
    };
  }

  // Find what changed
  const changes: TodoChange[] = [];
  newTodos.forEach((newTodo, index) => {
    const oldTodo = oldTodos[index];
    if (!oldTodo || oldTodo.status !== newTodo.status) {
      changes.push({
        todo: newTodo,
        oldStatus: oldTodo?.status,
        newStatus: newTodo.status,
        index,
      });
    }
  });

  // Single change - show compact mode
  if (changes.length === 1) return { type: 'single', items: changes };

  // Multiple changes - also show compact mode (not full list)
  // User can always expand the creation tool to see full plan
  return { type: 'multiple', items: changes };
}

// Get status verb for compact display
function getStatusVerb(status: TodoItem['status'], content: string): string {
  switch (status) {
    case 'in_progress':
      return `Started: ${content}`;
    case 'completed':
      return `Finished: ${content}`;
    case 'pending':
      return `Created: ${content}`;
    default:
      return content;
  }
}

// Get icon component for status
function _getStatusIconComponent(status: TodoItem['status']) {
  switch (status) {
    case 'completed':
      return Check;
    case 'in_progress':
      return Loader2;
    default:
      return Circle;
  }
}

// Pie-style progress circle - fills sectors like pizza slices
const ProgressCircle = ({
  completed,
  total,
  size = 16,
  className,
}: {
  completed: number;
  total: number;
  size?: number;
  className?: string;
}) => {
  const cx = size / 2;
  const cy = size / 2;
  const outerRadius = (size - 1) / 2;
  const innerRadius = outerRadius - 1.5; // Leave space for outer border

  // Create pie segments (no borders on segments, just fill)
  const segments: ReactElement[] = [];
  for (let i = 0; i < total; i++) {
    const startAngle = (i / total) * 360 - 90; // Start from top
    const endAngle = ((i + 1) / total) * 360 - 90;
    const gap = total > 1 ? 4 : 0; // Gap between segments
    const adjustedStartAngle = startAngle + gap / 2;
    const adjustedEndAngle = endAngle - gap / 2;

    // Convert to radians
    const startRad = (adjustedStartAngle * Math.PI) / 180;
    const endRad = (adjustedEndAngle * Math.PI) / 180;

    // Calculate arc points
    const x1 = cx + innerRadius * Math.cos(startRad);
    const y1 = cy + innerRadius * Math.sin(startRad);
    const x2 = cx + innerRadius * Math.cos(endRad);
    const y2 = cy + innerRadius * Math.sin(endRad);

    const largeArcFlag = endAngle - startAngle > 180 ? 1 : 0;
    const pathData = `M ${cx} ${cy} L ${x1} ${y1} A ${innerRadius} ${innerRadius} 0 ${largeArcFlag} 1 ${x2} ${y2} Z`;

    segments.push(
      <path
        key={`segment-${i}-${completed}-${total}`}
        d={pathData}
        fill={i < completed ? 'currentColor' : 'transparent'}
        opacity={i < completed ? 0.7 : 0.15}
      />,
    );
  }

  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className={cn('text-muted-foreground', className)}
      aria-label={`Progress: ${completed} of ${total} tasks`}
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
      {segments}
    </svg>
  );
};

const TodoStatusIcon = ({
  status,
  isPending,
}: {
  status: TodoItem['status'];
  isPending?: boolean;
}) => {
  // During loading, show arrow for in_progress items with foreground background
  if (isPending && status === 'in_progress') {
    return (
      <div className="w-3.5 h-3.5 rounded-full bg-foreground flex items-center justify-center shrink-0">
        <ArrowRight className="w-2 h-2 text-background" />
      </div>
    );
  }

  switch (status) {
    case 'completed':
      return (
        <div
          className="w-3.5 h-3.5 rounded-full bg-muted flex items-center justify-center shrink-0"
          style={BORDER_STYLE}
        >
          <Check className="w-2 h-2 text-muted-foreground" />
        </div>
      );
    case 'in_progress':
      return (
        <div className="w-3.5 h-3.5 rounded-full bg-foreground flex items-center justify-center shrink-0">
          <ArrowRight className="w-2 h-2 text-background" />
        </div>
      );
    default:
      return (
        <div className="w-3.5 h-3.5 rounded-full flex items-center justify-center shrink-0 border border-muted-foreground/30" />
      );
  }
};

// Memoized status icon map to avoid recreating on each render
// For compact change items (multiple updates view)
const STATUS_ICONS = {
  completed: Check,
  // biome-ignore lint/style/useNamingConvention: DB enum value used as key
  in_progress: ChevronsRight,
  pending: Circle,
} as const;

// For AgentToolCall icon (single update view) - use Loader2 for in_progress
const TOOL_CALL_ICONS = {
  completed: Check,
  // biome-ignore lint/style/useNamingConvention: DB enum value used as key
  in_progress: Loader2,
  pending: Circle,
} as const;

// Memoized component for rendering individual todo change items
const TodoChangeItem = memo(function TodoChangeItem({
  change,
  showSeparator,
}: {
  change: TodoChange;
  showSeparator: boolean;
}) {
  // biome-ignore lint/style/useNamingConvention: Renders as a JSX component
  const StatusIcon = STATUS_ICONS[change.newStatus] || STATUS_ICONS.pending;
  return (
    <div className="flex items-center gap-1 shrink-0">
      <StatusIcon className="w-3 h-3" />
      <span className="truncate">{change.todo.content}</span>
      {showSeparator && <span className="mx-0.5">,</span>}
    </div>
  );
});

// Memoized component for rendering individual todo list items in expanded view
const TodoListItem = memo(function TodoListItem({
  todo,
  isPending,
  isLast,
}: {
  todo: TodoItem;
  isPending: boolean;
  isLast: boolean;
}) {
  return (
    <div
      className={cn(
        'flex items-center gap-2 px-2.5 py-1.5',
        !isLast && 'border-b border-border/30',
      )}
    >
      <TodoStatusIcon status={todo.status} isPending={isPending} />
      <span
        className={cn(
          'text-xs truncate',
          isPending
            ? 'text-muted-foreground'
            : todo.status === 'completed'
              ? 'line-through text-muted-foreground'
              : todo.status === 'pending'
                ? 'text-muted-foreground'
                : 'text-foreground',
        )}
      >
        {todo.content}
      </span>
    </div>
  );
});

export const AgentTodoTool = memo(function AgentTodoTool({
  part,
  chatStatus,
  subChatId,
}: AgentTodoToolProps) {
  // Synced todos state - scoped per subChatId to prevent cross-chat conflicts
  // Uses a stable key to ensure proper isolation between different sub-chats
  const todosAtom = useMemo(() => currentTodosAtomFamily(subChatId || 'default'), [subChatId]);
  const [todoState, setTodoState] = useAtom(todosAtom);
  const syncedTodos = todoState.todos;
  const creationToolCallId = todoState.creationToolCallId;

  // Use refs to track values without triggering effect re-runs
  // This prevents infinite loops when the effect updates the atom
  const syncedTodosRef = useRef(syncedTodos);
  syncedTodosRef.current = syncedTodos;

  const creationToolCallIdRef = useRef(creationToolCallId);
  creationToolCallIdRef.current = creationToolCallId;

  // Get todos from input or output.newTodos
  const rawOldTodos = part.output?.oldTodos || [];
  const newTodos = part.input?.todos || part.output?.newTodos || [];

  // Check if we're still streaming input (data not yet complete)
  const isStreaming = part.state === 'input-streaming';

  // Determine if this is the creation tool call
  // A tool call is the "creation" if:
  // 1. It's the first tool call (creationToolCallId is null) OR
  // 2. It matches the stored creationToolCallId
  // 3. NEW: This is a new generation - detected when:
  //    - output.oldTodos explicitly exists and is empty (server confirmed this is a new list)
  //    - we have newTodos (creation always has new todos)
  //    - there are existing syncedTodos from previous generation
  //    - this is a different tool call than the stored creation one
  // IMPORTANT: Check if output.oldTodos is explicitly an empty array, not just missing
  // If output doesn't exist yet or oldTodos is undefined, we can't determine if it's new generation
  const hasOutputWithEmptyOldTodos =
    part.output !== undefined &&
    'oldTodos' in part.output &&
    Array.isArray(part.output.oldTodos) &&
    part.output.oldTodos.length === 0;
  const isNewGeneration =
    hasOutputWithEmptyOldTodos &&
    newTodos.length > 0 &&
    syncedTodos.length > 0 &&
    creationToolCallId !== null &&
    creationToolCallId !== part.toolCallId;
  const isCreationToolCall =
    creationToolCallId === null || creationToolCallId === part.toolCallId || isNewGeneration;

  // Use syncedTodos as fallback for oldTodos when output hasn't arrived yet
  // This prevents flickering: without this, when a new tool call arrives with
  // input.todos but no output.oldTodos yet, detectChanges would see empty oldTodos
  // and incorrectly treat it as "creation", showing the full list momentarily
  // before output arrives and it switches to compact "single"/"multiple" mode
  const oldTodos = useMemo(() => {
    // If we have oldTodos from output, use them
    if (rawOldTodos.length > 0) {
      return rawOldTodos;
    }
    // Only use syncedTodos if this is NOT the creation tool call
    // This prevents the bug where the creation tool call would see its own todos as "old"
    if (syncedTodos.length > 0 && !isCreationToolCall) {
      return syncedTodos;
    }
    // Otherwise this is truly a creation (first tool call, or same tool call that set syncedTodos)
    return [];
  }, [rawOldTodos, syncedTodos, isCreationToolCall]);

  // Detect what changed - memoize to avoid recalculation
  const changes = useMemo(() => detectChanges(oldTodos, newTodos), [oldTodos, newTodos]);

  const [isExpanded, setIsExpanded] = useState(false);
  const { isPending } = getToolStatus(part, chatStatus);

  // Memoized click handlers to prevent inline function re-creation
  const handleToggleExpand = useCallback(() => {
    setIsExpanded((prev) => !prev);
  }, []);

  const handleExpand = useCallback(() => {
    setIsExpanded(true);
  }, []);

  const handleCollapse = useCallback(() => {
    setIsExpanded(false);
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setIsExpanded((prev) => !prev);
    }
  }, []);

  const handleExpandKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setIsExpanded(true);
    }
  }, []);

  const handleCollapseKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setIsExpanded(false);
    }
  }, []);

  // Update synced todos whenever newTodos change
  // This keeps the creation tool in sync with all updates
  useEffect(() => {
    if (newTodos.length > 0) {
      // Use refs to get current values without adding them to dependencies
      // This prevents infinite loops: effect updates atom -> state changes -> effect runs again
      const currentSyncedTodos = syncedTodosRef.current;
      const currentCreationToolCallId = creationToolCallIdRef.current;

      // Compute these inside the effect to avoid dependency issues
      // These values depend on syncedTodos/creationToolCallId which change when we call setTodoState
      const hasOutputWithEmptyOldTodos =
        part.output !== undefined &&
        'oldTodos' in part.output &&
        Array.isArray(part.output.oldTodos) &&
        part.output.oldTodos.length === 0;

      const isNewGenerationLocal =
        hasOutputWithEmptyOldTodos &&
        newTodos.length > 0 &&
        currentSyncedTodos.length > 0 &&
        currentCreationToolCallId !== null &&
        currentCreationToolCallId !== part.toolCallId;

      const isCreationToolCallLocal =
        currentCreationToolCallId === null ||
        currentCreationToolCallId === part.toolCallId ||
        isNewGenerationLocal;

      // Only update if:
      // 1. This is the creation tool call (always update), OR
      // 2. newTodos has at least as many items as syncedTodos (prevents partial streaming overwrites)
      // During streaming, JSON parsing may return partial arrays, causing temporary drops in length
      const shouldUpdate = isCreationToolCallLocal || newTodos.length >= currentSyncedTodos.length;

      // If this is a new generation, reset the creationToolCallId to this tool call
      const newCreationId = isNewGenerationLocal
        ? part.toolCallId
        : currentCreationToolCallId === null
          ? part.toolCallId
          : currentCreationToolCallId;

      if (shouldUpdate) {
        // Prevent infinite loop: check if todos actually changed before updating
        // Compare by serializing to JSON - if content is the same, skip update
        const newTodosJson = JSON.stringify(newTodos);
        const syncedTodosJson = JSON.stringify(currentSyncedTodos);

        if (newTodosJson !== syncedTodosJson || currentCreationToolCallId !== newCreationId) {
          setTodoState({ todos: newTodos, creationToolCallId: newCreationId });
        }
      }
    }
  }, [newTodos, setTodoState, part.toolCallId, part.output]);

  // For UPDATE tool calls while streaming, show "Updating..." placeholder
  // This check MUST come BEFORE the newTodos.length === 0 check
  // Otherwise we return null when newTodos is empty during streaming updates
  if (!isCreationToolCall && isStreaming) {
    return (
      <div className="flex items-start gap-1.5 py-0.5 rounded-md px-2">
        <div className="flex-1 min-w-0 flex items-center gap-1.5">
          <div className="text-xs text-muted-foreground flex items-center gap-1.5 min-w-0">
            <span className="font-medium whitespace-nowrap shrink-0">
              <TextShimmer
                as="span"
                duration={1.2}
                className="inline-flex items-center text-xs leading-none h-4 m-0"
              >
                Updating to-dos...
              </TextShimmer>
            </span>
          </div>
        </div>
      </div>
    );
  }

  // Early streaming state - show placeholder for CREATION only
  if (newTodos.length === 0 || (isStreaming && !part.input?.todos)) {
    // For update tool calls (not creation), return null to avoid showing placeholder
    // Note: This branch is only reached when !isStreaming (update streaming handled above)
    if (!isCreationToolCall) {
      return null;
    }

    return (
      <StickyToolList sticky>
        <div className="rounded-lg border border-border bg-muted/30 px-2.5 py-1.5 stuck:glass-float">
          <div className="flex items-center gap-1.5">
            <ClipboardList className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
            <span className="text-xs font-medium whitespace-nowrap shrink-0">
              {isPending ? (
                <TextShimmer
                  as="span"
                  duration={1.2}
                  className="inline-flex items-center text-xs leading-none h-4 m-0"
                >
                  Creating to-do list...
                </TextShimmer>
              ) : (
                'Creating to-do list...'
              )}
            </span>
          </div>
        </div>
      </StickyToolList>
    );
  }

  // COMPACT MODE: Single update - render as simple tool call
  if (changes.type === 'single') {
    const change = changes.items[0];
    // Use stable icon reference from TOOL_CALL_ICONS map
    const iconComponent = TOOL_CALL_ICONS[change.newStatus] || TOOL_CALL_ICONS.pending;

    // For in_progress status with activeForm, use activeForm as the title text
    // to avoid duplication (content + activeForm both shown)
    const titleText =
      change.newStatus === 'in_progress' && change.todo.activeForm
        ? change.todo.activeForm
        : change.todo.content;

    return (
      <AgentToolCall
        icon={iconComponent}
        title={getStatusVerb(change.newStatus, titleText)}
        isPending={isPending}
        isError={false}
      />
    );
  }

  // COMPACT MODE: Multiple updates - render as custom component with icons
  if (changes.type === 'multiple') {
    const completedChanges = changes.items.filter((c) => c.newStatus === 'completed').length;
    const startedChanges = changes.items.filter((c) => c.newStatus === 'in_progress').length;

    // Build summary title
    let summaryTitle = 'Updated to-dos';
    if (completedChanges > 0 && startedChanges === 0) {
      summaryTitle = `Finished ${completedChanges} ${completedChanges === 1 ? 'task' : 'tasks'}`;
    } else if (startedChanges > 0 && completedChanges === 0) {
      summaryTitle = `Started ${startedChanges} ${startedChanges === 1 ? 'task' : 'tasks'}`;
    } else if (completedChanges > 0 && startedChanges > 0) {
      summaryTitle = `Updated ${changes.items.length} ${changes.items.length === 1 ? 'task' : 'tasks'}`;
    }

    // Limit displayed items to avoid overflow
    const maxVisibleItems = 3;
    const visibleItems = changes.items.slice(0, maxVisibleItems);
    const remainingCount = changes.items.length - maxVisibleItems;

    return (
      <div className="flex items-start gap-1.5 py-0.5 rounded-md px-2">
        <div className="flex-1 min-w-0 flex items-center gap-1.5">
          <div className="text-xs text-muted-foreground flex items-center gap-1.5 min-w-0">
            <span className="font-medium whitespace-nowrap shrink-0">
              {isPending ? (
                <TextShimmer
                  as="span"
                  duration={1.2}
                  className="inline-flex items-center text-xs leading-none h-4 m-0"
                >
                  {summaryTitle}
                </TextShimmer>
              ) : (
                summaryTitle
              )}
            </span>
            <div className="flex items-center gap-1 text-muted-foreground/60 font-normal truncate min-w-0">
              {visibleItems.map((c, idx) => (
                <TodoChangeItem
                  key={`todo-change-${c.index}-${c.todo.content.slice(0, 20)}`}
                  change={c}
                  showSeparator={idx < visibleItems.length - 1}
                />
              ))}
              {remainingCount > 0 && (
                <span className="text-muted-foreground/60 whitespace-nowrap shrink-0">
                  +{remainingCount} more
                </span>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // FULL MODE: Creation - render as expandable list
  // Use syncedTodos to show the current state (synced with all updates)
  const displayTodos = syncedTodos.length > 0 ? syncedTodos : newTodos;
  const displayTodosWithKeys = (() => {
    const occurrenceBySignature = new Map<string, number>();
    return displayTodos.map((todo) => {
      const signature = `${todo.status}:${todo.activeForm ?? ''}:${todo.content}`;
      const occurrence = (occurrenceBySignature.get(signature) ?? 0) + 1;
      occurrenceBySignature.set(signature, occurrence);
      return {
        todo,
        key: `${signature}:${occurrence}`,
      };
    });
  })();
  const completedCount = displayTodos.filter((t) => t.status === 'completed').length;
  const inProgressCount = displayTodos.filter((t) => t.status === 'in_progress').length;
  const totalTodos = displayTodos.length;

  // For visual progress, count completed + in_progress tasks
  // This way when a task starts, the segment fills immediately
  const visualProgress = completedCount + inProgressCount;

  // Find current task (first in_progress, or first pending if none in progress)
  const currentTask =
    displayTodos.find((t) => t.status === 'in_progress') ||
    displayTodos.find((t) => t.status === 'pending');

  // Find current task index for progress display
  const currentTaskIndex = currentTask ? displayTodos.indexOf(currentTask) + 1 : completedCount;

  return (
    <StickyToolList sticky={isCreationToolCall}>
      {/* TOP BLOCK - Plan title with expand/collapse button */}
      <Button
        variant="ghost"
        size="auto"
        className="w-full justify-start text-left font-normal rounded-t-lg rounded-b-none border border-b-0 border-border bg-muted/30 px-2.5 py-1.5 duration-150 stuck:glass-float"
        onClick={handleToggleExpand}
        aria-expanded={isExpanded}
        aria-label={`To-do list with ${totalTodos} items. Click to ${isExpanded ? 'collapse' : 'expand'}`}
        tabIndex={0}
        onKeyDown={handleKeyDown}
      >
        <div className="flex items-center gap-1.5">
          <ClipboardList className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
          <span className="text-xs font-medium text-foreground">To-dos</span>
          <span className="text-xs text-muted-foreground truncate flex-1">
            {displayTodos[0]?.content || 'To-do list'}
          </span>
          {/* Expand/Collapse icon */}
          <div className="relative w-4 h-4 shrink-0">
            <Maximize2
              className={cn(
                'absolute inset-0 w-4 h-4 text-muted-foreground transition-[opacity,transform] duration-200 ease-out',
                isExpanded ? 'opacity-0 scale-75' : 'opacity-100 scale-100',
              )}
            />
            <Minimize2
              className={cn(
                'absolute inset-0 w-4 h-4 text-muted-foreground transition-[opacity,transform] duration-200 ease-out',
                isExpanded ? 'opacity-100 scale-100' : 'opacity-0 scale-75',
              )}
            />
          </div>
        </div>
      </Button>

      {/* BOTTOM BLOCK - Current task + progress (expandable) */}
      <div className="rounded-b-lg border border-border bg-muted/20 shadow-xl shadow-background stuck:glass-float stuck:shadow-none">
        {/* Collapsed view - progress circle + current task + count */}
        {!isExpanded && (
          <Button
            variant="ghost"
            size="auto"
            onClick={handleExpand}
            onKeyDown={handleExpandKeyDown}
            aria-label="Expand to-do list"
            className="w-full justify-start text-left font-normal flex gap-2.5 px-2.5 py-1.5 duration-150 focus:outline-hidden focus:ring-2 focus:ring-ring focus:ring-offset-2 rounded-none"
          >
            {/* Progress circle or checkmark when all completed */}
            {completedCount === totalTodos && totalTodos > 0 ? (
              <div
                className="w-4 h-4 rounded-full bg-muted flex items-center justify-center shrink-0"
                style={{ border: '0.5px solid hsl(var(--border))' }}
              >
                <Check className="w-2.5 h-2.5 text-muted-foreground" />
              </div>
            ) : (
              <ProgressCircle
                completed={visualProgress}
                total={totalTodos}
                size={16}
                className="shrink-0"
              />
            )}

            {/* Current task name */}
            <div className="flex items-center gap-1.5 min-w-0 flex-1">
              {currentTask && (
                <span className="text-xs text-muted-foreground truncate">
                  {currentTask.status === 'in_progress'
                    ? currentTask.activeForm || currentTask.content
                    : currentTask.content}
                </span>
              )}
              {!currentTask && completedCount === totalTodos && totalTodos > 0 && (
                <span className="text-xs text-muted-foreground truncate">
                  {displayTodos[totalTodos - 1]?.content}
                </span>
              )}
            </div>

            {/* Right side - task count */}
            <span className="text-xs text-muted-foreground tabular-nums shrink-0">
              {currentTaskIndex}/{totalTodos}
            </span>
          </Button>
        )}

        {/* Expanded content - full todo list */}
        {isExpanded && (
          <Button
            variant="ghost"
            size="auto"
            className="w-full justify-start text-left font-normal max-h-[300px] p-0 overflow-y-auto focus:outline-hidden focus:ring-2 focus:ring-ring focus:ring-offset-2 rounded-none flex flex-col items-stretch hover:bg-transparent"
            onClick={handleCollapse}
            onKeyDown={handleCollapseKeyDown}
            aria-label="Collapse to-do list"
          >
            {displayTodosWithKeys.map(({ todo, key }, idx) => (
              <TodoListItem
                key={key}
                todo={todo}
                isPending={isPending}
                isLast={idx === displayTodos.length - 1}
              />
            ))}
          </Button>
        )}
      </div>
    </StickyToolList>
  );
}, areToolPropsEqual);
