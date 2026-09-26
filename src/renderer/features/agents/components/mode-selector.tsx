import { Button } from '@benord-labs/frink-primitives';
import { createPortal } from 'react-dom';
import type { ChatMode } from '../../../../shared/types/chat-mode';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../../components/ui/dropdown-menu';
import { Hammer, Check, ChevronDown, MapIcon, Wrench } from 'lucide-react';
import { overlayGlass } from '@/lib/overlay-styles';
import { cn } from '../../../lib/utils';
import {
  COMPOSER_CONTROL_CLASS,
  COMPOSER_CONTROL_LABEL_CLASS,
} from '../main/chat-composer-shell-classes';
import { STRINGS } from '../main/new-chat-form-constants';

export const MODE_CONFIG: Record<
  ChatMode,
  { icon: typeof Hammer; label: string; tooltip: string }
> = {
  agent: { icon: Hammer, label: STRINGS.MODE_AGENT, tooltip: STRINGS.TOOLTIP_AGENT },
  plan: { icon: MapIcon, label: STRINGS.MODE_PLAN, tooltip: STRINGS.TOOLTIP_PLAN },
  debug: { icon: Wrench, label: STRINGS.MODE_DEBUG, tooltip: STRINGS.TOOLTIP_DEBUG },
};

type ModeSelectorProps = {
  chatMode: ChatMode;
  onModeChange: (mode: ChatMode) => void;
  modeDropdownOpen: boolean;
  onDropdownOpenChange: (open: boolean) => void;
  modeTooltip: {
    visible: boolean;
    position: { top: number; left: number };
    mode: ChatMode;
  } | null;
  onTooltipChange: (tooltip: ModeSelectorProps['modeTooltip']) => void;
  tooltipTimeoutRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>;
  hasShownTooltipRef: React.MutableRefObject<boolean>;
  /** Hide the debug option (e.g. general chats without a project) */
  disableDebugMode?: boolean;
};

/**
 * Mode selector dropdown (Agent/Plan/Debug)
 * Shows tooltip on hover with configurable delay
 */
export function ModeSelector({
  chatMode,
  onModeChange,
  modeDropdownOpen,
  onDropdownOpenChange,
  modeTooltip,
  onTooltipChange,
  tooltipTimeoutRef,
  hasShownTooltipRef,
  disableDebugMode,
}: ModeSelectorProps) {
  const clearTooltipTimeout = () => {
    if (tooltipTimeoutRef.current) {
      clearTimeout(tooltipTimeoutRef.current);
      tooltipTimeoutRef.current = null;
    }
  };

  const handleModeSelect = (mode: ChatMode) => {
    clearTooltipTimeout();
    onTooltipChange(null);
    onModeChange(mode);
    onDropdownOpenChange(false);
  };

  const handleDropdownOpenChange = (open: boolean) => {
    onDropdownOpenChange(open);
    if (!open) {
      clearTooltipTimeout();
      onTooltipChange(null);
      hasShownTooltipRef.current = false;
    }
  };

  const handleMouseEnter = (e: React.MouseEvent<HTMLDivElement>, mode: ChatMode) => {
    clearTooltipTimeout();

    const rect = e.currentTarget.getBoundingClientRect();
    const showTooltip = () => {
      onTooltipChange({
        visible: true,
        position: {
          top: rect.top,
          left: rect.right + 8,
        },
        mode,
      });
      hasShownTooltipRef.current = true;
      tooltipTimeoutRef.current = null;
    };

    if (hasShownTooltipRef.current) {
      showTooltip();
    } else {
      tooltipTimeoutRef.current = setTimeout(showTooltip, 1000);
    }
  };

  const handleMouseLeave = () => {
    clearTooltipTimeout();
    onTooltipChange(null);
  };

  const currentConfig = MODE_CONFIG[chatMode];
  // biome-ignore lint/style/useNamingConvention: Renders as a component
  const CurrentIcon = currentConfig.icon;

  return (
    <DropdownMenu modal={false} open={modeDropdownOpen} onOpenChange={handleDropdownOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Mode: ${currentConfig.label}`}
          title={currentConfig.label}
          className={COMPOSER_CONTROL_CLASS}
        >
          <CurrentIcon className="h-4 w-4 shrink-0" />
          <span className={COMPOSER_CONTROL_LABEL_CLASS}>{currentConfig.label}</span>
          <ChevronDown
            className={cn('h-3 w-3 shrink-0 opacity-50', COMPOSER_CONTROL_LABEL_CLASS)}
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        sideOffset={6}
        className="min-w-[116px]! w-[116px]!"
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        {(['agent', 'plan', 'debug'] as ChatMode[])
          .filter((m) => !disableDebugMode || m !== 'debug')
          .map((mode) => {
            const config = MODE_CONFIG[mode];
            // biome-ignore lint/style/useNamingConvention: Renders as a component
            const Icon = config.icon;
            return (
              <DropdownMenuItem
                key={mode}
                onSelect={() => handleModeSelect(mode)}
                className="justify-between gap-2"
                onMouseEnter={(e) => handleMouseEnter(e, mode)}
                onMouseLeave={handleMouseLeave}
              >
                <div className="flex items-center gap-2">
                  <Icon className="w-4 h-4 text-muted-foreground" />
                  <span>{config.label}</span>
                </div>
                {chatMode === mode && <Check className="h-3.5 w-3.5 ml-auto shrink-0" />}
              </DropdownMenuItem>
            );
          })}
      </DropdownMenuContent>
      {modeTooltip?.visible &&
        createPortal(
          <div
            className="fixed z-100000"
            style={{
              top: modeTooltip.position.top + 14,
              left: modeTooltip.position.left,
              transform: 'translateY(-50%)',
            }}
          >
            <div
              data-tooltip="true"
              className={cn(
                'relative rounded-[12px] border px-2.5 py-1.5 text-xs text-popover-foreground dark max-w-[150px]',
                overlayGlass,
              )}
            >
              <span>{MODE_CONFIG[modeTooltip.mode].tooltip}</span>
            </div>
          </div>,
          document.body,
        )}
    </DropdownMenu>
  );
}
