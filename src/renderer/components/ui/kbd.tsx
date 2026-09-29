import { useAtomValue } from 'jotai';
import * as React from 'react';
import { customHotkeysAtom } from '../../lib/atoms';
import type { ShortcutActionId } from '../../lib/hotkeys';
import { getResolvedKeys, keysToAriaLabel, keysToDisplayPlatform } from '../../lib/hotkeys';
import { cn } from '../../lib/utils';
import { isMacOS } from '../../lib/utils/platform';
import { Command, CornerDownLeft, OptionIcon, ArrowBigUp } from 'lucide-react';

type KbdProps = React.HTMLAttributes<HTMLElement> & {
  /** When provided, resolves the shortcut display from the registry (platform-aware, respects custom overrides). */
  shortcutId?: ShortcutActionId;
};

const KBD_CLASS =
  'pointer-events-none inline-flex items-center gap-0.5 text-xs leading-none font-medium uppercase tracking-wide text-muted-foreground/60';

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

/**
 * Registry-backed shortcut hint. Subscribes to customHotkeysAtom so both the visible keys and
 * the aria-label follow the user's binding; an unbound shortcut renders empty and unlabelled.
 */
const ShortcutKbd = React.forwardRef<
  HTMLElement,
  Omit<KbdProps, 'children' | 'shortcutId'> & { shortcutId: ShortcutActionId }
>(({ className, shortcutId, ...props }, ref) => {
  const config = useAtomValue(customHotkeysAtom);
  const mac = isMacOS();
  const keys = getResolvedKeys(shortcutId, config);
  const hasKeys = keys !== null && keys.length > 0;
  const display = hasKeys ? keysToDisplayPlatform(keys, mac) : null;
  return (
    <kbd
      ref={ref}
      aria-label={hasKeys ? keysToAriaLabel(keys, mac) : undefined}
      className={cn(KBD_CLASS, className)}
      {...props}
    >
      {display !== null && mac ? renderShortcut(display) : display}
    </kbd>
  );
});
ShortcutKbd.displayName = 'ShortcutKbd';

/** Shortcut hint. With `shortcutId`: the user's binding, ⌘⇧F on Mac / Ctrl+Shift+F elsewhere by
 * design, aria-label in words (a caller's wins). Without it, `children` render as given. */
const Kbd = React.forwardRef<HTMLElement, KbdProps>(
  ({ className, children, shortcutId, ...props }, ref) => {
    if (shortcutId) {
      return <ShortcutKbd ref={ref} shortcutId={shortcutId} className={className} {...props} />;
    }
    return (
      <kbd ref={ref} className={cn(KBD_CLASS, className)} {...props}>
        {renderShortcut(children)}
      </kbd>
    );
  },
);
Kbd.displayName = 'Kbd';

export { Kbd };
