import { Button } from '@benord-labs/frink-primitives';
import { FileJson, Loader2, MoreHorizontal, Plus, RefreshCw } from 'lucide-react';
import { memo } from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

type Props = {
  isRefreshing: boolean;
  onRefresh: () => void;
  onEditRawConfig: () => void;
  onAddClick: () => void;
};

/** "Add server" leads; the developer tools sit one click away in the overflow. */
export const Header = memo(function Header({
  isRefreshing,
  onRefresh,
  onEditRawConfig,
  onAddClick,
}: Props) {
  return (
    <div className="flex shrink-0 items-center gap-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" iconOnly aria-label="More server options">
            {isRefreshing ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <MoreHorizontal className="size-4" />
            )}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={onRefresh} disabled={isRefreshing}>
            <RefreshCw className="mr-2 size-3.5" />
            Check for new servers
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onEditRawConfig}>
            <FileJson className="mr-2 size-3.5" />
            Edit config file
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Button size="sm" onClick={onAddClick}>
        <Plus className="mr-1.5 size-3.5" />
        Add server
      </Button>
    </div>
  );
});
