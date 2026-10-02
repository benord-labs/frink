import { Fragment, memo, type ReactNode } from 'react';
import { DiffToggleButton } from './diff-toggle-button';
import { FileTreeToggleButton } from './file-tree-toggle-button';
import { TerminalToggleButton } from './terminal-toggle-button';

const NOOP = () => {};

/** Tinted wrapper for the inline variant. No blur: the header behind it is static, so a blur changes
 *  no pixel but costs a GPU pass per button whenever the header is damaged. */
function InlineWrapper({ children }: { children: ReactNode }) {
  return (
    <div
      className="rounded-md bg-background/10 flex items-center justify-center"
      style={{
        // @ts-expect-error - WebKit-specific property
        // biome-ignore lint/style/useNamingConvention: vendor-prefixed CSS property name
        WebkitAppRegion: 'no-drag',
      }}
    >
      {children}
    </div>
  );
}

type PaneUtilityButtonsProps = {
  /** "inline" wraps each button in a tinted container; "plain" renders bare buttons. */
  variant?: 'inline' | 'plain';

  /** Show file tree toggle */
  showFileTree: boolean;
  fileTreeOpen?: boolean;
  hasModifiedFiles?: boolean;
  onToggleFileTree?: () => void;

  /** Show view-changes / diff sidebar toggle */
  showDiff?: boolean;
  diffStats?: { isLoading: boolean; hasChanges: boolean };
  onOpenDiff?: () => void;

  /** Show terminal toggle */
  showTerminal: boolean;
  terminalOpen?: boolean;
  onToggleTerminal?: () => void;
};

/**
 * Shared button group for pane-level utility actions (file tree, view changes, terminal).
 * Used by ChatHeader, NewChatFormHeader.
 */
export const PaneUtilityButtons = memo(function PaneUtilityButtons({
  variant = 'inline',
  showFileTree,
  fileTreeOpen = false,
  hasModifiedFiles = false,
  onToggleFileTree,
  showDiff = false,
  diffStats,
  onOpenDiff,
  showTerminal,
  terminalOpen = false,
  onToggleTerminal,
}: PaneUtilityButtonsProps) {
  const hasAny = showFileTree || showDiff || showTerminal;

  if (!hasAny) return null;

  // biome-ignore lint/style/useNamingConvention: Renders as a component
  const Wrap = variant === 'inline' ? InlineWrapper : Fragment;

  return (
    <div className="flex items-center gap-1">
      {showFileTree && (
        <Wrap>
          <FileTreeToggleButton
            isOpen={fileTreeOpen}
            hasModifiedFiles={hasModifiedFiles}
            onToggle={onToggleFileTree ?? NOOP}
          />
        </Wrap>
      )}
      {showDiff && diffStats && (
        <Wrap>
          <DiffToggleButton
            isLoading={diffStats.isLoading}
            hasChanges={diffStats.hasChanges}
            onClick={onOpenDiff}
          />
        </Wrap>
      )}
      {showTerminal && (
        <Wrap>
          <TerminalToggleButton isOpen={terminalOpen} onClick={onToggleTerminal ?? NOOP} />
        </Wrap>
      )}
    </div>
  );
});
