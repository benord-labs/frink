/* eslint-disable max-lines, max-lines-per-function */

import { Button } from '@benord-labs/frink-primitives';
import {
  DndContext,
  type DragEndEvent,
  type Modifier,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ArrowUp, ChevronDown, Navigation, Pencil, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../components/ui/tooltip';
import { cn } from '../../../lib/utils';
import { parseSlashCommandDisplayParts } from '../commands/parse-slash-command-display';
import type { AgentQueueItem } from '../lib/queue-utils';
import { RenderFileMentions } from '../mentions/render-file-mentions';

/** Module-level: dnd-kit's useSensor memoizes on the options object, so an inline literal rebuilds
 * DndContext's internal context every render and re-renders every draggable past its memo (sc-2721). */
const POINTER_SENSOR_OPTIONS = { activationConstraint: { distance: 6 } };

/**
 * Lock drag movement to the vertical axis. Queue rows are full-width and reorder is purely
 * vertical — letting the row drift sideways with the cursor makes drop targets harder to hit.
 */
const restrictToVerticalAxis: Modifier = ({ transform }) => ({
  ...transform,
  x: 0,
});

const QUEUE_EXPANDED_KEY = 'agent-queue-expanded';

type QueueItemRowProps = {
  item: AgentQueueItem;
  onRemove?: (itemId: string) => void;
  onSendNow?: (itemId: string, canSteer: boolean) => void;
  onEdit?: (itemId: string) => void;
  isEditing: boolean;
  inputHasContent: boolean;
  /** Steering only exists while a turn is running AND the runtime has a live input channel.
   * Anywhere else the button still sends — it just cannot claim to steer. */
  canSteer: boolean;
};

const QueueItemRow = memo(function QueueItemRow({
  item,
  onRemove,
  onSendNow,
  onEdit,
  isEditing,
  inputHasContent,
  canSteer,
}: QueueItemRowProps) {
  // Drag is disabled on the row currently being edited.
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.id,
    disabled: isEditing,
  });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
  };

  const handleRemove = useCallback(
    (e: React.MouseEvent | React.KeyboardEvent) => {
      e.stopPropagation();
      onRemove?.(item.id);
    },
    [item.id, onRemove],
  );

  const handleRemoveKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handleRemove(e);
      }
    },
    [handleRemove],
  );

  const handleSendNow = useCallback(
    (e: React.MouseEvent | React.KeyboardEvent) => {
      e.stopPropagation();
      onSendNow?.(item.id, canSteer);
    },
    // `canSteer` MUST stay in here: the label reads the prop fresh, so a stale closure would let a
    // button reading "Steer" send canSteer=false and abort the very turn it promises not to.
    [item.id, onSendNow, canSteer],
  );

  const handleSendNowKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handleSendNow(e);
      }
    },
    [handleSendNow],
  );

  const handleEdit = useCallback(
    (e: React.MouseEvent | React.KeyboardEvent) => {
      e.stopPropagation();
      if (isEditing || inputHasContent) return;
      onEdit?.(item.id);
    },
    [item.id, onEdit, isEditing, inputHasContent],
  );

  const handleEditKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handleEdit(e);
      }
    },
    [handleEdit],
  );

  const hasAttachments =
    (item.images && item.images.length > 0) ||
    (item.files && item.files.length > 0) ||
    (item.textContexts && item.textContexts.length > 0) ||
    (item.diffTextContexts && item.diffTextContexts.length > 0);
  const attachmentCount =
    (item.images?.length || 0) +
    (item.files?.length || 0) +
    (item.textContexts?.length || 0) +
    (item.diffTextContexts?.length || 0);

  const { commandName, commandText, cleanedText } = useMemo(
    () => parseSlashCommandDisplayParts(item.message),
    [item.message],
  );

  const editTooltip = isEditing
    ? 'Editing — send to apply'
    : inputHasContent
      ? 'Clear input to edit'
      : 'Edit';

  const editDisabled = isEditing || inputHasContent;

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className={cn(
        'flex items-center gap-2 px-3 py-1.5 text-xs transition-colors select-none border-l-2',
        isEditing
          ? 'border-l-primary bg-primary/10 cursor-default'
          : 'border-l-transparent hover:bg-muted/50 cursor-grab active:cursor-grabbing',
      )}
    >
      <span className="truncate flex-1 min-w-0 text-foreground flex items-baseline gap-1">
        {commandName && commandText ? (
          <>
            <span
              className="command-input-highlight shrink min-w-0"
              data-command-highlight={commandName}
            >
              <span className="sr-only">{`Command: ${commandName} — `}</span>
              <RenderFileMentions text={commandText} />
            </span>
            {commandText && cleanedText ? ' ' : null}
            {cleanedText ? (
              <span className="min-w-0 truncate">
                <RenderFileMentions text={cleanedText} />
              </span>
            ) : null}
          </>
        ) : (
          <span className="min-w-0 truncate">
            <RenderFileMentions text={cleanedText ?? ''} />
          </span>
        )}
      </span>
      {isEditing && (
        <span
          role="status"
          aria-live="polite"
          className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-primary bg-primary/15 rounded px-1.5 py-0.5"
        >
          Editing
        </span>
      )}
      {!isEditing && hasAttachments && (
        <span className="shrink-0 text-muted-foreground text-[10px]">
          +{attachmentCount} {attachmentCount === 1 ? 'file' : 'files'}
        </span>
      )}
      <div className="flex items-center gap-1">
        {onEdit && (
          <Tooltip>
            <TooltipTrigger asChild>
              {/* Wrap in span so the tooltip still triggers when the button is disabled. */}
              <span className="flex">
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={handleEdit}
                  onKeyDown={handleEditKeyDown}
                  onPointerDown={(e) => e.stopPropagation()}
                  disabled={editDisabled}
                  aria-label={editTooltip}
                  className={cn(
                    'shrink-0 p-1 rounded transition-all focus:outline-hidden focus:ring-2 focus:ring-ring focus:ring-offset-2',
                    editDisabled ? 'opacity-40 cursor-not-allowed' : '',
                  )}
                >
                  <Pencil className="w-3.5 h-3.5" />
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent side="top">{editTooltip}</TooltipContent>
          </Tooltip>
        )}
        {onSendNow && !isEditing && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={handleSendNow}
                onKeyDown={handleSendNowKeyDown}
                onPointerDown={(e) => e.stopPropagation()}
                aria-label={canSteer ? 'Steer' : 'Send now'}
                className="shrink-0 p-1 rounded transition-all focus:outline-hidden focus:ring-2 focus:ring-ring focus:ring-offset-2"
              >
                {canSteer ? (
                  <Navigation className="w-3.5 h-3.5" />
                ) : (
                  <ArrowUp className="w-3.5 h-3.5" />
                )}
              </Button>
            </TooltipTrigger>
            {/* Never promises immediacy: a steer waits for the agent's next model invocation, which
                a long tool call can defer by minutes. */}
            <TooltipContent side="top">
              {canSteer ? 'Steer — picked up at the next step' : 'Send now'}
            </TooltipContent>
          </Tooltip>
        )}
        {onRemove && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={handleRemove}
                onKeyDown={handleRemoveKeyDown}
                onPointerDown={(e) => e.stopPropagation()}
                aria-label="Remove from queue"
                className="shrink-0 p-1 rounded transition-all focus:outline-hidden focus:ring-2 focus:ring-ring focus:ring-offset-2"
              >
                <X className="w-3.5 h-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">Remove</TooltipContent>
          </Tooltip>
        )}
      </div>
    </div>
  );
});

type AgentQueueIndicatorProps = {
  queue: AgentQueueItem[];
  onRemoveItem?: (itemId: string) => void;
  onSendNow?: (itemId: string, canSteer: boolean) => void;
  onEditItem?: (itemId: string) => void;
  onReorder?: (fromIndex: number, toIndex: number) => void;
  editingItemId?: string | null;
  inputHasContent?: boolean;
  isStreaming?: boolean;
  /** Whether this chat's runtime has a live input channel to steer through. False for a provider
   * that spawns a fresh process per turn, so the button keeps its honest `Send now` wording. */
  steerSupported?: boolean;
};

export const AgentQueueIndicator = memo(function AgentQueueIndicator({
  queue,
  onRemoveItem,
  onSendNow,
  onEditItem,
  onReorder,
  editingItemId = null,
  inputHasContent = false,
  isStreaming = false,
  steerSupported = true,
}: AgentQueueIndicatorProps) {
  // Load expanded state from localStorage
  const [isExpanded, setIsExpanded] = useState(() => {
    if (typeof window === 'undefined') return true;
    const saved = localStorage.getItem(QUEUE_EXPANDED_KEY);
    return saved !== null ? saved === 'true' : true; // Default to expanded
  });

  // Save expanded state to localStorage
  useEffect(() => {
    localStorage.setItem(QUEUE_EXPANDED_KEY, String(isExpanded));
  }, [isExpanded]);

  // 6px activation distance: a normal click/tap doesn't read as a drag, but a deliberate
  // drag past the threshold engages the sortable. (TODO(a11y): wire KeyboardSensor for keyboard reorder.)
  const sensors = useSensors(useSensor(PointerSensor, POINTER_SENSOR_OPTIONS));

  const ids = useMemo(() => queue.map((item) => item.id), [queue]);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id || !onReorder) return;
      const fromIndex = ids.indexOf(String(active.id));
      const toIndex = ids.indexOf(String(over.id));
      if (fromIndex === -1 || toIndex === -1) return;
      onReorder(fromIndex, toIndex);
    },
    [ids, onReorder],
  );

  if (queue.length === 0) {
    return null;
  }

  return (
    <div
      data-stacked-card
      className="border border-border glass-float overflow-hidden flex flex-col rounded-t-2xl border-b-0"
    >
      {/* Header - at top */}
      <Button
        variant="ghost"
        tabIndex={0}
        onClick={() => setIsExpanded(!isExpanded)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setIsExpanded(!isExpanded);
          }
        }}
        aria-expanded={isExpanded}
        aria-label={`${isExpanded ? 'Collapse' : 'Expand'} queue`}
        className="flex justify-between pr-1 pl-3 h-8 duration-150 focus:outline-hidden rounded-sm w-full text-left"
      >
        <div className="flex items-center gap-2 text-xs flex-1 min-w-0">
          <ChevronDown
            className={cn(
              'w-4 h-4 text-muted-foreground transition-transform duration-200',
              !isExpanded && '-rotate-90',
            )}
          />
          <span className="text-xs text-muted-foreground">{queue.length} in queue</span>
        </div>
      </Button>

      {/* Expanded content - queue items */}
      <AnimatePresence initial={false}>
        {isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.23, 1, 0.32, 1] }}
            className="overflow-hidden"
          >
            <div className="border-t border-border max-h-[200px] overflow-y-auto">
              <DndContext
                sensors={sensors}
                modifiers={[restrictToVerticalAxis]}
                onDragEnd={handleDragEnd}
              >
                <SortableContext items={ids} strategy={verticalListSortingStrategy}>
                  {queue.map((item) => (
                    <QueueItemRow
                      key={item.id}
                      item={item}
                      onRemove={onRemoveItem}
                      onSendNow={onSendNow}
                      onEdit={onEditItem}
                      isEditing={editingItemId === item.id}
                      inputHasContent={inputHasContent}
                      canSteer={isStreaming && steerSupported}
                    />
                  ))}
                </SortableContext>
              </DndContext>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
});
