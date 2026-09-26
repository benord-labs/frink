import { useAtomValue } from 'jotai';
import * as React from 'react';
import { customHotkeysAtom } from '../../lib/atoms';
import type { ShortcutActionId } from '../../lib/hotkeys';
import { getResolvedKeys, getShortcutAction, keysToDisplayPlatform } from '../../lib/hotkeys';
import { cn } from '../../lib/utils';
import { isMacOS } from '../../lib/utils/platform';
import { Command, CornerDownLeft, OptionIcon, ArrowBigUp } from 'lucide-react';

type KbdProps = React.HTMLAttributes<HTMLElement> & {
  /** When provided, resolves the shortcut display from the registry (platform-aware, respects custom overrides). */
  shortcutId?: ShortcutActionId;
};

// Regex pattern for parsing keyboard shortcut symbols - hoisted to module level for performance
const SHORTCUT_SYMBOL_REGEX = /([⌘⌥⇧⌃↵])/g;

/** Parse shortcut string and replace modifier symbols with icons */
function renderShortcut(children: React.ReactNode): React.ReactNode {
  if (typeof children !== 'string') return children;

  const parts: React.ReactNode[] = [];

  // Map of symbols to icons (3 = 12px to match text-xs visually)
  const symbolMap: Record<string, React.ReactNode> = {
    '⌘': <Command key="cmd" className="h-3 w-3" />,
    '⌥': <OptionIcon key="opt" className="h-3 w-3" />,
    '⇧': <ArrowBigUp key="shift" className="h-3 w-3" />,
    '⌃': <span key="ctrl">⌃</span>, // Control stays as unicode (no icon)
    '↵': <CornerDownLeft key="enter" className="h-3 w-3" />,
  };

  // Split by symbols and replace with icons
  const tokens = children.split(SHORTCUT_SYMBOL_REGEX);

  let position = 0;
  tokens.forEach((token) => {
    if (symbolMap[token]) {
      parts.push(symbolMap[token]);
      position += token.length;
    } else if (token) {
      const key = `${token}-${position}`;
      parts.push(<span key={key}>{token}</span>);
      position += token.length;
    }
  });

  return parts;
}

/** Resolves aria-label from default keys (no atom subscription needed). */
function getShortcutAriaLabel(shortcutId: ShortcutActionId): string | undefined {
  const action = getShortcutAction(shortcutId);
  if (!action) return undefined;
  // Always use text representation for screen readers (e.g., "Ctrl+Shift+F")
  return keysToDisplayPlatform(action.defaultKeys, false);
}

/**
 * Inner component that subscribes to customHotkeysAtom.
 * Only mounted when shortcutId is provided, so Kbd instances without
 * shortcutId avoid the atom subscription entirely.
 */
function ShortcutDisplay({ shortcutId }: { shortcutId: ShortcutActionId }) {
  const config = useAtomValue(customHotkeysAtom);
  const mac = isMacOS();
  const keys = getResolvedKeys(shortcutId, config);
  if (!keys || keys.length === 0) return null;
  const display = keysToDisplayPlatform(keys, mac);
  return <>{mac ? renderShortcut(display) : display}</>;
}

const Kbd = React.forwardRef<HTMLElement, KbdProps>(
  ({ className, children, shortcutId, ...props }, ref) => {
    return (
      <kbd
        ref={ref}
        aria-label={shortcutId ? getShortcutAriaLabel(shortcutId) : undefined}
        className={cn(
          'pointer-events-none inline-flex items-center gap-0.5 text-xs leading-none font-medium uppercase tracking-wide text-muted-foreground/60',
          className,
        )}
        {...props}
      >
        {shortcutId ? <ShortcutDisplay shortcutId={shortcutId} /> : renderShortcut(children)}
      </kbd>
    );
  },
);
Kbd.displayName = 'Kbd';

export { Kbd };
