/* eslint-disable max-lines, max-lines-per-function */

import { Button } from '@benord-labs/frink-primitives';
import { Copy, Pencil, Plus, Loader2 } from 'lucide-react';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { toast } from 'sonner';
import { filterBuiltinCommands } from '@/lib/commands/builtin-commands';
import { commandBadgeLabels } from '@/lib/commands/command-badge-labels';
import type { SlashCommandOption } from '@/lib/commands/types';
import { usePendingCommandArguments } from '@/lib/commands/use-pending-command-arguments';
import type { ChatMode } from '../../../../shared/types/chat-mode';
import { CommandArgumentsPopover } from './CommandArgumentsPopover';
import { CommandRowAction } from './CommandRowAction';
import { trpc } from '../../../lib/trpc';
import { overlayGlass } from '@/lib/overlay-styles';
import { cn } from '../../../lib/utils';

/** Stable DOM id for the slash command listbox (used by aria-controls on the input). */
export const SLASH_COMMAND_LISTBOX_ID = 'slash-command-listbox';

type AgentsSlashCommandProps = {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (command: SlashCommandOption) => void;
  searchText: string;
  position: { top: number; left: number };
  projectPath?: string;
  /** When false, `/debug` is omitted from built-in listings. Defaults from `projectPath` when omitted. */
  hasProject?: boolean;
  chatMode?: ChatMode;
  disabledCommands?: string[];
  /** Called when user clicks "Create Command". Passes search text as prefilled name. */
  onCreateCommand?: (prefillName?: string) => void;
  /** Called when user clicks the edit icon on a frink command */
  onEditCommand?: (command: SlashCommandOption) => void;
  /** Called when user clicks "Copy to Frink" on a non-frink command */
  onForkCommand?: (command: SlashCommandOption) => void;
  /** Called when the active (highlighted) option changes, so the parent input can set aria-activedescendant. */
  onActiveDescendantChange?: (id: string | undefined) => void;
  // (Delete is handled inside the CommandEditorModal, no separate dropdown icon needed)
  /** When true, suppress built-in commands (e.g. /plan) — for non-chat contexts like flow instructions. */
  hideBuiltins?: boolean;
};

/** Stable DOM id for a command option (used by aria-activedescendant). */
function getOptionDomId(option: SlashCommandOption): string {
  return `slash-cmd-${option.id}`;
}

function filterCustomCommandsBySearch(
  customCommands: SlashCommandOption[],
  debouncedSearchText: string,
): SlashCommandOption[] {
  if (!debouncedSearchText) {
    return customCommands;
  }
  const query = debouncedSearchText.toLowerCase();
  return customCommands.filter(
    (cmd) =>
      cmd.name.toLowerCase().includes(query) ||
      cmd.command.toLowerCase().includes(query) ||
      cmd.description.toLowerCase().includes(query),
  );
}

/** Single command row in the dropdown */
const CommandRow = memo(function CommandRow({
  option,
  index,
  isSelected,
  onSelect,
  onHover,
  onEditCommand,
  onForkCommand,
}: {
  option: SlashCommandOption;
  index: number;
  isSelected: boolean;
  onSelect: (option: SlashCommandOption) => void;
  onHover: (index: number) => void;
  onEditCommand?: (command: SlashCommandOption) => void;
  onForkCommand?: (command: SlashCommandOption) => void;
}) {
  const isFrinkCommand = option.origin === 'frink';
  return (
    <div
      id={getOptionDomId(option)}
      role="option"
      tabIndex={-1}
      aria-selected={isSelected}
      data-option-index={index}
      onMouseDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onSelect(option);
      }}
      onMouseEnter={() => onHover(index)}
      className={cn(
        'group inline-flex w-[calc(100%-8px)] mx-1 items-center whitespace-nowrap outline-hidden',
        'h-7 px-1.5 justify-start text-xs rounded-md',
        'transition-colors cursor-pointer select-none',
        isSelected
          ? 'dark:bg-neutral-800 bg-accent text-foreground'
          : 'text-muted-foreground dark:hover:bg-neutral-800 hover:bg-accent hover:text-foreground',
      )}
    >
      <span className="flex items-center gap-1 w-full min-w-0">
        <span className="shrink-0 whitespace-nowrap font-medium">{option.command}</span>
        <span className="text-muted-foreground flex-1 min-w-0 ml-2 overflow-hidden text-[10px] truncate">
          {option.description}
        </span>

        {isFrinkCommand && onEditCommand && (
          <CommandRowAction
            label={`Edit ${option.name}`}
            icon={<Pencil className="h-3 w-3" />}
            onRun={() => onEditCommand(option)}
          />
        )}

        {!isFrinkCommand && option.category === 'repository' && onForkCommand && (
          <CommandRowAction
            label={`Copy ${option.name} to Frink`}
            title="Copy to Frink"
            icon={<Copy className="h-3 w-3" />}
            onRun={() => onForkCommand(option)}
          />
        )}

        {commandBadgeLabels(option).map((label, index) => (
          <span
            key={index}
            className="shrink-0 max-w-24 truncate text-[9px] text-muted-foreground/50 ml-1"
          >
            {label}
          </span>
        ))}
      </span>
    </div>
  );
});

// Memoized to prevent re-renders when parent re-renders
export const AgentsSlashCommand = memo(function AgentsSlashCommand({
  isOpen,
  onClose,
  onSelect,
  searchText,
  position,
  projectPath,
  hasProject,
  chatMode,
  disabledCommands,
  onCreateCommand,
  onEditCommand,
  onForkCommand,
  onActiveDescendantChange,
  hideBuiltins,
}: AgentsSlashCommandProps) {
  const effectiveHasProject = hasProject ?? Boolean(projectPath);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const placementRef = useRef<'above' | 'below' | null>(null);
  const [debouncedSearchText, setDebouncedSearchText] = useState(searchText);

  // Debounce search text (300ms to match file mention)
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearchText(searchText);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchText]);

  // Fetch custom commands from filesystem
  const { data: rawFileCommands, isLoading } = trpc.commands.list.useQuery(
    { projectPath },
    {
      enabled: isOpen,
      staleTime: 30_000, // Cache for 30 seconds
      refetchOnWindowFocus: false,
    },
  );
  const fileCommands = Array.isArray(rawFileCommands) ? rawFileCommands : [];

  // Transform FileCommand to SlashCommandOption
  const customCommands: SlashCommandOption[] = useMemo(() => {
    return fileCommands.map((cmd) => ({
      ...cmd,
      id: `custom:${cmd.origin}:${cmd.source}:${cmd.name}`,
      command: `/${cmd.name}`,
      description: cmd.description || `Custom command from ${cmd.source}`,
      category: 'repository' as const,
    }));
  }, [fileCommands]);

  const args = usePendingCommandArguments(isOpen);

  // tRPC utils for fetching command content
  const trpcUtils = trpc.useUtils();

  // Handle command selection - fetch content for custom commands
  const handleSelect = useCallback(
    async (option: SlashCommandOption) => {
      // For builtin commands, call onSelect directly
      if (option.category === 'builtin') {
        onSelect(option);
        return;
      }

      // For custom commands, fetch the prompt content from filesystem
      if (option.path) {
        const pickedIn = args.beginPick();
        try {
          const result = await trpcUtils.commands.getContent.fetch({
            path: option.path,
          });

          const picked = { ...option, prompt: result.content };
          if (!args.holdForArguments(picked, pickedIn, !hideBuiltins)) onSelect(picked);
        } catch (_error) {
          toast.error('Failed to load command content');
          onClose();
        }
      } else {
        // Fallback - just call onSelect without prompt
        onSelect(option);
      }
    },
    [onSelect, onClose, trpcUtils, args, hideBuiltins],
  );

  // Combine builtin and repository commands, filtered by search
  const allOptions = useMemo(() => {
    // In non-chat contexts (e.g. flow instructions), built-ins are session-specific and irrelevant,
    // and the body is spliced in verbatim, so nothing there ever substitutes $ARGUMENTS.
    if (hideBuiltins) {
      const customFiltered = filterCustomCommandsBySearch(customCommands, debouncedSearchText).map(
        (cmd) => ({ ...cmd, takesArguments: false }),
      );
      return { custom: customFiltered, builtin: [] as typeof customFiltered, all: customFiltered };
    }

    let builtinFiltered = filterBuiltinCommands(debouncedSearchText, {
      hasProject: effectiveHasProject,
    });

    // Hide the command matching the current mode
    if (chatMode !== undefined) {
      builtinFiltered = builtinFiltered.filter((cmd) => cmd.name !== chatMode);
    }

    // Filter out disabled commands
    if (disabledCommands && disabledCommands.length > 0) {
      builtinFiltered = builtinFiltered.filter((cmd) => !disabledCommands.includes(cmd.name));
    }

    const customFiltered = filterCustomCommandsBySearch(customCommands, debouncedSearchText);

    // Return custom commands first, then builtin
    return {
      custom: customFiltered,
      builtin: builtinFiltered,
      all: [...customFiltered, ...builtinFiltered],
    };
  }, [
    debouncedSearchText,
    customCommands,
    chatMode,
    disabledCommands,
    hideBuiltins,
    effectiveHasProject,
  ]);

  // Flat list for keyboard navigation indexing
  const options = allOptions.all;

  // Track previous values for smarter selection reset
  const prevIsOpenRef = useRef(isOpen);
  const prevSearchRef = useRef(debouncedSearchText);

  // CONSOLIDATED: Single useLayoutEffect for selection management
  useLayoutEffect(() => {
    const didJustOpen = isOpen && !prevIsOpenRef.current;
    const didSearchChange = debouncedSearchText !== prevSearchRef.current;

    // Reset to 0 when opening or search changes
    if (didJustOpen || didSearchChange) {
      setSelectedIndex(0);
    }
    // Clamp to valid range if options shrunk
    else if (options.length > 0 && selectedIndex >= options.length) {
      setSelectedIndex(Math.max(0, options.length - 1));
    }

    // Update refs
    prevIsOpenRef.current = isOpen;
    prevSearchRef.current = debouncedSearchText;
  }, [isOpen, debouncedSearchText, options.length, selectedIndex]);

  // Notify parent of active descendant changes (for aria-activedescendant on the input)
  useEffect(() => {
    if (!onActiveDescendantChange) return;
    if (isOpen && options[selectedIndex]) {
      onActiveDescendantChange(getOptionDomId(options[selectedIndex]));
    } else {
      onActiveDescendantChange(undefined);
    }
  }, [isOpen, selectedIndex, options, onActiveDescendantChange]);

  // Reset placement when closed
  useEffect(() => {
    if (!isOpen) {
      placementRef.current = null;
    }
  }, [isOpen]);

  // Keyboard navigation. Stands down while the argument popover is up: this listener captures on
  // window and stops immediate propagation, so it would eat that input's own Enter and Escape.
  useEffect(() => {
    if (!isOpen || args.pending) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          // Guard against modulo by zero when no options
          if (options.length > 0) {
            setSelectedIndex((prev) => (prev + 1) % options.length);
          }
          break;
        case 'ArrowUp':
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          // Guard against modulo by zero when no options
          if (options.length > 0) {
            setSelectedIndex((prev) => (prev - 1 + options.length) % options.length);
          }
          break;
        case 'Enter':
          if (e.shiftKey) return;
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          if (options[selectedIndex]) {
            handleSelect(options[selectedIndex]);
          }
          break;
        case 'Escape':
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          onClose();
          break;
        case 'Tab':
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          if (options[selectedIndex]) {
            handleSelect(options[selectedIndex]);
          }
          break;
        case 'e': {
          // Cmd+E / Ctrl+E — edit shortcut for editable (frink) commands
          if (!e.metaKey && !e.ctrlKey) break;
          const opt = options[selectedIndex];
          if (opt?.origin === 'frink' && onEditCommand) {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            onEditCommand(opt);
            onClose();
          }
          break;
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true });
  }, [isOpen, args.pending, options, selectedIndex, handleSelect, onClose, onEditCommand]);

  // Auto-scroll selected item into view
  useEffect(() => {
    if (!isOpen || !dropdownRef.current) return;

    if (selectedIndex === 0) {
      dropdownRef.current.scrollTo({ top: 0, behavior: 'auto' });
      return;
    }

    const elements = dropdownRef.current.querySelectorAll('[data-option-index]');
    const selectedElement = elements[selectedIndex] as HTMLElement;
    if (selectedElement) {
      selectedElement.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex, isOpen]);

  // Click outside
  useEffect(() => {
    if (!isOpen || args.pending) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen, args.pending, onClose]);

  if (!isOpen) return null;

  // Calculate dropdown dimensions (matching file mention style)
  const dropdownWidth = 320;
  const itemHeight = 28; // h-7 = 28px to match file mention
  const headerHeight = 24;
  const createButtonHeight = onCreateCommand ? 36 : 0; // h-8 + border-t padding
  // Section headers: one for custom commands, one for builtins (only if each has items)
  const headersCount =
    (allOptions.custom.length > 0 ? 1 : 0) + (allOptions.builtin.length > 0 ? 1 : 0);
  const requestedHeight = Math.min(
    options.length * itemHeight + headersCount * headerHeight + createButtonHeight + 8,
    240, // Slightly taller to accommodate create button
  );
  const gap = 8;

  // Decide placement like Radix Popover (auto-flip top/bottom)
  const safeMargin = 10;
  const caretOffsetBelow = 20;
  const availableBelow = window.innerHeight - (position.top + caretOffsetBelow) - safeMargin;
  const availableAbove = position.top - safeMargin;

  // Compute desired placement, but lock it for the duration of the open state
  if (placementRef.current === null) {
    const condition1 = availableAbove >= requestedHeight && availableBelow < requestedHeight;
    const condition2 = availableAbove > availableBelow && availableAbove >= requestedHeight;
    const shouldPlaceAbove = condition1 || condition2;
    placementRef.current = shouldPlaceAbove ? 'above' : 'below';
  }
  const placeAbove = placementRef.current === 'above';

  // Compute final top based on placement
  const finalTop = placeAbove ? position.top - gap : position.top + gap + caretOffsetBelow;

  // Slight left bias to better align with '/'
  const leftOffset = -4;
  let finalLeft = position.left + leftOffset;

  // Adjust horizontal overflow
  if (finalLeft + dropdownWidth > window.innerWidth - safeMargin) {
    finalLeft = window.innerWidth - dropdownWidth - safeMargin;
  }
  if (finalLeft < safeMargin) {
    finalLeft = safeMargin;
  }

  // Compute actual maxHeight based on available space on the chosen side
  const computedMaxHeight = Math.max(
    80,
    Math.min(requestedHeight, placeAbove ? availableAbove - gap : availableBelow - gap),
  );
  const transformY = placeAbove ? 'translateY(-100%)' : 'translateY(0)';

  if (args.pending) {
    return (
      <CommandArgumentsPopover
        command={args.pending}
        style={{ top: finalTop, left: finalLeft, width: dropdownWidth, transform: transformY }}
        onResolve={(filled) => {
          args.resolve();
          if (filled) onSelect(filled);
          else onClose();
        }}
      />
    );
  }

  return createPortal(
    <div
      ref={dropdownRef}
      id={SLASH_COMMAND_LISTBOX_ID}
      role="listbox"
      tabIndex={-1}
      aria-label="Slash commands"
      className={`fixed z-99999 overflow-y-auto rounded-[10px] border py-1 text-xs text-popover-foreground shadow-lg [&::-webkit-scrollbar]:hidden ${overlayGlass}`}
      style={
        {
          top: finalTop,
          left: finalLeft,
          width: `${dropdownWidth}px`,
          maxHeight: `${computedMaxHeight}px`,
          transform: transformY,
          scrollbarWidth: 'none',
        } as React.CSSProperties
      }
    >
      {/* Custom commands section */}
      {allOptions.custom.length > 0 && (
        // biome-ignore lint/a11y/useSemanticElements: role="group" inside listbox is WAI-ARIA pattern; <fieldset> is for forms
        <div role="group" aria-label="Commands">
          <div
            className="px-2.5 py-1.5 mx-1 text-[10px] font-medium text-muted-foreground/60 uppercase tracking-wider"
            aria-hidden="true"
          >
            Commands
          </div>
          {allOptions.custom.map((option, i) => {
            const isSelected = selectedIndex === i;
            return (
              <CommandRow
                key={option.id}
                option={option}
                index={i}
                isSelected={isSelected}
                onSelect={handleSelect}
                onHover={setSelectedIndex}
                onEditCommand={onEditCommand}
                onForkCommand={onForkCommand}
              />
            );
          })}
        </div>
      )}

      {/* Built-in commands section */}
      {allOptions.builtin.length > 0 && (
        // biome-ignore lint/a11y/useSemanticElements: role="group" inside listbox is WAI-ARIA pattern; <fieldset> is for forms
        <div role="group" aria-label="Built-in">
          {allOptions.custom.length > 0 && (
            <div className="mx-2 my-1 border-t border-border/30" aria-hidden="true" />
          )}
          <div
            className="px-2.5 py-1.5 mx-1 text-[10px] font-medium text-muted-foreground/60 uppercase tracking-wider"
            aria-hidden="true"
          >
            Built-in
          </div>
          {allOptions.builtin.map((option, i) => {
            const globalIndex = allOptions.custom.length + i;
            const isSelected = selectedIndex === globalIndex;
            return (
              <CommandRow
                key={option.id}
                option={option}
                index={globalIndex}
                isSelected={isSelected}
                onSelect={handleSelect}
                onHover={setSelectedIndex}
                onEditCommand={onEditCommand}
                onForkCommand={onForkCommand}
              />
            );
          })}
        </div>
      )}

      {/* Loading state for repository commands */}
      {isLoading && (
        <div className="flex items-center gap-1.5 h-7 px-1.5 mx-1 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          <span>Loading commands...</span>
        </div>
      )}

      {/* Empty state */}
      {!isLoading && options.length === 0 && !debouncedSearchText && (
        <div className="h-7 px-1.5 mx-1 flex items-center text-xs text-muted-foreground">
          No commands available
        </div>
      )}

      {/* No results message when searching */}
      {!isLoading && options.length === 0 && debouncedSearchText && (
        <div className="h-7 px-1.5 mx-1 flex items-center text-xs text-muted-foreground">
          No commands matching &ldquo;{debouncedSearchText}&rdquo;
        </div>
      )}

      {/* Create command button — always visible when available */}
      {onCreateCommand && (
        <>
          <div className="mx-2 my-1 border-t border-border/40" />
          <Button
            variant="ghost"
            onMouseDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onClose();
              onCreateCommand(debouncedSearchText || undefined);
            }}
            className={cn(
              'w-[calc(100%-8px)] mx-1 gap-1.5 justify-start',
              'h-7 px-1.5 mb-1 text-xs rounded-md font-normal',
              'dark:hover:bg-neutral-800',
            )}
          >
            <Plus className="h-3.5 w-3.5" />
            <span>{debouncedSearchText ? `Create /${debouncedSearchText}` : 'Create Command'}</span>
          </Button>
        </>
      )}
    </div>,
    document.body,
  );
});
