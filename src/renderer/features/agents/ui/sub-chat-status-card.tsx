/* eslint-disable max-lines, max-lines-per-function */

import { Button } from '@benord-labs/frink-primitives';
import { useAtom, useSetAtom } from 'jotai';
import { ChevronDown } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { memo, useEffect, useMemo, useState } from 'react';
import { Kbd } from '../../../components/ui/kbd';
import { keysToDisplayPlatform } from '../../../lib/hotkeys';
import { cn } from '../../../lib/utils';
import { isMacOS } from '../../../lib/utils/platform';

const CTRL_C_KEYS: string[] = ['ctrl', 'C'];

import {
  diffSidebarOpenAtomFamily,
  filteredDiffFilesAtomFamily,
  filteredSubChatIdAtomFamily,
  focusedDiffFileAtomFamily,
  type SubChatFileChange,
} from '../atoms';
import { getFileIconByExtension } from '../mentions/agents-file-mention';

// Animated dots component that cycles through ., .., ...
function AnimatedDots() {
  const [dotCount, setDotCount] = useState(1);

  useEffect(() => {
    const interval = setInterval(() => {
      setDotCount((prev) => (prev % 3) + 1);
    }, 400);
    return () => clearInterval(interval);
  }, []);

  return <span className="inline-block w-[1em] text-left">{'.'.repeat(dotCount)}</span>;
}

type SubChatStatusCardProps = {
  chatId: string; // Parent chat ID for per-chat diff sidebar state
  subChatId: string; // Sub-chat ID for filtering (used when Review is clicked)
  isStreaming: boolean;
  isCompacting?: boolean;
  /** From useUncommittedFiles: the card renders nothing when this is empty. */
  uncommittedFiles: SubChatFileChange[];
  onStop?: () => void;
  /** Whether there's a queue card above this one - affects border radius */
  hasQueueCardAbove?: boolean;
};

export const SubChatStatusCard = memo(function SubChatStatusCard({
  chatId,
  subChatId,
  isStreaming,
  isCompacting,
  uncommittedFiles,
  onStop,
  hasQueueCardAbove = false,
}: SubChatStatusCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  // Use per-chat atom family instead of legacy global atom
  const diffSidebarAtom = useMemo(() => diffSidebarOpenAtomFamily(chatId), [chatId]);
  const [, setDiffSidebarOpen] = useAtom(diffSidebarAtom);
  const setFilteredDiffFiles = useSetAtom(filteredDiffFilesAtomFamily(chatId));
  const setFilteredSubChatId = useSetAtom(filteredSubChatIdAtomFamily(chatId));
  const setFocusedDiffFile = useSetAtom(focusedDiffFileAtomFamily(chatId));

  // Calculate totals from uncommitted files only
  const totals = useMemo(() => {
    let additions = 0;
    let deletions = 0;
    for (const file of uncommittedFiles) {
      additions += file.additions;
      deletions += file.deletions;
    }
    return { additions, deletions, fileCount: uncommittedFiles.length };
  }, [uncommittedFiles]);

  // Check if there's expandable content (only files now)
  const hasExpandableContent = uncommittedFiles.length > 0;

  // Don't show if no changed files - only show when there are files to review
  if (uncommittedFiles.length === 0) {
    return null;
  }

  const handleReview = () => {
    // Set filter to only show files from this sub-chat
    // Use displayPath (relative path) to match git diff paths
    const filePaths = uncommittedFiles.map((f) => f.displayPath);
    setFilteredDiffFiles(filePaths.length > 0 ? filePaths : null);
    // Also record the sub-chat - use the prop, not activeSubChatId from store
    setFilteredSubChatId(subChatId);
    setDiffSidebarOpen(true);
  };

  return (
    <div
      data-stacked-card
      className={cn(
        'border border-border glass-float overflow-hidden flex flex-col border-b-0',
        // If queue card above - no top radius
        hasQueueCardAbove ? 'rounded-none' : 'rounded-t-2xl',
      )}
    >
      {/* Header - at top */}
      <Button
        variant="ghost"
        size="sm"
        tabIndex={0}
        onClick={() => setIsExpanded(!isExpanded)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setIsExpanded(!isExpanded);
          }
        }}
        aria-expanded={isExpanded}
        aria-label={`${isExpanded ? 'Collapse' : 'Expand'} status details`}
        className="flex justify-between pr-1 pl-3 h-8 duration-150 focus:outline-hidden rounded-sm w-full text-left"
      >
        <div className="flex items-center gap-2 text-xs flex-1 min-w-0">
          {/* Expand/Collapse chevron - always show */}
          <ChevronDown
            className={cn(
              'w-4 h-4 text-muted-foreground transition-transform duration-200',
              !isExpanded && '-rotate-90',
            )}
          />

          {/* Streaming indicator */}
          {isStreaming && (
            <span className="text-xs text-muted-foreground">
              {isCompacting ? 'Compacting' : 'Generating'}
              <AnimatedDots />
            </span>
          )}

          {/* File count and stats - only show when not streaming */}
          {!isStreaming && (
            <span className="text-xs text-muted-foreground">
              {totals.fileCount} {totals.fileCount === 1 ? 'file' : 'files'}
              {(totals.additions > 0 || totals.deletions > 0) && (
                <>
                  {' '}
                  <span className="text-green-600 dark:text-green-400">
                    +{totals.additions}
                  </span>{' '}
                  <span className="text-red-600 dark:text-red-400">-{totals.deletions}</span>
                </>
              )}
            </span>
          )}
        </div>

        {/* Right side: buttons */}
        <div className="flex items-center gap-2 shrink-0">
          {/* Stop button */}
          {isStreaming && onStop && (
            <Button
              variant="ghost"
              size="sm"
              onClick={(e) => {
                e.stopPropagation();
                onStop();
              }}
              className="h-6 px-2 text-xs font-normal rounded-md transition-transform duration-150 active:scale-[0.97]"
            >
              Stop
              <Kbd className="ml-1">{keysToDisplayPlatform(CTRL_C_KEYS, isMacOS())}</Kbd>
            </Button>
          )}

          {/* Review button */}
          <Button
            variant="secondary"
            size="sm"
            onClick={(e) => {
              e.stopPropagation();
              handleReview();
            }}
            className="h-6 px-3 text-xs rounded-md transition-transform duration-150 active:scale-[0.97]"
          >
            Review
          </Button>
        </div>
      </Button>

      {/* Expanded content - files */}
      <AnimatePresence initial={false}>
        {isExpanded && hasExpandableContent && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.23, 1, 0.32, 1] }}
            className="overflow-hidden"
          >
            <div className="border-t border-border max-h-[200px] overflow-y-auto">
              {uncommittedFiles.map((file) => {
                // biome-ignore lint/style/useNamingConvention: JSX component identifier must be PascalCase
                const FileIcon = getFileIconByExtension(file.displayPath);

                const handleFileClick = () => {
                  // Set filter to only show files from this sub-chat
                  // Use displayPath (relative path) to match git diff paths
                  const filePaths = uncommittedFiles.map((f) => f.displayPath);
                  setFilteredDiffFiles(filePaths.length > 0 ? filePaths : null);
                  // Set focus on this specific file
                  setFocusedDiffFile(file.displayPath);
                  // Open diff sidebar
                  setDiffSidebarOpen(true);
                };

                const handleKeyDown = (e: React.KeyboardEvent) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    handleFileClick();
                  }
                };

                return (
                  <Button
                    variant="ghost"
                    size="auto"
                    key={file.filePath}
                    tabIndex={0}
                    onClick={handleFileClick}
                    onKeyDown={handleKeyDown}
                    aria-label={`View diff for ${file.displayPath}`}
                    className="w-full justify-start text-left font-normal flex gap-2 px-3 py-1.5 text-xs focus:outline-hidden rounded-sm"
                  >
                    {FileIcon && <FileIcon className="w-4 h-4 shrink-0 text-muted-foreground" />}
                    <span className="truncate flex-1 text-foreground">{file.displayPath}</span>
                    <span className="shrink-0 text-green-600 dark:text-green-400">
                      +{file.additions}
                    </span>
                    <span className="shrink-0 text-red-600 dark:text-red-400">
                      -{file.deletions}
                    </span>
                  </Button>
                );
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
});
