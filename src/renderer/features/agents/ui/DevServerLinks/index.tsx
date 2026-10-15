import { ExternalLink, Globe } from 'lucide-react';
import { memo, useState } from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../../../components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../../components/ui/tooltip';
import { trpc } from '../../../../lib/trpc';
import { HeaderBadge } from '../header-badge';

type DevServerLink = { port: number; label: string; url: string };

/** Styled like the header's Task badge; collapses to its icon when the pane is narrow. */
const badgeClass =
  'h-6 gap-1.5 rounded-md bg-transparent px-1.5 text-xs text-foreground shrink-0 @max-[26rem]/pane-header:w-6 @max-[26rem]/pane-header:justify-center @max-[26rem]/pane-header:px-0';
const iconClass = 'h-3 w-3 shrink-0 @max-[26rem]/pane-header:h-4 @max-[26rem]/pane-header:w-4';
const labelClass = 'truncate @max-[26rem]/pane-header:sr-only';

function linkText(server: DevServerLink): string {
  return `${server.label} · ${server.url.replace('http://', '')}`;
}

type DevServerLinksViewProps = {
  servers: DevServerLink[];
  onOpen: (url: string) => void;
};

/** Links to the dev servers running from this chat's folder; renders nothing when none are. */
export function DevServerLinks({ path }: { path?: string | null }) {
  if (!path) return null;
  return <LiveDevServerLinks key={path} path={path} />;
}

const LiveDevServerLinks = memo(function LiveDevServerLinks({ path }: { path: string }) {
  const [servers, setServers] = useState<DevServerLink[]>([]);
  trpc.terminal.devServers.useSubscription({ path }, { onData: setServers });
  return <DevServerLinksView servers={servers} onOpen={openInBrowser} />;
});

function openInBrowser(url: string): void {
  void window.desktopApi.openExternal(url);
}

export function DevServerLinksView({ servers, onOpen }: DevServerLinksViewProps) {
  if (servers.length === 0) return null;

  if (servers.length === 1) {
    const server = servers[0];
    return (
      <Tooltip delayDuration={500}>
        <TooltipTrigger asChild>
          <HeaderBadge onClick={() => onOpen(server.url)} className={badgeClass}>
            <span className={labelClass}>{linkText(server)}</span>
            <ExternalLink className={iconClass} aria-hidden />
          </HeaderBadge>
        </TooltipTrigger>
        <TooltipContent side="bottom">Open in browser</TooltipContent>
      </Tooltip>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <HeaderBadge variant="menuTrigger" className={badgeClass}>
          <Globe className={iconClass} aria-hidden />
          <span className={labelClass}>{servers.length} servers</span>
        </HeaderBadge>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {servers.map((server) => (
          <DropdownMenuItem key={server.url} onSelect={() => onOpen(server.url)}>
            <span className="flex-1 truncate">{linkText(server)}</span>
            <ExternalLink className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
