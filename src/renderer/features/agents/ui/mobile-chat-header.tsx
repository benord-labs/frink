import { Button } from '@benord-labs/frink-primitives';
import { useAtomValue } from 'jotai';
import {
  AlignJustify,
  Play,
  Hammer,
  SquareTerminal,
  Diff,
  Loader2,
  Undo2,
  MapIcon,
} from 'lucide-react';
import { useMemo } from 'react';
import { cn } from '../../../lib/utils';
import { loadingSubChatsAtom } from '../atoms';
import { useAgentSubChatStore } from '../stores/sub-chat-store';

type DiffStats = {
  fileCount: number;
  additions: number;
  deletions: number;
  isLoading: boolean;
  hasChanges: boolean;
};

type MobileChatHeaderProps = {
  onBackToChats?: () => void;
  onOpenPreview?: () => void;
  canOpenPreview?: boolean;
  onOpenDiff?: () => void;
  canOpenDiff?: boolean;
  diffStats?: DiffStats;
  onOpenTerminal?: () => void;
  canOpenTerminal?: boolean;
  isArchived?: boolean;
  onRestore?: () => void;
};

export function MobileChatHeader({
  onBackToChats,
  onOpenPreview,
  canOpenPreview = false,
  onOpenDiff,
  canOpenDiff = false,
  diffStats,
  onOpenTerminal,
  canOpenTerminal = false,
  isArchived = false,
  onRestore,
}: MobileChatHeaderProps) {
  const activeSubChatId = useAgentSubChatStore((state) => state.activeSubChatId);
  const subChatsById = useAgentSubChatStore((state) => state.subChatsById);
  const loadingSubChatsAtomValue = useAtomValue(loadingSubChatsAtom);

  // Find active sub-chat metadata
  const activeSubChat = useMemo(() => {
    return activeSubChatId ? subChatsById[activeSubChatId] : undefined;
  }, [subChatsById, activeSubChatId]);

  const isLoading = activeSubChatId ? loadingSubChatsAtomValue.has(activeSubChatId) : false;
  const mode = activeSubChat?.mode || 'agent';

  return (
    <div
      className="flex items-center gap-1.5 h-7 w-full min-w-0"
      style={{
        // @ts-expect-error - WebKit-specific property for Electron window dragging
        // biome-ignore lint/style/useNamingConvention: vendor-prefixed CSS property name
        WebkitAppRegion: 'drag',
      }}
    >
      {/* Burger button - opens all projects */}
      {onBackToChats && (
        <Button
          variant="ghost"
          size="sm"
          onClick={onBackToChats}
          className="h-7 w-7 p-0 transition-[background-color,transform] duration-150 ease-out active:scale-[0.97] shrink-0 rounded-md"
          aria-label="All projects"
          style={{
            // @ts-expect-error - WebKit-specific property
            // biome-ignore lint/style/useNamingConvention: vendor-prefixed CSS property name
            WebkitAppRegion: 'no-drag',
          }}
          iconOnly
        >
          <AlignJustify className="h-4 w-4" />
        </Button>
      )}

      {/* Chat title */}
      <div
        className={cn(
          'flex items-center gap-1.5 h-7 px-2 rounded-md text-sm',
          'bg-muted/50',
          'min-w-0 max-w-[50vw] shrink',
        )}
        style={{
          // @ts-expect-error - WebKit-specific property
          // biome-ignore lint/style/useNamingConvention: vendor-prefixed CSS property name
          WebkitAppRegion: 'no-drag',
        }}
      >
        <div className="shrink-0 w-3.5 h-3.5 flex items-center justify-center">
          {isLoading ? (
            <Loader2 className="w-3.5 h-3.5 text-muted-foreground animate-spin" />
          ) : mode === 'plan' ? (
            <MapIcon className="w-3.5 h-3.5 text-muted-foreground" />
          ) : (
            <Hammer className="w-3.5 h-3.5 text-muted-foreground" />
          )}
        </div>
        <span className="truncate text-left">{activeSubChat?.name || 'New Chat'}</span>
      </div>

      {/* Spacer to push buttons to the right */}
      <div className="flex-1" />

      {/* Action buttons - always on the right */}
      <div
        className="flex items-center gap-0.5 shrink-0"
        style={{
          // @ts-expect-error - WebKit-specific property
          // biome-ignore lint/style/useNamingConvention: vendor-prefixed CSS property name
          WebkitAppRegion: 'no-drag',
        }}
      >
        {/* Terminal button */}
        {onOpenTerminal && canOpenTerminal && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onOpenTerminal}
            className="h-7 w-7 p-0 transition-[background-color,transform] duration-150 ease-out active:scale-[0.97] rounded-md"
            iconOnly
          >
            <SquareTerminal className="h-4 w-4" />
          </Button>
        )}

        {/* Diff button */}
        {onOpenDiff && canOpenDiff && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onOpenDiff}
            disabled={!diffStats?.hasChanges || diffStats?.isLoading}
            className={cn(
              'h-7 w-7 p-0 transition-[background-color,transform] duration-150 ease-out active:scale-[0.97] rounded-md',
              diffStats?.hasChanges && !diffStats?.isLoading ? '' : 'text-muted-foreground',
            )}
            iconOnly
          >
            {diffStats?.isLoading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Diff className="h-4 w-4" />
            )}
          </Button>
        )}

        {/* Preview button */}
        {onOpenPreview && canOpenPreview && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onOpenPreview}
            className="h-7 w-7 p-0 transition-[background-color,transform] duration-150 ease-out active:scale-[0.97] rounded-md"
            iconOnly
          >
            <Play className="h-4 w-4" />
          </Button>
        )}

        {/* Restore button - only when viewing archived workspace */}
        {isArchived && onRestore && (
          <Button
            variant="ghost"
            onClick={onRestore}
            className="h-7 px-2 gap-1.5 transition-[background-color,transform] duration-150 ease-out active:scale-[0.97] rounded-md flex"
          >
            <Undo2 className="h-4 w-4" />
            <span className="text-xs">Restore</span>
          </Button>
        )}
      </div>
    </div>
  );
}
