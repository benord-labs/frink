import { Button, Input } from '@benord-labs/frink-primitives';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useMemo, useState } from 'react';
import {
  CanvasDialogBody,
  CanvasDialogContent,
  CanvasDialogHeader,
  Dialog,
  DialogTitle,
} from '../../../components/ui/dialog';
import { GitBranch } from 'lucide-react';
import { createHighlightMatcher } from '../../../lib/highlight-match';
import { STRINGS } from '../main/new-chat-form-constants';
import { formatTimeAgo } from '../utils/format-time-ago';

type DeleteBranchItem = {
  name: string;
  committedAt: string | null;
};

type DeleteBranchDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  branches: DeleteBranchItem[];
  searchQuery: string;
  onSearchChange: (query: string) => void;
  onBranchSelect: (branch: string) => void;
};

export function DeleteBranchDialog({
  open,
  onOpenChange,
  branches,
  searchQuery,
  onSearchChange,
  onBranchSelect,
}: DeleteBranchDialogProps) {
  const [scrollNode, setScrollNode] = useState<HTMLDivElement | null>(null);
  const filteredBranches = searchQuery.trim()
    ? branches.filter((branch) => branch.name.toLowerCase().includes(searchQuery.toLowerCase()))
    : branches;
  const branchVirtualizer = useVirtualizer({
    count: filteredBranches.length,
    getScrollElement: () => scrollNode,
    estimateSize: () => 32,
    overscan: 5,
    enabled: open,
  });
  const virtualItems = branchVirtualizer.getVirtualItems();
  const highlight = useMemo(() => createHighlightMatcher(searchQuery), [searchQuery]);

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        onOpenChange(nextOpen);
        if (!nextOpen) {
          onSearchChange('');
        }
      }}
    >
      <CanvasDialogContent className="sm:max-w-[440px]">
        <CanvasDialogHeader>
          <DialogTitle>Delete branch</DialogTitle>
        </CanvasDialogHeader>
        <CanvasDialogBody className="space-y-3">
          <Input
            value={searchQuery}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder={STRINGS.BRANCH_SEARCH_PLACEHOLDER}
            aria-label="Search branches to delete"
            autoFocus
          />
          {filteredBranches.length === 0 ? (
            <div className="py-6 text-center text-sm text-muted-foreground">
              {STRINGS.BRANCH_NO_BRANCHES}
            </div>
          ) : (
            <div
              ref={setScrollNode}
              className="max-h-[280px] overflow-y-auto"
              role="listbox"
              aria-label="Deletable branches"
            >
              <div
                style={{
                  height: `${branchVirtualizer.getTotalSize()}px`,
                  width: '100%',
                  position: 'relative',
                }}
              >
                {virtualItems.map((virtualItem) => {
                  const branch = filteredBranches[virtualItem.index];
                  if (!branch) {
                    return null;
                  }
                  return (
                    <Button
                      key={branch.name}
                      variant="ghost"
                      size="auto"
                      role="option"
                      aria-selected={false}
                      className="w-full justify-start text-left font-normal absolute left-0 top-0 gap-2 rounded-md px-2 py-1.5 text-sm"
                      style={{
                        height: `${virtualItem.size}px`,
                        transform: `translateY(${virtualItem.start}px)`,
                      }}
                      onClick={() => onBranchSelect(branch.name)}
                    >
                      <GitBranch className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <span className="truncate flex-1">{highlight(branch.name)}</span>
                      {branch.committedAt && (
                        <span className="text-xs text-muted-foreground/70 shrink-0">
                          {formatTimeAgo(branch.committedAt)}
                        </span>
                      )}
                    </Button>
                  );
                })}
              </div>
            </div>
          )}
        </CanvasDialogBody>
      </CanvasDialogContent>
    </Dialog>
  );
}
