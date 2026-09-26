import { Button } from '@benord-labs/frink-primitives';
import { PanelLeft } from 'lucide-react';
import { useContext } from 'react';
import { cn } from '@/lib/utils';
import { MainPaneInsetContext } from '../SidebarMainPaneLayout';
import { Kbd } from './kbd';
import { Tooltip, TooltipContent, TooltipTrigger } from './tooltip';

type OpenSidebarButtonProps = {
  /** Current open state of the sidebar this button targets. Hides itself when true. */
  isSidebarOpen: boolean;
  onOpenSidebar: () => void;
  hasUnseenChanges?: boolean;
  /** Whether the surrounding header should retain an in-flow slot for the control. */
  reserveLayoutSpace?: boolean;
};

/** Small trigger that reopens a collapsed unified sidebar. Renders nothing while it's open. */
export function OpenSidebarButton({
  isSidebarOpen,
  onOpenSidebar,
  hasUnseenChanges = false,
  reserveLayoutSpace = true,
}: OpenSidebarButtonProps) {
  const isMainPaneInset = useContext(MainPaneInsetContext);
  if (isSidebarOpen) return null;

  return (
    // The slot (from the header's `--open-sidebar-slot-start`) ends where the positioned button
    // ends, so the next control keeps the header gap; Work Queue flattens it (`contents`).
    <span
      className={cn(
        reserveLayoutSpace ? 'block h-6 shrink-0' : 'contents',
        reserveLayoutSpace &&
          (isMainPaneInset
            ? 'w-[calc(var(--open-sidebar-button-left,1rem)-var(--open-sidebar-button-inset,0.5rem)+1.5rem-var(--open-sidebar-slot-start,0.5rem))]'
            : 'w-[calc(var(--open-sidebar-button-left,1rem)+1.5rem-var(--open-sidebar-slot-start,0.5rem))]'),
      )}
    >
      <Tooltip delayDuration={500}>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            onClick={onOpenSidebar}
            className={cn(
              'no-drag [position:var(--open-sidebar-button-position,absolute)] z-30 h-6 w-6 shrink-0 rounded-md p-0 text-foreground',
              '[zoom:calc(1/var(--pane-zoom-factor,1))] transition-[background-color,transform] duration-150 ease-out active:scale-[0.97]',
            )}
            // An inset main pane sits 0.5rem further right, so pull the button back by that much;
            // containers whose offset is not pane-relative zero `--open-sidebar-button-inset`.
            style={{
              left: isMainPaneInset
                ? 'calc(var(--open-sidebar-button-left,1rem) - var(--open-sidebar-button-inset,0.5rem))'
                : 'var(--open-sidebar-button-left,1rem)',
            }}
            aria-label="Open sidebar"
            iconOnly
          >
            <PanelLeft className="h-4 w-4" />
            {hasUnseenChanges && (
              <div className="absolute top-0.5 right-0.5 w-2 h-2 rounded-full bg-pane-accent ring-2 ring-background" />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          Open sidebar
          <Kbd shortcutId="toggle-sidebar" />
        </TooltipContent>
      </Tooltip>
    </span>
  );
}
