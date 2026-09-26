import { Button } from '@benord-labs/frink-primitives';
import { useAtom } from 'jotai';
import { memo } from 'react';
import { PanelBottom, PanelRight } from 'lucide-react';
import { Kbd } from '@/components/ui/kbd';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { panelTabButtonClass } from '@/features/sidebar/panel-tab-button-class';
import { cn } from '@/lib/utils';
import { type TerminalDisplayMode, terminalDisplayModeAtom } from './atoms';

// biome-ignore-start lint/style/useNamingConvention: Icon is a React component constructor, PascalCase required for JSX
const MODES: { value: TerminalDisplayMode; label: string; Icon: typeof PanelRight }[] = [
  { value: 'side-peek', label: 'Sidebar', Icon: PanelRight },
  { value: 'bottom', label: 'Bottom', Icon: PanelBottom },
];
// biome-ignore-end lint/style/useNamingConvention: Icon is a React component constructor, PascalCase required for JSX

/**
 * Inline toggle to switch terminal between sidebar and bottom panel modes.
 * Matches Files / unified sidebar tab chips (no bordered segment).
 */
export const TerminalModeSwitcher = memo(function TerminalModeSwitcher() {
  const [displayMode, setDisplayMode] = useAtom(terminalDisplayModeAtom);

  return (
    <div className="flex shrink-0 items-center gap-1">
      {MODES.map(({ value, label, Icon }) => (
        <Tooltip key={value}>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setDisplayMode(value)}
              className={cn(
                panelTabButtonClass(displayMode === value, 'xs'),
                'flex shrink-0 px-0! py-0!',
              )}
              aria-label={`Terminal ${label} mode`}
              aria-pressed={displayMode === value}
            >
              <Icon className="h-3 w-3" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="text-xs">
            {label}
            {displayMode !== value && <Kbd shortcutId="toggle-terminal-mode" />}
          </TooltipContent>
        </Tooltip>
      ))}
    </div>
  );
});
