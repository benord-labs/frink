import discordLogo from '@iconify-icons/simple-icons/discord';
import { iconifyComponent } from '@/lib/utils/iconify-component';
/**
 * SidebarFooter - Settings, archive toggle, plan usage, Discord, files, and machine status.
 * Primary destinations (Flows, Work Queue) live at the top in SidebarNav.
 */

import { Button } from '@benord-labs/frink-primitives';
import { Archive, FolderGit2, Gauge, Settings } from 'lucide-react';
import { memo, type ReactElement, type ReactNode } from 'react';
import { Kbd } from '../../../../../components/ui/kbd';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../../../components/ui/tooltip';
import { useSettingsNavigation } from '../../../../../hooks/useSettingsNavigation';
import { cn } from '../../../../../lib/utils';
import { DISCORD_INVITE_URL, STRINGS, TIMING } from '../../constants';
import { StatusDot } from '../StatusDot';

const DiscordIcon = iconifyComponent(discordLogo);

type SidebarFooterProps = {
  onSettings: () => void;
  showArchived: boolean;
  onToggleArchived: () => void;
  archivedChatsCount: number;
  /** Show files button when a local project is selected */
  showFilesButton?: boolean;
  isFilesSidebarOpen?: boolean;
  onToggleFilesSidebar?: () => void;
  /** Show dot on files button when there are modified (staged/unstaged/untracked) files */
  hasModifiedFiles?: boolean;
};

function FooterIconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}): ReactElement {
  return (
    <Tooltip delayDuration={TIMING.TOOLTIP_DELAY_MS}>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          onClick={onClick}
          className="text-muted-foreground"
          aria-label={label}
          iconOnly
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/** Files toggle, with a dot while the project has modified (staged/unstaged/untracked) files. */
function FilesToggleButton({
  isFilesSidebarOpen,
  onToggleFilesSidebar,
  hasModifiedFiles,
}: {
  isFilesSidebarOpen?: boolean;
  onToggleFilesSidebar: () => void;
  hasModifiedFiles: boolean;
}): ReactElement {
  return (
    <Tooltip delayDuration={TIMING.TOOLTIP_DELAY_MS}>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          onClick={onToggleFilesSidebar}
          className={cn(
            'relative',
            isFilesSidebarOpen ? 'bg-muted text-foreground' : 'text-muted-foreground',
          )}
          aria-label="Toggle files"
          iconOnly
        >
          <FolderGit2 className="h-4 w-4" />
          {hasModifiedFiles && (
            <span
              className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-amber-500 ring-2 ring-background"
              aria-hidden
            />
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {isFilesSidebarOpen ? 'Close files' : 'Browse files'}
        {hasModifiedFiles && ' (modified files)'}
        <Kbd shortcutId="toggle-files" />
      </TooltipContent>
    </Tooltip>
  );
}

function SidebarFooterComponent({
  onSettings,
  showArchived,
  onToggleArchived,
  archivedChatsCount,
  showFilesButton,
  isFilesSidebarOpen,
  onToggleFilesSidebar,
  hasModifiedFiles = false,
}: SidebarFooterProps): ReactElement {
  const { openSettingsTab } = useSettingsNavigation();
  return (
    <div className="p-2 pt-1 shrink-0 border-t border-border/30 space-y-1">
      {/* Actions row */}
      <div className="flex items-center gap-1">
        <FooterIconButton label={STRINGS.SETTINGS} onClick={onSettings}>
          <Settings className="h-4 w-4" />
        </FooterIconButton>

        <Tooltip delayDuration={TIMING.TOOLTIP_DELAY_MS}>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              onClick={onToggleArchived}
              className={cn(
                'h-7 px-2',
                showArchived ? 'bg-muted text-foreground' : 'text-muted-foreground',
              )}
              aria-label={showArchived ? 'Hide archived chats' : STRINGS.ARCHIVE}
            >
              <Archive className="h-4 w-4" />
              {archivedChatsCount > 0 && (
                <span className="ml-1 text-[10px]">{archivedChatsCount}</span>
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {showArchived ? 'Hide archived' : `${STRINGS.ARCHIVE} (${archivedChatsCount})`}
            <Kbd shortcutId="toggle-archived" />
          </TooltipContent>
        </Tooltip>

        <FooterIconButton label="Plan usage" onClick={() => openSettingsTab('usage')}>
          <Gauge className="h-4 w-4" />
        </FooterIconButton>

        <FooterIconButton
          label={STRINGS.DISCORD}
          onClick={() => window.desktopApi.openExternal(DISCORD_INVITE_URL)}
        >
          <DiscordIcon className="h-4 w-4" />
        </FooterIconButton>

        <div className="flex-1" />

        {/* Files button - shown when a local project is selected */}
        {showFilesButton && onToggleFilesSidebar && (
          <FilesToggleButton
            isFilesSidebarOpen={isFilesSidebarOpen}
            onToggleFilesSidebar={onToggleFilesSidebar}
            hasModifiedFiles={hasModifiedFiles}
          />
        )}
      </div>

    </div>
  );
}

export const SidebarFooter = memo(SidebarFooterComponent);
