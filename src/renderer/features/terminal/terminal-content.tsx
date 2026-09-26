import { Button } from '@benord-labs/frink-primitives';
import { X } from 'lucide-react';
import type { FocusEvent } from 'react';
import { memo, useCallback } from 'react';
import { cn } from '@/lib/utils';
import { Terminal } from './terminal';
import type { TerminalInstance } from './types';

type TerminalContentProps = {
  activeTerminal: TerminalInstance | null;
  /** Two or more = horizontal strip (ordered left-to-right). */
  splitPaneTerminals: TerminalInstance[];
  /** Which terminal id should receive keyboard input (split mode). */
  terminalKeyboardTargetId: string | null;
  onTerminalPaneFocused: (terminalId: string) => void;
  onCloseSplitPane?: (terminalId: string) => void;
  canRenderTerminal: boolean;
  terminalBg: string;
  cwd: string;
  workspaceId: string;
  tabId?: string;
  initialCommands?: string[];
  /** Merged onto the surface wrapper (e.g. bottom-dock rounded bottom). */
  surfaceClassName?: string;
  /** Split-chat: false when this chat column is not the active pane. Defaults to true. */
  isPaneActive?: boolean;
};

/**
 * Shared terminal rendering area used by both sidebar and bottom panel.
 * Split mode mounts N live PTY sessions side-by-side (equal width).
 */
export const TerminalContent = memo(function TerminalContent({
  activeTerminal,
  splitPaneTerminals,
  terminalKeyboardTargetId,
  onTerminalPaneFocused,
  onCloseSplitPane,
  canRenderTerminal,
  terminalBg,
  cwd,
  workspaceId,
  tabId,
  initialCommands,
  surfaceClassName,
  isPaneActive = true,
}: TerminalContentProps) {
  const showSplit = splitPaneTerminals.length >= 2 && canRenderTerminal;

  /** Split mode: wrapper onFocus only (focusin from tab / click bubbles from xterm). No onMouseDown — same handler would run twice on click (mousedown then focus). Terminal does not receive `onTerminalPaneFocused` to avoid duplicate calls with the xterm focus listener. */
  const handleSplitPaneFocusIntent = useCallback(
    (e: FocusEvent<HTMLDivElement>) => {
      const id = e.currentTarget.getAttribute('data-terminal-id');
      if (id) onTerminalPaneFocused(id);
    },
    [onTerminalPaneFocused],
  );

  const renderTerminalPane = useCallback(
    (instance: TerminalInstance, opts: { isLast: boolean; showChrome: boolean }) => {
      const isTarget = terminalKeyboardTargetId === instance.id;
      return (
        <div
          key={instance.paneId}
          className={cn(
            'relative flex min-h-0 min-w-0 flex-1 flex-col',
            !opts.isLast && 'border-r border-border/35',
          )}
        >
          {opts.showChrome && onCloseSplitPane && (
            <div className="absolute right-1 top-1 z-10">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 w-6 rounded-md bg-background/80 p-0 text-muted-foreground shadow-xs backdrop-blur-xs hover:bg-background hover:text-foreground"
                aria-label={`Close terminal pane ${instance.name}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onCloseSplitPane(instance.id);
                }}
                iconOnly
              >
                <X className="h-3 w-3" />
              </Button>
            </div>
          )}
          <div
            role="group"
            data-testid={`terminal-pane-wrapper-${instance.id}`}
            data-terminal-id={instance.id}
            aria-label={`Terminal pane ${instance.name}`}
            className="flex min-h-0 min-w-0 flex-1 flex-col rounded-sm outline-hidden focus-visible:ring-2 focus-visible:ring-ring/60"
            tabIndex={isPaneActive ? 0 : -1}
            onFocus={handleSplitPaneFocusIntent}
          >
            <Terminal
              terminalId={instance.id}
              paneId={instance.paneId}
              cwd={cwd}
              workspaceId={workspaceId}
              tabId={tabId}
              initialCommands={initialCommands}
              initialCwd={cwd}
              isKeyboardTarget={showSplit ? isTarget : undefined}
              isPaneActive={isPaneActive}
            />
          </div>
        </div>
      );
    },
    [
      cwd,
      workspaceId,
      tabId,
      initialCommands,
      terminalKeyboardTargetId,
      handleSplitPaneFocusIntent,
      showSplit,
      onCloseSplitPane,
      isPaneActive,
    ],
  );

  return (
    <div
      className={cn(
        'relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden',
        surfaceClassName,
      )}
    >
      <div
        className="chat-canvas-atmosphere pointer-events-none absolute inset-0 z-0 overflow-hidden"
        aria-hidden
      />
      <div
        className="relative z-1 flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
        style={{ backgroundColor: terminalBg }}
        inert={isPaneActive ? undefined : true}
      >
        {showSplit ? (
          <div className="flex min-h-0 min-w-0 flex-1 flex-row">
            {splitPaneTerminals.map((inst, i) =>
              renderTerminalPane(inst, {
                isLast: i === splitPaneTerminals.length - 1,
                showChrome: true,
              }),
            )}
          </div>
        ) : activeTerminal && canRenderTerminal ? (
          <div key={activeTerminal.paneId} className="h-full min-h-0">
            <Terminal
              terminalId={activeTerminal.id}
              paneId={activeTerminal.paneId}
              cwd={cwd}
              workspaceId={workspaceId}
              tabId={tabId}
              initialCommands={initialCommands}
              initialCwd={cwd}
              isPaneActive={isPaneActive}
            />
          </div>
        ) : (
          <div
            className="flex h-full min-h-0 items-center justify-center text-sm text-muted-foreground"
            role="status"
            aria-live={!canRenderTerminal ? 'polite' : undefined}
            aria-busy={!canRenderTerminal}
          >
            {!canRenderTerminal ? 'Starting terminal…' : 'No terminal open'}
          </div>
        )}
      </div>
    </div>
  );
});
