/* eslint-disable max-lines, max-lines-per-function */

import { Button } from '@benord-labs/frink-primitives';
import { useSetAtom } from 'jotai';
import { ShieldAlert, Minimize2, Maximize2, Loader2 } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { buildAgentEditorOpenInput } from '@/lib/worktree/derive-project-path-from-editor-path';
import { extractWorktreeRelativePath } from '@/lib/worktree/worktree-path';
import { detectLanguage } from '../../../../shared/detect-language';
import { TextShimmer } from '../../../components/ui/text-shimmer';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../components/ui/tooltip';
import { useCodeTheme } from '../../../lib/hooks/use-code-theme';
import { highlightCode } from '../../../lib/themes/shiki-theme-loader';
import { trpc } from '../../../lib/trpc';
import { cn } from '../../../lib/utils';
import { openFileAtom } from '../../code-editor';
import { openDiffAtFileAtom } from '../atoms';
import { useCurrentChatId, useCurrentChatWorktree } from '../context/current-chat-worktree-context';
import { getFileIconByExtension } from '../mentions/agents-file-mention';
import type { MessagePart } from '../stores/message-store';
import { buildDiffLineKeys, type DiffLine } from './agent-edit-line-keys';
import { getEditToolDenialState } from './agent-edit-permission';
import { AgentToolInterrupted } from './agent-tool-interrupted';
import { getToolStatus } from './agent-tool-registry';
import { areToolPropsEqual } from './agent-tool-utils';
import { reRootAtProjectDir } from './tool-registry-shared';

type AgentEditToolProps = {
  part: MessagePart;
  messageId?: string;
  partIndex?: number;
  chatStatus?: string;
};

const SHIKI_LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'jsx',
  py: 'python',
  go: 'go',
  rs: 'rust',
  html: 'html',
  css: 'css',
  json: 'json',
  md: 'markdown',
  sh: 'bash',
  bash: 'bash',
};

// Type-safe accessors for MessagePart input/output properties
function getStringProperty(obj: Record<string, unknown> | undefined, key: string): string {
  if (!obj) return '';
  const value = obj[key];
  return typeof value === 'string' ? value : '';
}

function getArrayProperty<T>(
  obj: Record<string, unknown> | undefined,
  key: string,
): T[] | undefined {
  if (!obj) return undefined;
  const value = obj[key];
  return Array.isArray(value) ? (value as T[]) : undefined;
}

// Removed local highlighter - using centralized loader from lib/themes/shiki-theme-loader

// Calculate diff stats from structuredPatch
function calculateDiffStatsFromPatch(
  patches: PatchHunk[],
): { addedLines: number; removedLines: number } | null {
  if (!patches || patches.length === 0) return null;

  let addedLines: number = 0;
  let removedLines: number = 0;

  for (const patch of patches) {
    // Skip patches without lines array
    if (!patch.lines) continue;
    for (const line of patch.lines) {
      if (line.startsWith('+')) addedLines++;
      else if (line.startsWith('-')) removedLines++;
    }
  }

  return { addedLines, removedLines };
}

// Hunk type matching the `diff` npm package's StructuredPatchHunk at runtime.
// `oldStart`/`newStart` are present in Claude Code output but were previously untyped.
type PatchHunk = {
  lines: string[];
  oldStart?: number;
  newStart?: number;
};

// Get all diff lines from structuredPatch with line numbers
function getDiffLines(patches: PatchHunk[]): DiffLine[] {
  const result: DiffLine[] = [];

  if (!patches) return result;

  for (const patch of patches) {
    let oldLine = patch.oldStart ?? 1;
    let newLine = patch.newStart ?? 1;

    for (const line of patch.lines) {
      if (line.startsWith('+')) {
        result.push({ type: 'added', content: line.slice(1), newLineNo: newLine });
        newLine++;
      } else if (line.startsWith('-')) {
        result.push({ type: 'removed', content: line.slice(1), oldLineNo: oldLine });
        oldLine++;
      } else if (line.startsWith(' ')) {
        result.push({
          type: 'context',
          content: line.slice(1),
          oldLineNo: oldLine,
          newLineNo: newLine,
        });
        oldLine++;
        newLine++;
      }
    }
  }

  return result;
}

// Hook to batch-highlight all diff lines at once
// During streaming, skip highlighting entirely to maximize FPS
function useBatchHighlight(
  lines: DiffLine[],
  language: string,
  themeId: string,
  isStreaming: boolean = false,
): Map<number, string> {
  const [highlightedMap, setHighlightedMap] = useState<Map<number, string>>(() => new Map());

  // Create stable key from lines content to detect changes
  // Only compute when NOT streaming to avoid expensive join during animation
  const _linesKey = useMemo(
    () => (isStreaming ? '' : lines.map((l) => l.content).join('\n')),
    [lines, isStreaming],
  );

  useEffect(() => {
    // Skip highlighting during streaming - show plain text for better FPS
    if (isStreaming) {
      return;
    }

    if (lines.length === 0) {
      setHighlightedMap(new Map());
      return;
    }

    let cancelled: boolean = false;

    const highlightAll = async () => {
      try {
        const results = new Map<number, string>();

        // Highlight all lines in one batch using centralized loader
        for (let i = 0; i < lines.length; i++) {
          // Check if cancelled between iterations to allow early exit
          if (cancelled) return;
          const content = lines[i].content || ' ';
          const highlighted = await highlightCode(content, language, themeId);
          results.set(i, highlighted);
        }

        if (!cancelled) {
          setHighlightedMap(results);
        }
      } catch (_error) {
        // On error, leave map empty (fallback to plain text)
        if (!cancelled) {
          setHighlightedMap(new Map());
        }
      }
    };

    // Debounce highlighting after streaming completes
    const timer = setTimeout(highlightAll, 50);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [language, themeId, isStreaming, lines]);

  return highlightedMap;
}

// Memoized component for rendering a single diff line with line number gutter
// Uses custom comparator to compare line content instead of object reference
const DiffLineRow = memo(
  function DiffLineRow({
    line,
    highlightedHtml,
  }: {
    line: DiffLine;
    highlightedHtml: string | undefined;
  }) {
    const hasLineNumbers = line.oldLineNo !== undefined || line.newLineNo !== undefined;

    return (
      <div
        className={cn(
          'flex',
          line.type === 'removed' && 'bg-red-500/10 dark:bg-red-500/15',
          line.type === 'added' && 'bg-green-500/10 dark:bg-green-500/15',
        )}
      >
        {/* Line number gutter — select-none prevents copying, aria-hidden for screen readers; min-w-[4ch] + tabular-nums so 100+ line numbers don't concatenate */}
        {hasLineNumbers && (
          <div
            className="shrink-0 select-none tabular-nums border-r border-border/50 text-[10px] leading-[18px] text-muted-foreground/50"
            aria-hidden="true"
          >
            <span className="inline-block min-w-[4ch] text-right pr-1 border-r border-border/30">
              {line.oldLineNo ?? ''}
            </span>
            <span className="inline-block min-w-[4ch] text-right pr-1">{line.newLineNo ?? ''}</span>
          </div>
        )}

        {/* Code content with border-l indicator */}
        <div
          className={cn(
            'flex-1 min-w-0 px-2 py-0.5 border-l-2',
            line.type === 'removed' && 'border-red-500/50',
            line.type === 'added' && 'border-green-500/50',
            line.type === 'context' && 'border-transparent',
          )}
        >
          {highlightedHtml ? (
            <span
              className="whitespace-pre-wrap break-all [&_.shiki]:bg-transparent [&_pre]:bg-transparent [&_code]:bg-transparent"
              // biome-ignore lint/security/noDangerouslySetInnerHtml: highlightedHtml is safely generated by Shiki syntax highlighter
              dangerouslySetInnerHTML={{ __html: highlightedHtml }}
            />
          ) : (
            <span
              className={cn(
                'whitespace-pre-wrap break-all',
                line.type === 'removed' && 'text-red-700 dark:text-red-300',
                line.type === 'added' && 'text-green-700 dark:text-green-300',
                line.type === 'context' && 'text-muted-foreground',
              )}
            >
              {line.content || ' '}
            </span>
          )}
        </div>
      </div>
    );
  },
  // Custom comparator: compare line content, type, line numbers, and highlighted HTML
  (prevProps, nextProps) =>
    prevProps.line.type === nextProps.line.type &&
    prevProps.line.content === nextProps.line.content &&
    prevProps.line.oldLineNo === nextProps.line.oldLineNo &&
    prevProps.line.newLineNo === nextProps.line.newLineNo &&
    prevProps.highlightedHtml === nextProps.highlightedHtml,
);

export const AgentEditTool = memo(function AgentEditTool({
  part,
  messageId,
  partIndex,
  chatStatus,
}: AgentEditToolProps) {
  const [isOutputExpanded, setIsOutputExpanded] = useState(false);
  const { isPending, isInterrupted } = getToolStatus(part, chatStatus);
  const { permissionDenied, denialReason } = useMemo(() => getEditToolDenialState(part), [part]);
  const codeTheme = useCodeTheme();
  const { data: worktreeSettings } = trpc.claudeSettings.getWorktreeBasePath.useQuery(undefined, {
    staleTime: 60_000,
  });

  const openFile = useSetAtom(openFileAtom);
  const worktreePath = useCurrentChatWorktree();
  const chatId = useCurrentChatId();
  const openDiffAtFile = useSetAtom(openDiffAtFileAtom);

  // Determine tool type
  const isWriteMode = part.type === 'tool-Write';
  const toolPrefix = isWriteMode ? 'tool-Write' : 'tool-Edit';

  // Only consider streaming if chat is actively streaming (prevents spinner hang on stop)
  // Include "submitted" status - this is when request was sent but streaming hasn't started yet
  const isActivelyStreaming = chatStatus === 'streaming' || chatStatus === 'submitted';
  const isInputStreaming = part.state === 'input-streaming' && isActivelyStreaming;

  const filePath = getStringProperty(part.input, 'file_path');
  const _oldString = getStringProperty(part.input, 'old_string');
  const newString = getStringProperty(part.input, 'new_string');

  // For Write mode, content is in input.content
  const writeContent = getStringProperty(part.input, 'content');

  // Get structuredPatch from output (only available when complete)
  const structuredPatch = getArrayProperty<PatchHunk>(part.output, 'structuredPatch');

  // Extract filename from path
  const filename = filePath ? filePath.split('/').pop() || 'file' : '';

  // Get clean display path (remove sandbox prefix to show project-relative path)
  const displayPath = useMemo(() => {
    if (!filePath) return '';
    // Remove common sandbox prefixes
    const prefixes = ['/project/sandbox/repo/', '/project/sandbox/', '/project/'];
    const normalizedPrefixes = [...prefixes, '/workspace/'];
    for (const prefix of normalizedPrefixes) {
      if (filePath.startsWith(prefix)) {
        return filePath.slice(prefix.length);
      }
    }
    // Handle worktree paths: /Users/.../.frink/worktrees/{projectIdOrSlug}/{worktreeFolder}/relativePath
    const worktreeRelative = extractWorktreeRelativePath(filePath, worktreeSettings?.path);
    if (worktreeRelative) {
      return worktreeRelative;
    }
    // If path starts with /, try to find a reasonable root
    return reRootAtProjectDir(filePath) ?? filePath;
  }, [filePath, worktreeSettings?.path]);

  // Path for opening in inbuilt editor: use filePath when already absolute, else worktreePath + displayPath
  const pathForEditor = useMemo(() => {
    if (!filePath || !displayPath) return null;
    const isSandbox = filePath.startsWith('/project/') || filePath.startsWith('/workspace/');
    if (filePath.startsWith('/') && !isSandbox) return filePath;
    if (worktreePath) {
      return displayPath.startsWith('/') ? displayPath : `${worktreePath}/${displayPath}`;
    }
    return null;
  }, [filePath, displayPath, worktreePath]);

  // Handler to open diff sidebar and focus on this file
  const handleOpenInDiff = useCallback(() => {
    if (displayPath && chatId) openDiffAtFile({ chatId, path: displayPath });
  }, [displayPath, chatId, openDiffAtFile]);

  // Memoized click handlers to prevent inline function re-creation
  const handleHeaderClick = useCallback(() => {
    if (!isPending && !isInputStreaming) {
      setIsOutputExpanded((prev) => !prev);
    }
  }, [isPending, isInputStreaming]);

  const getEditorOpenInput = useCallback(() => {
    return buildAgentEditorOpenInput({
      pathForEditor,
      displayPath,
      worktreePath,
      filename,
      chatId,
    });
  }, [pathForEditor, displayPath, worktreePath, filename, chatId]);

  const handleFilenameClick = useCallback(
    (e: React.MouseEvent) => {
      if (!displayPath) return;
      e.stopPropagation();
      const openInput = getEditorOpenInput();
      if (openInput) {
        openFile(openInput);
      } else {
        handleOpenInDiff();
      }
    },
    [displayPath, getEditorOpenInput, openFile, handleOpenInDiff],
  );

  const handleExpandButtonClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setIsOutputExpanded((prev) => !prev);
  }, []);

  const handleContentClick = useCallback(() => {
    if (!isOutputExpanded && !isPending && !isInputStreaming) {
      setIsOutputExpanded(true);
    }
  }, [isOutputExpanded, isPending, isInputStreaming]);

  const _handleHeaderKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handleHeaderClick();
      }
    },
    [handleHeaderClick],
  );

  const handleFilenameKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        const openInput = getEditorOpenInput();
        if (openInput) {
          openFile(openInput);
        } else if (displayPath) {
          handleOpenInDiff();
        }
      }
    },
    [getEditorOpenInput, openFile, displayPath, handleOpenInDiff],
  );

  const _handleContentKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handleContentClick();
      }
    },
    [handleContentClick],
  );

  // Get file icon component and language
  // Pass true to not show default icon for unknown file types
  // biome-ignore lint/style/useNamingConvention: JSX component identifier must be PascalCase
  const FileIcon = filename ? getFileIconByExtension(filename, true) : null;
  const language = filename ? detectLanguage(filename, SHIKI_LANGUAGE_BY_EXTENSION) : 'plaintext';

  // Diff stats prefer the structured patch; Write mode counts every line as added, and an
  // Edit still streaming falls back to new_string as a preview.
  const diffStats = useMemo(() => {
    if (permissionDenied) return null;
    if (isWriteMode) {
      const outputContent = getStringProperty(part.output, 'content');
      const content = writeContent || outputContent;
      const addedLines = content ? content.split('\n').length : 0;
      return { addedLines, removedLines: 0 };
    }
    if (structuredPatch) {
      return calculateDiffStatsFromPatch(structuredPatch);
    }
    // Fallback: count new_string lines as preview (for input-available state)
    if (newString) {
      return { addedLines: newString.split('\n').length, removedLines: 0 };
    }
    return null;
  }, [permissionDenied, structuredPatch, isWriteMode, writeContent, part.output, newString]);

  // Get diff lines for display (memoized)
  // For Write mode, treat all lines as added
  // For Edit mode without structuredPatch, show new_string as preview
  const diffLines = useMemo(() => {
    if (permissionDenied) return [];
    if (isWriteMode) {
      const outputContent = getStringProperty(part.output, 'content');
      const content = writeContent || outputContent;
      if (!content) return [];
      return content.split('\n').map((line: string, idx: number) => ({
        type: 'added' as const,
        content: line,
        newLineNo: idx + 1,
      }));
    }
    // If we have structuredPatch, use it for proper diff display
    if (structuredPatch) {
      // Filter out patches without lines array to match getDiffLines signature
      const patchesWithLines = structuredPatch.filter(
        (patch): patch is PatchHunk & { lines: string[] } =>
          Array.isArray(patch.lines) && patch.lines.length > 0,
      );
      if (patchesWithLines.length > 0) {
        return getDiffLines(patchesWithLines);
      }
    }
    // Fallback: show new_string as preview (for input-available state before execution)
    // No line numbers — we don't know where in the file this snippet starts
    if (newString) {
      return newString.split('\n').map((line: string) => ({
        type: 'added' as const,
        content: line,
      }));
    }
    return [];
  }, [permissionDenied, structuredPatch, isWriteMode, writeContent, part.output, newString]);

  // For streaming state, get content being streamed
  const streamingContent = useMemo(() => {
    if (!isInputStreaming) return null;
    if (isWriteMode) {
      return writeContent;
    }
    return newString;
  }, [isInputStreaming, isWriteMode, writeContent, newString]);

  // Throttle streaming content updates for better FPS
  // Only update the displayed content every 100ms during streaming
  const [throttledStreamingContent, setThrottledStreamingContent] = useState<string | null>(null);
  const lastStreamingUpdateRef = useRef<number>(0);

  useEffect(() => {
    if (!isInputStreaming) {
      setThrottledStreamingContent(null);
      return;
    }

    const now = Date.now();
    const timeSinceLastUpdate = now - lastStreamingUpdateRef.current;

    // Throttle to ~10 updates per second (100ms intervals)
    if (timeSinceLastUpdate >= 100) {
      lastStreamingUpdateRef.current = now;
      setThrottledStreamingContent(streamingContent ?? null);
    } else {
      // Schedule update for remaining time
      const timer = setTimeout(() => {
        lastStreamingUpdateRef.current = Date.now();
        setThrottledStreamingContent(streamingContent ?? null);
      }, 100 - timeSinceLastUpdate);
      return () => clearTimeout(timer);
    }
  }, [streamingContent, isInputStreaming]);

  // Convert streaming content to diff lines
  // Up to 3 lines: show from top; more than 3 lines: show last N lines for autoscroll effect
  const { streamingLines, shouldAlignBottom } = useMemo(() => {
    const content = throttledStreamingContent;
    if (!content) return { streamingLines: [], shouldAlignBottom: false };
    const lines = content.split('\n');
    const totalLines = lines.length;
    // If 3 or fewer lines, show all from top
    // If more than 3, show last 15 lines for autoscroll effect
    const displayedLines = totalLines <= 3 ? lines : lines.slice(-15);
    return {
      streamingLines: displayedLines.map((line: string) => ({
        type: 'added' as const,
        content: line,
      })),
      shouldAlignBottom: totalLines > 3,
    };
  }, [throttledStreamingContent]);

  // Use streaming lines when streaming, otherwise use diff lines
  // IMPORTANT: Must be memoized to prevent infinite render loop!
  // Without useMemo, activeLines gets a new reference on every render, which triggers
  // firstChangeIndex -> displayLines -> useBatchHighlight -> setHighlightedMap -> re-render
  const activeLines = useMemo(
    () => (isInputStreaming && streamingLines.length > 0 ? streamingLines : diffLines),
    [isInputStreaming, streamingLines, diffLines],
  );

  // Find index of first change line (added or removed) to focus on when collapsed
  // Prioritize added lines, but fall back to removed lines if no additions exist
  const firstChangeIndex = useMemo(() => {
    const firstAdded = activeLines.findIndex((line: DiffLine) => line.type === 'added');
    if (firstAdded !== -1) return firstAdded;
    // No additions - look for first removal instead
    return activeLines.findIndex((line: DiffLine) => line.type === 'removed');
  }, [activeLines]);

  // Reorder lines for collapsed view: show from first change line (memoized)
  // Skip reorder for small diffs — all lines are already visible, reordering just causes a jarring shift
  const displayLines = useMemo(
    () =>
      !isOutputExpanded && firstChangeIndex > 0 && activeLines.length > 6
        ? [...activeLines.slice(firstChangeIndex), ...activeLines.slice(0, firstChangeIndex)]
        : activeLines,
    [activeLines, isOutputExpanded, firstChangeIndex],
  );
  const displayLineKeys = useMemo(() => buildDiffLineKeys(displayLines), [displayLines]);

  // Batch highlight all lines at once (instead of N×useEffect)
  // Pass isInputStreaming to use longer debounce during streaming for better FPS
  const highlightedMap = useBatchHighlight(displayLines, language, codeTheme, isInputStreaming);

  // Check if we have VISIBLE content to show
  // For streaming, only show content area if we have some content to display
  // Use throttled content check during streaming for consistent render behavior
  const hasVisibleContent =
    !permissionDenied &&
    (displayLines.length > 0 ||
      (isInputStreaming && (throttledStreamingContent || newString || writeContent)));

  // Header title based on mode and state (used only in minimal view)
  const headerAction = useMemo(() => {
    if (isWriteMode) {
      return isInputStreaming ? 'Creating' : 'Created';
    }
    return isInputStreaming ? 'Editing' : 'Edited';
  }, [isWriteMode, isInputStreaming]);

  // Show minimal view (no background/border) until we have the full file path
  // This prevents showing a large empty component while path is being streamed
  if (!filePath) {
    if (permissionDenied) {
      return (
        <div className="mx-2 rounded-lg border border-amber-500/40 bg-amber-500/5 px-2.5 py-1.5">
          <div className="flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-600">
            <ShieldAlert className="h-3.5 w-3.5" />
            <span className="font-medium">{isWriteMode ? 'Create blocked' : 'Edit blocked'}</span>
          </div>
          {denialReason ? (
            <div className="mt-1 text-xs text-amber-700 dark:text-amber-600 whitespace-pre-wrap break-all">
              {denialReason}
            </div>
          ) : null}
        </div>
      );
    }
    // If interrupted without file path, show interrupted state
    if (isInterrupted) {
      return <AgentToolInterrupted toolName={isWriteMode ? 'Write' : 'Edit'} />;
    }
    return (
      <div className="flex items-center gap-1.5 px-2 py-0.5">
        <span className="text-xs text-muted-foreground">
          {isPending ? (
            <TextShimmer as="span" duration={1.2}>
              {headerAction}
            </TextShimmer>
          ) : (
            headerAction
          )}
        </span>
      </div>
    );
  }

  return (
    <div
      data-message-id={messageId}
      data-part-index={partIndex}
      data-part-type={toolPrefix}
      data-tool-file-path={displayPath}
      className="rounded-lg border border-border glass-card overflow-hidden mx-2"
    >
      {/* Header - clickable to expand, fixed height to prevent layout shift */}
      <div
        {...(hasVisibleContent
          ? {
              onClick: handleHeaderClick,
              onKeyDown: (e: React.KeyboardEvent) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  handleHeaderClick();
                }
              },
              role: 'button' as const,
              tabIndex: 0,
              'aria-label': 'Toggle file content',
            }
          : {
              role: 'presentation' as const,
            })}
        className={cn(
          'agent-edit-tool-header flex items-center justify-between pl-2.5 pr-0.5 h-7',
          hasVisibleContent &&
            !isPending &&
            !isInputStreaming &&
            'cursor-pointer hover:bg-muted/50 transition-colors duration-150',
        )}
      >
        <div
          {...(displayPath
            ? {
                onClick: handleFilenameClick,
                onKeyDown: handleFilenameKeyDown,
                role: 'button' as const,
                tabIndex: 0,
                'aria-label': pathForEditor ? 'Open file in editor' : 'Open file in diff view',
              }
            : {
                role: 'presentation' as const,
              })}
          className={cn(
            'flex items-center gap-1.5 text-xs truncate flex-1 min-w-0',
            displayPath && 'cursor-pointer hover:text-foreground',
          )}
        >
          {FileIcon && <FileIcon className="w-2.5 h-2.5 shrink-0 text-muted-foreground" />}
          {/* Filename with shimmer during progress */}
          <Tooltip>
            <TooltipTrigger asChild>
              {isPending || isInputStreaming ? (
                <TextShimmer as="span" duration={1.2} className="truncate">
                  {filename}
                </TextShimmer>
              ) : (
                <span className="truncate text-foreground">{filename}</span>
              )}
            </TooltipTrigger>
            <TooltipContent
              side="top"
              className="px-2 py-1.5 max-w-none flex flex-col items-center gap-0.5"
            >
              <span className="font-mono text-[10px] text-muted-foreground whitespace-nowrap leading-none">
                {displayPath}
              </span>
              <span className="text-[10px] text-muted-foreground leading-none">
                {pathForEditor ? 'Click to open in editor' : 'Click to open in diff view'}
              </span>
            </TooltipContent>
          </Tooltip>
        </div>

        {/* Status and expand button */}
        <div className="flex items-center gap-2 shrink-0 ml-2">
          {/* Diff stats or spinner */}
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            {isPending || isInputStreaming ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : permissionDenied ? (
              <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-600">
                <ShieldAlert className="h-3.5 w-3.5" />
                Blocked
              </span>
            ) : diffStats ? (
              <>
                <span className="text-green-600 dark:text-green-400">+{diffStats.addedLines}</span>
                {diffStats.removedLines > 0 && (
                  <span className="text-red-600 dark:text-red-400">-{diffStats.removedLines}</span>
                )}
              </>
            ) : null}
          </div>

          {/* Expand/Collapse button - show when has visible content and not streaming */}
          {hasVisibleContent && !isPending && !isInputStreaming && (
            <Button
              variant="ghost"
              size="icon"
              onClick={handleExpandButtonClick}
              aria-label={isOutputExpanded ? 'Collapse file content' : 'Expand file content'}
              className="p-1 rounded-md transition-[background-color,transform] duration-150 ease-out active:scale-95"
            >
              <div className="relative w-4 h-4">
                <Maximize2
                  className={cn(
                    'absolute inset-0 w-4 h-4 text-muted-foreground transition-[opacity,transform] duration-200 ease-out',
                    isOutputExpanded ? 'opacity-0 scale-75' : 'opacity-100 scale-100',
                  )}
                />
                <Minimize2
                  className={cn(
                    'absolute inset-0 w-4 h-4 text-muted-foreground transition-[opacity,transform] duration-200 ease-out',
                    isOutputExpanded ? 'opacity-100 scale-100' : 'opacity-0 scale-75',
                  )}
                />
              </div>
            </Button>
          )}
        </div>
      </div>

      {/* Content - git-style diff with syntax highlighting */}
      {permissionDenied && denialReason ? (
        <div className="border-t border-amber-500/30 bg-amber-500/5 px-2.5 py-1.5 text-xs text-amber-700 dark:text-amber-600 whitespace-pre-wrap break-all">
          {denialReason}
        </div>
      ) : null}
      {hasVisibleContent && (
        <div
          {...(!isOutputExpanded && !isPending && !isInputStreaming
            ? {
                onClick: handleContentClick,
                onKeyDown: (e: React.KeyboardEvent) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    handleContentClick();
                  }
                },
                role: 'button' as const,
                tabIndex: 0,
                'aria-label': 'Expand file content',
              }
            : {
                role: 'presentation' as const,
              })}
          className={cn(
            'border-t border-border transition-colors duration-150 font-mono text-xs',
            isOutputExpanded
              ? 'max-h-[min(400px,60vh)] overflow-y-auto'
              : 'h-[72px] overflow-hidden', // Fixed height when collapsed
            !isOutputExpanded &&
              !isPending &&
              !isInputStreaming &&
              'cursor-pointer hover:bg-muted/50',
            // When streaming with > 3 lines, use flex to push content to bottom
            isInputStreaming && shouldAlignBottom && 'flex flex-col justify-end',
          )}
        >
          {/* Display lines - either streaming content or completed diff */}
          {displayLines.length > 0 ? (
            <div className={cn(isInputStreaming && shouldAlignBottom && 'shrink-0')}>
              {displayLines.map((line: DiffLine, idx: number) => (
                <DiffLineRow
                  key={displayLineKeys[idx] ?? `diff-line-${idx}`}
                  line={line}
                  highlightedHtml={highlightedMap.get(idx)}
                />
              ))}
            </div>
          ) : // Fallback: show raw streaming content when no lines parsed yet
          throttledStreamingContent || newString ? (
            <div
              className={cn(
                'px-2.5 py-1.5 text-green-700 dark:text-green-300 whitespace-pre-wrap break-all',
                isInputStreaming && shouldAlignBottom && 'shrink-0',
              )}
            >
              {isInputStreaming && !isOutputExpanded
                ? // Show last ~500 chars during streaming (use throttled for FPS)
                  (throttledStreamingContent || newString || '').slice(-500)
                : throttledStreamingContent || newString || ''}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}, areToolPropsEqual);
