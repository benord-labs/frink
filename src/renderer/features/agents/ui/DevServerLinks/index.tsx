import { Button } from '@benord-labs/frink-primitives';
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

type DevServerLink = { port: number; label: string; url: string };

const PREVIEW_LABEL = 'Preview in browser';

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

/** One icon like the pane toggles beside it; its menu names each server's port before opening. */
export function DevServerLinksView({ servers, onOpen }: DevServerLinksViewProps) {
  if (servers.length === 0) return null;

  return (
    <div className="rounded-md bg-background/10 flex items-center justify-center">
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                aria-label={PREVIEW_LABEL}
                className="h-6 w-6 p-0 text-foreground transition-[background-color,transform] duration-150 ease-out active:scale-[0.97] shrink-0 rounded-md flex"
                iconOnly
              >
                <Globe className="h-4 w-4" aria-hidden />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom">{PREVIEW_LABEL}</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end">
          {servers.map((server) => (
            <DropdownMenuItem key={server.url} onSelect={() => onOpen(server.url)}>
              <span className="truncate">{server.label}</span>{' '}
              <span className="ml-auto pl-3 text-muted-foreground">
                {server.url.replace('http://', '')}
              </span>
              <ExternalLink className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
