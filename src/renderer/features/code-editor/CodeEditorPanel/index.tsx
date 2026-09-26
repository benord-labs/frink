/* eslint-disable max-lines, max-lines-per-function */

import { Button } from '@benord-labs/frink-primitives';
import Editor from '@monaco-editor/react';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import {
  BookOpen,
  ChevronRight,
  Filter,
  GitCompare,
  Maximize2,
  Minimize2,
  PanelLeft,
  PanelRight,
  PanelTop,
  Save,
  X,
  Loader2,
} from 'lucide-react';
import type * as Monaco from 'monaco-editor';
import { AnimatePresence, motion } from 'motion/react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { MemoizedMarkdown } from '@/components/chat-markdown-renderer';
import { Kbd } from '@/components/ui/kbd';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { selectedProjectAtom } from '@/features/agents/atoms';
import { type CodeSelectionContext, createTextPreview } from '@/features/agents/lib/queue-utils';
import { CompactPaneDigitBadge } from '@/features/agents/ui/split-view-container/pane-number-badge';
import { triggerFileTreeRefresh } from '@/features/files-sidebar/refresh-trigger';
import { useEditorWindowShortcuts } from '@/hooks/use-editor-window-shortcuts';
import { useTabOverflow } from '@/hooks/use-tab-overflow';
import {
  buildFileModelPath,
  canAutoRefreshFromExternalChange,
  getFullPath,
  isGitPointerPath,
  isMarkdownPreviewToggleShortcut,
  normalizePath,
  shouldApplyExternalRefreshResult,
  shouldScheduleExternalRefresh,
} from '@/lib/code-editor/files';
import {
  buildInlineDiffLayout,
  getInlineDiffState,
  isInlineDiffToggleShortcut,
  shouldAutoEnableInlineDiff,
} from '@/lib/code-editor/inline-diff';
import {
  getLSPClient,
  isLanguageSupported,
  registerAliasDefinitionProvider,
} from '@/lib/code-editor/lsp';
import {
  acquireTypes,
  clearProjectTypes,
  configureMonacoForNodeScripts,
  disableBuiltinTsDiagnostics,
  disposeATA,
  getMonacoNavigationOptions,
  initializeATA,
  loadProjectTypes,
  useMonacoTheme,
} from '@/lib/code-editor/monaco';
import {
  activeFileAtom,
  activeFilePathAtom,
  type CodeEditorLayout,
  chatContextFileAtomFamily,
  chatContextFileDismissedAtomFamily,
  closeFileAtom,
  closesEditorOnEscape,
  codeEditorActiveChatIdAtom,
  codeEditorHeightAtom,
  codeEditorLayoutAtom,
  codeEditorMaximizedAtom,
  codeEditorOpenAtom,
  codeEditorWidthAtom,
  codeSelectionContextAtomFamily,
  consumePendingReveal,
  diffModePreferenceAtom,
  editorActivePaneIndexAtom,
  editorIsSplitActiveAtom,
  fileKey,
  filterTabsToActivePaneAtom,
  getNextCodeEditorLayout,
  isImagePath,
  isMarkdownPath,
  isPdfPath,
  lastActiveTabPerPaneAtom,
  markFileSavedAtom,
  normalizeRevealSelection,
  type OpenFile,
  openFileAtom,
  openFilesAtom,
  pinFileAtom,
  type RevealLineDetail,
  revokeBlobUrlIfPresent,
  revokePdfBlobIfPresent,
  shouldRevealNow,
  trackPaneTabAtom,
  updateFileContentAtom,
} from '@/lib/code-editor/state';
import {
  disambiguateProjectPaths,
  getProjectName,
  groupFilesByProject,
} from '@/lib/code-editor/tabs';
import type { ShortcutActionId } from '@/lib/hotkeys';
import { appStore } from '@/lib/jotai-store';
import { getPaneColor } from '@/lib/pane-colors';
import { trpc, trpcClient } from '@/lib/trpc';
import { cn } from '@/lib/utils';

const MARKDOWN_PREVIEW_DEBOUNCE_MS = 200;
const MARKDOWN_PREVIEW_MAX_CHARS = 200_000;

const LOADING_MESSAGE = 'Loading...';

function sanitizeMonacoColorizedHtml(html: string): string {
  const template = document.createElement('template');
  template.innerHTML = html;

  const allElements = Array.from(template.content.querySelectorAll('*'));
  for (const element of allElements) {
    if (element.tagName !== 'SPAN') {
      const text = document.createTextNode(element.textContent ?? '');
      element.replaceWith(text);
      continue;
    }
    const attributes = Array.from(element.attributes);
    for (const attribute of attributes) {
      if (attribute.name !== 'class') {
        element.removeAttribute(attribute.name);
      }
    }
  }

  return template.innerHTML;
}

/** Build code selection context payload for the given editor selection and file */
function buildCodeSelectionContext(
  selection: { startLineNumber: number; endLineNumber: number },
  selectedText: string,
  currentFile: { path: string; name: string; language?: string },
): CodeSelectionContext {
  return {
    id: crypto.randomUUID(),
    text: selectedText,
    filePath: currentFile.path,
    fileName: currentFile.name,
    language: currentFile.language ?? 'plaintext',
    startLine: selection.startLineNumber,
    endLine: selection.endLineNumber,
    preview: createTextPreview(selectedText, 50),
    createdAt: new Date(),
  };
}

type FileTabProps = {
  file: OpenFile;
  /** Composite key for unique identity (from fileKey) */
  tabKey: string;
  isActive: boolean;
  onSelect: (key: string) => void;
  onPin: (key: string) => void;
  onClose: (key: string) => void;
  /** Whether split view is active (shows pane color indicator) */
  isSplitActive: boolean;
  /** Whether to animate entrance (only true during filter transitions) */
  animateEntrance?: boolean;
};

function WorktreeBadge({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-sm border border-primary/35 bg-primary/10 px-1 py-0 text-[9px] font-semibold uppercase tracking-wide text-primary/90',
        className,
      )}
    >
      WT
    </span>
  );
}

// Tab component for file tabs (pane-aware with color indicator)
const FileTab = memo(function FileTab({
  file,
  tabKey,
  isActive,
  onSelect,
  onPin,
  onClose,
  isSplitActive,
  animateEntrance,
}: FileTabProps) {
  const handleSelect = useCallback(() => {
    onSelect(tabKey);
  }, [onSelect, tabKey]);

  const handleClose = useCallback(() => {
    onClose(tabKey);
  }, [onClose, tabKey]);

  const handlePin = useCallback(() => {
    onPin(tabKey);
  }, [onPin, tabKey]);

  const paneColor =
    isSplitActive && file.sourcePaneIndex !== undefined ? getPaneColor(file.sourcePaneIndex) : null;
  const previewTooltip = file.isPreview ? 'Preview tab - double-click to pin' : file.name;

  return (
    <div
      role="tab"
      tabIndex={0}
      onClick={handleSelect}
      onDoubleClick={handlePin}
      onKeyDown={(e) => e.key === 'Enter' && handleSelect()}
      title={previewTooltip}
      className={cn(
        'group flex items-center gap-1.5 px-3 py-1.5 text-sm border-r border-border/50 transition-colors cursor-pointer select-none shrink-0',
        animateEntrance &&
          'motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-left-1 motion-safe:duration-150',
        // Pane-tinted backgrounds (matching sidebar ChatListItem pattern)
        paneColor
          ? cn(
              isActive ? paneColor.sidebarBg : paneColor.bg,
              'text-foreground',
              `border-l-2 ${paneColor.border}`,
            )
          : cn(
              'hover:bg-muted/50',
              isActive ? 'bg-background text-foreground' : 'bg-muted/30 text-muted-foreground',
            ),
      )}
    >
      {/* Pane digit badge */}
      {paneColor && file.sourcePaneIndex !== undefined && (
        <CompactPaneDigitBadge
          paneIndex={file.sourcePaneIndex}
          paneNumber={file.sourcePaneIndex + 1}
          className="h-3.5! min-w-[14px]! px-0.5! text-[9px]! leading-tight! max-w-8"
        />
      )}
      {file.isWorktreeContext && <WorktreeBadge className="h-3.5" />}
      <span
        className={cn(
          'truncate max-w-[120px]',
          file.isPreview && 'italic',
          file.isPreview && !isActive && 'text-muted-foreground/80',
          file.isPreview && isActive && 'text-foreground/85',
        )}
      >
        {file.name}
      </span>
      {file.isDirty && <span className="w-1.5 h-1.5 rounded-full bg-blue-500" />}
      <ToolbarIconButton
        onClick={handleClose}
        icon={<X className="h-3 w-3" />}
        label="Close tab"
        shortcutId="editor-close-tab"
        className={cn(
          'rounded p-0.5 transition-opacity',
          file.isPreview
            ? 'opacity-50 group-hover:opacity-100'
            : 'opacity-0 group-hover:opacity-100',
        )}
      />
    </div>
  );
});

type ProjectGroupSeparatorProps = {
  projectName: string;
};

/** Fade gradient overlay indicating hidden tabs beyond the scroll boundary */
const TabOverflowFade = memo(function TabOverflowFade({ side }: { side: 'left' | 'right' }) {
  return (
    <div
      className={cn(
        'absolute top-0 bottom-0 w-6 z-10 pointer-events-none',
        side === 'left'
          ? 'left-0 bg-linear-to-r from-muted/80 to-transparent'
          : 'right-0 bg-linear-to-l from-muted/80 to-transparent',
      )}
    />
  );
});

/** Separator between project groups in the tab bar */
const ProjectGroupSeparator = memo(function ProjectGroupSeparator({
  projectName,
}: ProjectGroupSeparatorProps) {
  return (
    <div className="flex items-center px-2 py-1.5 text-[10px] text-muted-foreground/60 font-medium uppercase tracking-wider select-none shrink-0 border-r border-border/30">
      {projectName}
    </div>
  );
});

/** Reusable icon button with tooltip for the editor toolbar and tab bar. */
function ToolbarIconButton({
  onClick,
  icon,
  label,
  shortcut,
  shortcutId,
  disabled,
  className = 'p-1 rounded transition-colors',
  ariaPressed,
}: {
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  shortcut?: string;
  shortcutId?: ShortcutActionId;
  disabled?: boolean;
  className?: string;
  ariaPressed?: boolean;
}) {
  const btn = (
    <Button
      variant="ghost"
      size="sm"
      onClick={onClick}
      disabled={disabled}
      className={className}
      aria-label={label}
      aria-pressed={ariaPressed}
      iconOnly
    >
      {icon}
    </Button>
  );

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {disabled ? (
          // biome-ignore lint/a11y/noNoninteractiveTabindex: Radix Tooltip requires a focusable trigger — disabled buttons swallow pointer/focus events, so we wrap in a focusable span
          <span className="inline-flex" tabIndex={0}>
            {btn}
          </span>
        ) : (
          btn
        )}
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {label}{' '}
        {shortcutId ? <Kbd shortcutId={shortcutId} /> : shortcut ? <Kbd>{shortcut}</Kbd> : null}
      </TooltipContent>
    </Tooltip>
  );
}

// Main CodeEditorPanel component
export function CodeEditorPanel() {
  const [isOpen, setIsOpen] = useAtom(codeEditorOpenAtom);
  const [files, setFiles] = useAtom(openFilesAtom);
  const [activePath, setActivePath] = useAtom(activeFilePathAtom);
  const activeFile = useAtomValue(activeFileAtom);
  const closeFile = useSetAtom(closeFileAtom);
  const codeEditorActiveChatId = useAtomValue(codeEditorActiveChatIdAtom);
  const updateContent = useSetAtom(updateFileContentAtom);
  const markFileSaved = useSetAtom(markFileSavedAtom);
  const pinFile = useSetAtom(pinFileAtom);
  const [height, setHeight] = useAtom(codeEditorHeightAtom);
  const [width, setWidth] = useAtom(codeEditorWidthAtom);
  const [layout, setLayout] = useAtom(codeEditorLayoutAtom);
  const [diffModePreference, setDiffModePreference] = useAtom(diffModePreferenceAtom);
  const selectedProject = useAtomValue(selectedProjectAtom);
  const monacoTheme = useMonacoTheme();
  const utils = trpc.useUtils();
  const clearResolverCacheMutation = trpc.files.clearResolverCache.useMutation();
  const clearResolverCacheMutateRef = useRef(clearResolverCacheMutation.mutate);
  clearResolverCacheMutateRef.current = clearResolverCacheMutation.mutate;

  // Split view pane awareness
  const isSplitActive = useAtomValue(editorIsSplitActiveAtom);
  const editorActivePaneIndex = useAtomValue(editorActivePaneIndexAtom);
  const lastActiveTabPerPane = useAtomValue(lastActiveTabPerPaneAtom);
  const trackPaneTab = useSetAtom(trackPaneTabAtom);
  const [filterToActivePane, setFilterToActivePane] = useAtom(filterTabsToActivePaneAtom);

  const [isMaximized, setIsMaximized] = useAtom(codeEditorMaximizedAtom);
  const [isResizing, setIsResizing] = useState(false);
  const [isMonacoReady, setIsMonacoReady] = useState(false);
  /** Brief flag: animate tab entrances only during filter transitions */
  const [animateTabs, setAnimateTabs] = useState(false);
  const animateTimerRef = useRef<NodeJS.Timeout | null>(null);
  const [markdownPreviewVisible, setMarkdownPreviewVisible] = useState(false);
  const [debouncedMarkdownPreview, setDebouncedMarkdownPreview] = useState('');
  const markdownPreviewSurfaceRef = useRef<HTMLElement | null>(null);
  const markdownPreviewDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const resizeStartY = useRef(0);
  const resizeStartX = useRef(0);
  const resizeStartHeight = useRef(0);
  const resizeStartWidth = useRef(0);
  const monacoRef = useRef<typeof import('monaco-editor') | null>(null);
  const editorRef = useRef<import('monaco-editor').editor.IStandaloneCodeEditor | null>(null);
  const lineChangeDecorationIdsRef = useRef<string[]>([]);
  const inlineDiffDecorationIdsRef = useRef<string[]>([]);
  const inlineDeletedZoneIdsRef = useRef<string[]>([]);
  const inlineDeletedZoneGenerationRef = useRef(0);
  const selectionDebounceTimer = useRef<NodeJS.Timeout | null>(null);
  const externalRefreshTimerRef = useRef<number | null>(null);
  const staleExternalFileKeysRef = useRef<Set<string>>(new Set());
  const pendingRevealRef = useRef<RevealLineDetail | null>(null);
  // Ref to track activeFile in selection callback (avoids stale closure)
  const activeFileRef = useRef(activeFile);
  activeFileRef.current = activeFile;
  const projectPathRef = useRef<string | undefined>(undefined);
  const editorOpenerDisposableRef = useRef<{ dispose(): void } | null>(null);
  // Ref for latest files so unmount cleanup can revoke PDF blob URLs without depending on [files]
  const filesRef = useRef(files);
  filesRef.current = files;
  const codeEditorActiveChatIdRef = useRef(codeEditorActiveChatId);
  codeEditorActiveChatIdRef.current = codeEditorActiveChatId;
  // Tab-bar overflow fade indicators — bound via useTabOverflow after visibleFiles is computed.
  const tabBarRef = useRef<HTMLDivElement>(null);

  // Clear the tab-entrance animation timer on unmount; dispose the editor opener.
  // (rAF cleanup for tab overflow lives inside useTabOverflow.)
  useEffect(() => {
    return () => {
      if (animateTimerRef.current !== null) clearTimeout(animateTimerRef.current);
      editorOpenerDisposableRef.current?.dispose();
      editorOpenerDisposableRef.current = null;
    };
  }, []);

  // Track last active tab per pane when active file changes
  useEffect(() => {
    if (activePath && activeFile?.sourcePaneIndex !== undefined) {
      trackPaneTab({ paneIndex: activeFile.sourcePaneIndex, key: activePath });
    }
  }, [activePath, activeFile?.sourcePaneIndex, trackPaneTab]);

  // Sync active file to per-chat context so context stays correct when switching tabs or after project switch
  useEffect(() => {
    if (!activeFile?.sourceChatId) return;
    appStore.set(chatContextFileAtomFamily(activeFile.sourceChatId), {
      name: activeFile.name,
      path: activeFile.path,
    });
  }, [activeFile?.sourceChatId, activeFile?.name, activeFile?.path]);

  // Auto-focus: when active pane changes in split view, switch to that pane's last active tab
  const prevPaneIndexRef = useRef(editorActivePaneIndex);
  useEffect(() => {
    if (
      !isSplitActive ||
      editorActivePaneIndex === null ||
      editorActivePaneIndex === prevPaneIndexRef.current
    ) {
      prevPaneIndexRef.current = editorActivePaneIndex;
      return;
    }
    prevPaneIndexRef.current = editorActivePaneIndex;
    const lastTab = lastActiveTabPerPane[editorActivePaneIndex];
    if (lastTab && files.some((f) => fileKey(f.path, f.projectPath) === lastTab)) {
      setActivePath(lastTab);
    }
  }, [editorActivePaneIndex, isSplitActive, lastActiveTabPerPane, files, setActivePath]);

  // Compute visible (possibly filtered) and grouped files for the tab bar
  const { visibleFiles, groupedFiles } = useMemo(() => {
    let visible = files;
    if (isSplitActive && filterToActivePane && editorActivePaneIndex !== null) {
      visible = files.filter((f) => f.sourcePaneIndex === editorActivePaneIndex);
    }
    return { visibleFiles: visible, groupedFiles: groupFilesByProject(visible) };
  }, [files, isSplitActive, filterToActivePane, editorActivePaneIndex]);

  // Tab-bar overflow fade indicators; re-measures on scroll/resize and when the
  // tab list or pane filter changes (both reflow the bar).
  const {
    canScrollLeft,
    canScrollRight,
    recheck: recheckTabOverflow,
  } = useTabOverflow(tabBarRef, [visibleFiles.length, filterToActivePane]);

  // Disambiguate project names when multiple projects share the same folder name.
  // Extract unique project paths first so disambiguation only recomputes when
  // the set of projects changes — not on every content edit.
  const uniqueProjectPaths = useMemo(() => {
    const seen = new Set<string>();
    for (const f of files) {
      if (f.projectPath) seen.add(f.projectPath);
    }
    return Array.from(seen).sort();
  }, [files]);

  const projectDisplayNames = useMemo(
    () => disambiguateProjectPaths(uniqueProjectPaths),
    [uniqueProjectPaths],
  );

  const previousInlineDiffAvailabilityRef = useRef(false);

  // Global editor shortcuts: cycle tabs (Cmd+Shift+]/[) and open Monaco's find widget.
  useEditorWindowShortcuts({ visibleFiles, activePath, setActivePath, editorRef, isOpen });

  const revealLineInEditor = useCallback((detail: RevealLineDetail): boolean => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model) {
      return false;
    }

    const { clampedLine, startColumn, endColumn, hasRange } = normalizeRevealSelection(
      detail,
      model.getLineCount(),
      (lineNumber: number) => model.getLineMaxColumn(lineNumber),
    );

    editor.layout();
    editor.focus();
    editor.setPosition({ lineNumber: clampedLine, column: startColumn });
    editor.setSelection({
      startLineNumber: clampedLine,
      startColumn,
      endLineNumber: clampedLine,
      endColumn,
    });
    if (hasRange) {
      const monaco = monacoRef.current;
      if (monaco) {
        editor.revealRangeInCenter(
          new monaco.Range(clampedLine, startColumn, clampedLine, endColumn),
        );
        return true;
      }
    }
    editor.revealLineInCenter(clampedLine);
    return true;
  }, []);

  // When filter hides the active tab, auto-switch to a visible tab
  useEffect(() => {
    if (!filterToActivePane || !activePath || visibleFiles.length === 0) return;
    const activeIsVisible = visibleFiles.some((f) => fileKey(f.path, f.projectPath) === activePath);
    if (!activeIsVisible) {
      const first = visibleFiles[0];
      setActivePath(fileKey(first.path, first.projectPath));
    }
  }, [filterToActivePane, activePath, visibleFiles, setActivePath]);

  // Load file content when active file changes and doesn't have content
  const activeFilePath = activeFile?.path;
  const activeFileKey = activeFile ? fileKey(activeFile.path, activeFile.projectPath) : null;
  const activeFileContent = activeFile?.content;
  const activeFileIsDirty = Boolean(activeFile?.isDirty);
  const activeFileHasLoadError = Boolean(activeFile?.loadError);
  // Use file-specific projectPath if available (split view), otherwise fall back to global
  const projectPath = activeFile?.projectPath ?? selectedProject?.path;
  projectPathRef.current = projectPath;
  const isTextEditorFile =
    !!activeFile && !isImagePath(activeFile.path ?? '') && !isPdfPath(activeFile.path ?? '');
  const isActiveMarkdownFile = Boolean(activeFile?.path && isMarkdownPath(activeFile.path));

  // biome-ignore lint/correctness/useExhaustiveDependencies: activePath is the composite tab key; body uses ref to avoid stale file when path changes
  useEffect(() => {
    const f = activeFileRef.current;
    if (!f?.path || !isMarkdownPath(f.path)) {
      setMarkdownPreviewVisible(false);
    }
  }, [activePath]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: activePath + activeFileContent intentionally reschedule debounce on tab switch and edits while preview is open
  useEffect(() => {
    if (!markdownPreviewVisible) return;
    const content = activeFileRef.current?.content ?? '';
    if (markdownPreviewDebounceRef.current) {
      clearTimeout(markdownPreviewDebounceRef.current);
    }
    markdownPreviewDebounceRef.current = setTimeout(() => {
      markdownPreviewDebounceRef.current = null;
      setDebouncedMarkdownPreview(content);
    }, MARKDOWN_PREVIEW_DEBOUNCE_MS);
    return () => {
      if (markdownPreviewDebounceRef.current) {
        clearTimeout(markdownPreviewDebounceRef.current);
        markdownPreviewDebounceRef.current = null;
      }
    };
  }, [activeFileContent, markdownPreviewVisible, activePath]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: activePath is the composite tab key; flush preview when switching markdown tabs while preview stays on
  useEffect(() => {
    if (!markdownPreviewVisible) return;
    const c = activeFileRef.current?.content;
    if (c !== undefined) {
      setDebouncedMarkdownPreview(c);
    }
  }, [activePath, markdownPreviewVisible]);

  const activeAbsoluteFilePath = activeFile ? getFullPath(projectPath, activeFile.path) : null;
  const activeFileModelPath = useMemo(() => {
    if (!activeFile) return undefined;
    return buildFileModelPath(projectPath, activeFile.path);
  }, [activeFile, projectPath]);
  const shouldLoadWorkingLineChanges = Boolean(
    isOpen &&
    projectPath &&
    activeFile &&
    isTextEditorFile &&
    activeFile.content !== undefined &&
    !activeFile.loadError,
  );

  // Find-in-files requests this event after opening a file. Apply now if active, otherwise queue.
  useEffect(() => {
    const handleRevealLine = (event: Event) => {
      const detail = (event as CustomEvent<RevealLineDetail>).detail;
      if (!detail?.filePath || typeof detail.lineNumber !== 'number') return;
      pendingRevealRef.current = detail;
      if (shouldRevealNow(detail, activeAbsoluteFilePath, isTextEditorFile)) {
        const applied = revealLineInEditor(detail);
        if (applied) {
          pendingRevealRef.current = null;
        }
      }
    };
    window.addEventListener('editor:reveal-line', handleRevealLine);
    return () => window.removeEventListener('editor:reveal-line', handleRevealLine);
  }, [activeAbsoluteFilePath, isTextEditorFile, revealLineInEditor]);

  useEffect(() => {
    const pendingDetail = consumePendingReveal(
      pendingRevealRef.current,
      activeAbsoluteFilePath,
      isTextEditorFile,
    );
    if (!pendingDetail) return;
    const applied = revealLineInEditor(pendingDetail);
    if (applied) {
      pendingRevealRef.current = null;
    }
  }, [activeAbsoluteFilePath, isTextEditorFile, revealLineInEditor]);

  const { data: workingLineChanges } = trpc.changes.getWorkingFileLineChanges.useQuery(
    {
      worktreePath: projectPath ?? '',
      filePath: activeFilePath ?? '',
    },
    {
      enabled: shouldLoadWorkingLineChanges,
      staleTime: 2_000,
      refetchOnWindowFocus: false,
    },
  );
  const workingLineChangeCount = workingLineChanges?.ranges.length ?? 0;
  const shouldShowWorkingLineChangeStatus = Boolean(
    workingLineChanges && (workingLineChanges.unsupported || workingLineChangeCount > 0),
  );
  const hasWorkingLineChanges = Boolean(
    !workingLineChanges?.unsupported && workingLineChangeCount > 0,
  );
  const { canShowInlineDiff, isDiffModeActive } = getInlineDiffState({
    isTextEditorFile,
    hasWorkingLineChanges,
    diffModePreference,
  });

  const shouldFetchOriginalContent = Boolean(
    isDiffModeActive && projectPath && activeFilePath && isTextEditorFile,
  );

  const { data: originalContentResult } = trpc.changes.getOriginalContent.useQuery(
    { worktreePath: projectPath ?? '', filePath: activeFilePath ?? '' },
    {
      enabled: shouldFetchOriginalContent,
      staleTime: 5_000,
      refetchOnWindowFocus: false,
    },
  );

  const [debouncedInlineDiffContent, setDebouncedInlineDiffContent] = useState(activeFileContent);
  useEffect(() => {
    if (!isDiffModeActive) {
      setDebouncedInlineDiffContent(activeFileContent);
      return;
    }
    const timer = window.setTimeout(() => {
      setDebouncedInlineDiffContent(activeFileContent);
    }, 150);
    return () => window.clearTimeout(timer);
  }, [activeFileContent, isDiffModeActive]);

  const inlineDiffLayout = useMemo(() => {
    if (
      !isDiffModeActive ||
      originalContentResult?.content == null ||
      debouncedInlineDiffContent == null
    ) {
      return null;
    }
    return buildInlineDiffLayout(originalContentResult.content, debouncedInlineDiffContent);
  }, [isDiffModeActive, originalContentResult?.content, debouncedInlineDiffContent]);

  useEffect(() => {
    const shouldEnable = shouldAutoEnableInlineDiff({
      wasInlineDiffAvailable: previousInlineDiffAvailabilityRef.current,
      isInlineDiffAvailable: canShowInlineDiff,
    });
    previousInlineDiffAvailabilityRef.current = canShowInlineDiff;
    if (shouldEnable) {
      setDiffModePreference(true);
    }
  }, [canShowInlineDiff, setDiffModePreference]);

  const clearWorkingLineChangeDecorations = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) {
      lineChangeDecorationIdsRef.current = [];
      return;
    }
    lineChangeDecorationIdsRef.current = editor.deltaDecorations(
      lineChangeDecorationIdsRef.current,
      [],
    );
  }, []);

  const applyWorkingLineChangeDecorations = useCallback(() => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    const ranges = workingLineChanges?.ranges ?? [];
    if (!editor || !monaco || ranges.length === 0) {
      clearWorkingLineChangeDecorations();
      return;
    }

    const model = editor.getModel();
    if (!model) {
      clearWorkingLineChangeDecorations();
      return;
    }

    const lineCount = model.getLineCount();
    if (lineCount < 1) {
      clearWorkingLineChangeDecorations();
      return;
    }

    const richDiffActive = Boolean(inlineDiffLayout?.hasChanges);

    const decorations = ranges.map((range) => {
      const classSuffix = range.type;
      const startLine = Math.min(Math.max(range.startLine, 1), lineCount);
      const endLine = Math.min(Math.max(range.endLine, startLine), lineCount);

      return {
        range: new monaco.Range(startLine, 1, endLine, 1),
        options: {
          isWholeLine: true,
          glyphMarginClassName: `frink-diff-glyphbar-${classSuffix}`,
          ...(isDiffModeActive &&
            !richDiffActive && {
              className: `frink-diff-line-${classSuffix}`,
            }),
          hoverMessage: {
            value:
              range.type === 'added'
                ? 'Added lines (working tree vs HEAD)'
                : range.type === 'deleted'
                  ? 'Line(s) removed near this location (working tree vs HEAD)'
                  : 'Modified lines (working tree vs HEAD)',
          },
          overviewRuler: {
            color:
              range.type === 'added'
                ? 'rgba(34, 197, 94, 0.9)'
                : range.type === 'deleted'
                  ? 'rgba(239, 68, 68, 0.85)'
                  : 'rgba(59, 130, 246, 0.9)',
            position: monaco.editor.OverviewRulerLane.Left,
          },
        },
      };
    });

    lineChangeDecorationIdsRef.current = editor.deltaDecorations(
      lineChangeDecorationIdsRef.current,
      decorations,
    );
  }, [
    workingLineChanges?.ranges,
    isDiffModeActive,
    inlineDiffLayout?.hasChanges,
    clearWorkingLineChangeDecorations,
  ]);

  const updateFileContentByKey = useCallback(
    (
      key: string,
      update: {
        content: string;
        loadError: boolean;
        loadErrorMessage?: string;
      },
    ) => {
      setFiles((prev) =>
        prev.map((f) => (fileKey(f.path, f.projectPath) === key ? { ...f, ...update } : f)),
      );
    },
    [setFiles],
  );

  useEffect(() => {
    const shouldReloadStaleActiveFile = activeFileKey
      ? staleExternalFileKeysRef.current.has(activeFileKey)
      : false;
    if (
      activeFilePath &&
      activeFileKey &&
      (activeFileContent === undefined || shouldReloadStaleActiveFile)
    ) {
      const fullPath = getFullPath(projectPath, activeFilePath);
      const key = activeFileKey;
      const loadImage = isImagePath(activeFilePath);
      const loadPdf = isPdfPath(activeFilePath);
      const onError = (err: unknown) => {
        const message =
          err instanceof Error
            ? err.message
            : loadImage
              ? 'Could not load image.'
              : loadPdf
                ? 'Could not load PDF.'
                : 'Could not load file.';
        staleExternalFileKeysRef.current.delete(key);
        updateFileContentByKey(key, { content: '', loadError: true, loadErrorMessage: message });
      };
      if (loadImage) {
        trpcClient.files.readImageFile
          .query({ filePath: fullPath })
          .then(({ dataUrl }) => {
            staleExternalFileKeysRef.current.delete(key);
            updateFileContentByKey(key, {
              content: dataUrl,
              loadError: false,
              loadErrorMessage: undefined,
            });
          })
          .catch(onError);
      } else if (loadPdf) {
        trpcClient.files.readPdfFile
          .query({ filePath: fullPath })
          .then(({ base64 }) => {
            const stillOpen = filesRef.current.some((f) => fileKey(f.path, f.projectPath) === key);
            if (!stillOpen) return;
            const binary = atob(base64);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
            const blob = new Blob([bytes], { type: 'application/pdf' });
            const blobUrl = URL.createObjectURL(blob);
            if (!filesRef.current.some((f) => fileKey(f.path, f.projectPath) === key)) {
              revokeBlobUrlIfPresent(blobUrl);
              return;
            }
            const previousContent = filesRef.current.find(
              (f) => fileKey(f.path, f.projectPath) === key,
            )?.content;
            updateFileContentByKey(key, {
              content: blobUrl,
              loadError: false,
              loadErrorMessage: undefined,
            });
            staleExternalFileKeysRef.current.delete(key);
            if (previousContent !== blobUrl) revokeBlobUrlIfPresent(previousContent);
          })
          .catch(onError);
      } else {
        trpcClient.files.readFile
          .query({ filePath: fullPath })
          .then((content) => {
            staleExternalFileKeysRef.current.delete(key);
            updateFileContentByKey(key, {
              content,
              loadError: false,
              loadErrorMessage: undefined,
            });
          })
          .catch(onError);
      }
    }
  }, [activeFilePath, activeFileKey, activeFileContent, projectPath, updateFileContentByKey]);

  // Reload clean active text tabs after external edits/git operations.
  useEffect(() => {
    if (!activeFilePath || !activeFileKey || !projectPath) {
      return;
    }

    const canAutoRefreshActiveFile = canAutoRefreshFromExternalChange({
      isDirty: activeFileIsDirty,
      hasContent: activeFileContent !== undefined,
      hasLoadError: activeFileHasLoadError,
      isTextEditorFile,
    });

    const fullPath = getFullPath(projectPath, activeFilePath);
    const activeKey = activeFileKey;
    const normalizedFullPath = normalizePath(fullPath);
    const shouldApplyToLatestActiveFile = () => {
      const latestActiveFile = activeFileRef.current;
      if (!latestActiveFile) return false;
      return shouldApplyExternalRefreshResult({
        activeFileKey: fileKey(latestActiveFile.path, latestActiveFile.projectPath),
        incomingFileKey: activeKey,
        isDirty: Boolean(latestActiveFile.isDirty),
        isImageFile: isImagePath(latestActiveFile.path),
        isPdfFile: isPdfPath(latestActiveFile.path),
      });
    };

    const refreshActiveFileFromDisk = () => {
      trpcClient.files.readFile
        .query({ filePath: fullPath })
        .then((content) => {
          if (!shouldApplyToLatestActiveFile()) {
            return;
          }
          updateFileContentByKey(activeKey, {
            content,
            loadError: false,
            loadErrorMessage: undefined,
          });
          staleExternalFileKeysRef.current.delete(activeKey);
        })
        .catch((error) => {
          if (!shouldApplyToLatestActiveFile()) {
            return;
          }

          const message =
            error instanceof Error
              ? `Could not reload file after external change: ${error.message}`
              : 'Could not reload file after external change.';
          updateFileContentByKey(activeKey, {
            content: '',
            loadError: true,
            loadErrorMessage: message,
          });
          staleExternalFileKeysRef.current.delete(activeKey);
        });
    };

    const scheduleRefresh = () => {
      if (externalRefreshTimerRef.current !== null) {
        window.clearTimeout(externalRefreshTimerRef.current);
      }
      externalRefreshTimerRef.current = window.setTimeout(() => {
        refreshActiveFileFromDisk();
        externalRefreshTimerRef.current = null;
      }, 120);
    };

    const cleanupGitStatus = window.desktopApi?.onGitStatusChanged?.((payload) => {
      const hasPointerChange = payload.changes.some((change) => isGitPointerPath(change.path));
      if (hasPointerChange && payload.worktreePath === projectPath) {
        void utils.changes.getOriginalContent.invalidate({
          worktreePath: projectPath,
          filePath: activeFilePath,
        });
        const nextStaleKeys = new Set(staleExternalFileKeysRef.current);
        for (const file of filesRef.current) {
          if (file.projectPath !== projectPath) continue;
          if (file.isDirty || isImagePath(file.path) || isPdfPath(file.path)) continue;
          nextStaleKeys.add(fileKey(file.path, file.projectPath));
        }
        staleExternalFileKeysRef.current = nextStaleKeys;
      }
      if (
        canAutoRefreshActiveFile &&
        shouldScheduleExternalRefresh({
          watchedWorktreePath: projectPath,
          eventWorktreePath: payload.worktreePath,
          activeFileFullPath: normalizedFullPath,
          changes: payload.changes,
        })
      ) {
        scheduleRefresh();
      }
    });

    const cleanupFileChanged = window.desktopApi?.onFileChanged?.((payload) => {
      if (!canAutoRefreshActiveFile) return;
      if (normalizePath(payload.filePath) !== normalizedFullPath) return;
      scheduleRefresh();
    });

    return () => {
      cleanupGitStatus?.();
      cleanupFileChanged?.();
      if (externalRefreshTimerRef.current !== null) {
        window.clearTimeout(externalRefreshTimerRef.current);
        externalRefreshTimerRef.current = null;
      }
    };
  }, [
    activeFilePath,
    activeFileKey,
    activeFileIsDirty,
    activeFileHasLoadError,
    projectPath,
    isTextEditorFile,
    activeFileContent,
    updateFileContentByKey,
    utils,
  ]);

  useEffect(() => {
    if (!shouldLoadWorkingLineChanges) {
      clearWorkingLineChangeDecorations();
      return;
    }
    applyWorkingLineChangeDecorations();
  }, [
    shouldLoadWorkingLineChanges,
    applyWorkingLineChangeDecorations,
    clearWorkingLineChangeDecorations,
  ]);

  const clearInlineDiffDecorations = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) {
      inlineDiffDecorationIdsRef.current = [];
      return;
    }
    inlineDiffDecorationIdsRef.current = editor.deltaDecorations(
      inlineDiffDecorationIdsRef.current,
      [],
    );
  }, []);

  const clearInlineDeletedZones = useCallback(() => {
    inlineDeletedZoneGenerationRef.current += 1;
    const editor = editorRef.current;
    if (!editor || inlineDeletedZoneIdsRef.current.length === 0) return;
    editor.changeViewZones((accessor) => {
      for (const zoneId of inlineDeletedZoneIdsRef.current) {
        accessor.removeZone(zoneId);
      }
    });
    inlineDeletedZoneIdsRef.current = [];
  }, []);

  const applyInlineDiffDecorations = useCallback(() => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    const layout = inlineDiffLayout;

    if (!editor || !monaco || !layout?.hasChanges) {
      clearInlineDiffDecorations();
      clearInlineDeletedZones();
      return;
    }

    const model = editor.getModel();
    if (!model) return;
    const lineCount = model.getLineCount();

    const decorations: import('monaco-editor').editor.IModelDeltaDecoration[] = [];

    for (const ld of layout.lineDecorations) {
      const startLine = Math.min(Math.max(ld.startLine, 1), lineCount);
      const endLine = Math.min(Math.max(ld.endLine, startLine), lineCount);
      decorations.push({
        range: new monaco.Range(startLine, 1, endLine, 1),
        options: {
          isWholeLine: true,
          className: ld.type === 'added' ? 'frink-diff-line-added' : 'frink-diff-line-modified',
        },
      });
    }

    for (const td of layout.tokenDecorations) {
      if (td.lineNumber < 1 || td.lineNumber > lineCount) continue;
      if (td.startColumn >= td.endColumn) continue;
      const lineContent = model.getLineContent(td.lineNumber);
      const maxCol = lineContent.length + 1;
      const startCol = Math.min(td.startColumn, maxCol);
      const endCol = Math.min(td.endColumn, maxCol);
      if (startCol >= endCol) continue;
      decorations.push({
        range: new monaco.Range(td.lineNumber, startCol, td.lineNumber, endCol),
        options: {
          className: 'frink-inline-token-modified',
        },
      });
    }

    inlineDiffDecorationIdsRef.current = editor.deltaDecorations(
      inlineDiffDecorationIdsRef.current,
      decorations,
    );

    clearInlineDeletedZones();
    if (layout.deletedBlocks.length > 0) {
      const lang = activeFile?.language ?? 'plaintext';
      const fontInfo = editor.getOption(monaco.editor.EditorOption.fontInfo);

      editor.changeViewZones((accessor) => {
        const newZoneIds: string[] = [];
        for (const block of layout.deletedBlocks) {
          const zoneHeight = block.lines.length * fontInfo.lineHeight;
          const domNode = document.createElement('div');
          domNode.className = 'frink-inline-deleted-zone';
          domNode.setAttribute('aria-hidden', 'true');
          domNode.style.height = `${zoneHeight}px`;
          domNode.style.overflow = 'hidden';

          const pre = document.createElement('pre');
          pre.className = 'frink-inline-deleted-pre';
          pre.style.margin = '0';
          pre.style.padding = '0';
          pre.style.fontFamily = fontInfo.fontFamily;
          pre.style.fontSize = `${fontInfo.fontSize}px`;
          pre.style.lineHeight = `${fontInfo.lineHeight}px`;
          pre.style.letterSpacing = `${fontInfo.letterSpacing}px`;
          pre.style.whiteSpace = 'pre';
          pre.style.tabSize = `${editor.getModel()?.getOptions().tabSize ?? 2}`;
          domNode.appendChild(pre);

          const zoneId = accessor.addZone({
            afterLineNumber: Math.min(Math.max(block.afterLineNumber, 0), lineCount),
            heightInLines: block.lines.length,
            domNode,
          });
          newZoneIds.push(zoneId);

          const text = block.lines.join('\n');
          const zoneGeneration = inlineDeletedZoneGenerationRef.current;
          monaco.editor
            .colorize(text, lang, { tabSize: editor.getModel()?.getOptions().tabSize ?? 2 })
            .then((html) => {
              if (zoneGeneration !== inlineDeletedZoneGenerationRef.current) return;
              if (!pre.isConnected) return;
              pre.innerHTML = sanitizeMonacoColorizedHtml(html);
            })
            .catch(() => {});
        }
        inlineDeletedZoneIdsRef.current = newZoneIds;
      });
    }
  }, [inlineDiffLayout, activeFile?.language, clearInlineDiffDecorations, clearInlineDeletedZones]);

  useEffect(() => {
    if (!isDiffModeActive || !inlineDiffLayout?.hasChanges) {
      clearInlineDiffDecorations();
      clearInlineDeletedZones();
      return;
    }
    applyInlineDiffDecorations();
  }, [
    isDiffModeActive,
    inlineDiffLayout,
    applyInlineDiffDecorations,
    clearInlineDiffDecorations,
    clearInlineDeletedZones,
  ]);

  // Load project TypeScript files for local type inference
  useEffect(() => {
    const monaco = monacoRef.current;
    if (!projectPath || !monaco || !isMonacoReady) return;

    let aliasDisposable: { dispose(): void } | undefined;
    let cancelled = false;

    loadProjectTypes(monaco, projectPath)
      .then(() => {
        if (cancelled) return;
        aliasDisposable = registerAliasDefinitionProvider(monaco, projectPath);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      aliasDisposable?.dispose();
      clearResolverCacheMutateRef.current();
      clearProjectTypes();
    };
  }, [projectPath, isMonacoReady]);

  // Initialize LSP client when language/workspace changes
  useEffect(() => {
    const lspClient = getLSPClient();
    const language = activeFile?.language;
    const monaco = monacoRef.current;

    // Try to initialize LSP for real diagnostics (from language server)
    // Note: Built-in diagnostics are already disabled in beforeMount
    if (projectPath && language && monaco && isLanguageSupported(language)) {
      lspClient.initialize(monaco, projectPath, language).catch(() => {});
    }

    // Cleanup on unmount
    return () => {
      if (lspClient.isRunning()) {
        lspClient.stop().catch((_error) => {});
      }
    };
  }, [projectPath, activeFile?.language]);

  // Cleanup ATA on unmount
  useEffect(() => {
    return () => {
      disposeATA();
      clearWorkingLineChangeDecorations();
      clearInlineDiffDecorations();
      clearInlineDeletedZones();
    };
  }, [clearWorkingLineChangeDecorations, clearInlineDiffDecorations, clearInlineDeletedZones]);

  // Revoke PDF blob URLs only when panel unmounts (not when files change, or we revoke blobs for tabs we're just switching away from)
  useEffect(() => {
    return () => {
      filesRef.current.forEach(revokePdfBlobIfPresent);
    };
  }, []);

  // Clear code selection only for the owning chat when panel closes, file closes, or switching to image/PDF tab (explicit triggers only)
  useEffect(() => {
    if (
      !isOpen ||
      !activePath ||
      (activeFile && (isImagePath(activeFile.path) || isPdfPath(activeFile.path)))
    ) {
      const chatId = codeEditorActiveChatId;
      if (chatId) appStore.set(codeSelectionContextAtomFamily(chatId), null);
    }
  }, [isOpen, activePath, activeFile, codeEditorActiveChatId]);

  // Helper: write current editor selection to a chat's code selection atom (if non-empty and file matches)
  const applySelectionToChat = useCallback((chatId: string) => {
    const editor = editorRef.current;
    const currentFile = activeFileRef.current;
    if (!editor || !currentFile) return;
    const selection = editor.getSelection();
    if (!selection || selection.isEmpty()) return;
    const selectedText = editor.getModel()?.getValueInRange(selection) ?? '';
    if (selectedText.length < 1) return;
    appStore.set(
      codeSelectionContextAtomFamily(chatId),
      buildCodeSelectionContext(selection, selectedText, currentFile),
    );
  }, []);

  // Re-sync selection when active chat changes (pane switch) so the new pane gets the visible selection
  useEffect(() => {
    if (!codeEditorActiveChatId || !isOpen) return;
    applySelectionToChat(codeEditorActiveChatId);
  }, [codeEditorActiveChatId, isOpen, applySelectionToChat]);

  // Setup selection listener when Monaco is ready. Clear on empty selection so deselecting puts the file back in context (active file chip).
  // biome-ignore lint/correctness/useExhaustiveDependencies: isMonacoReady intentionally triggers re-run after editor mounts
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !isOpen || !activePath) return;

    const debounceDelay = 300;
    const disposable = editor.onDidChangeCursorSelection(() => {
      if (selectionDebounceTimer.current) {
        clearTimeout(selectionDebounceTimer.current);
      }

      selectionDebounceTimer.current = setTimeout(() => {
        const selection = editor.getSelection();
        const chatId = codeEditorActiveChatIdRef.current;
        if (!chatId) return;

        if (!selection || selection.isEmpty()) {
          appStore.set(codeSelectionContextAtomFamily(chatId), null);
          appStore.set(chatContextFileDismissedAtomFamily(chatId), false);
          const currentFile = activeFileRef.current;
          if (currentFile) {
            appStore.set(chatContextFileAtomFamily(chatId), {
              name: currentFile.name,
              path: currentFile.path,
            });
          }
          return;
        }

        const selectedText = editor.getModel()?.getValueInRange(selection) ?? '';
        if (selectedText.length < 1) return;

        const currentFile = activeFileRef.current;
        if (!currentFile) return;

        appStore.set(
          codeSelectionContextAtomFamily(chatId),
          buildCodeSelectionContext(selection, selectedText, currentFile),
        );
      }, debounceDelay);
    });

    // Re-sync current selection to active chat when listener is attached (e.g. after tab switch)
    const chatId = codeEditorActiveChatIdRef.current;
    if (chatId) applySelectionToChat(chatId);

    return () => {
      disposable.dispose();
      // Clear stale selection when switching away from this file so fileB doesn't show fileA's selection
      const chatId = codeEditorActiveChatIdRef.current;
      if (chatId) appStore.set(codeSelectionContextAtomFamily(chatId), null);
      if (selectionDebounceTimer.current) {
        clearTimeout(selectionDebounceTimer.current);
      }
    };
  }, [activePath, isOpen, isMonacoReady, applySelectionToChat]);

  const handleSave = useCallback(async () => {
    if (!activePath || !activeFile) return;
    if (isImagePath(activeFile.path) || isPdfPath(activeFile.path)) return;
    // Allow Cmd/Ctrl+S to pin preview tabs even when unchanged (VS Code-like behavior).
    if (!activeFile.isDirty) {
      if (activeFile.isPreview) {
        pinFile(activePath);
      }
      return;
    }
    if (activeFile.content === undefined) return;

    const content = activeFile.content;
    // activePath is composite key; use activeFile.path for the actual filesystem path
    const fullPath = getFullPath(projectPath, activeFile.path);
    try {
      await trpcClient.files.writeFile.mutate({ filePath: fullPath, content });
      markFileSaved(activePath); // composite key
      // Invalidate file tree cache to refresh git status indicators
      utils.files.listDirectory.invalidate();
      // Git status is worktree-scoped — a file outside any project has none to refresh.
      if (projectPath) {
        utils.changes.getStatus.invalidate({ worktreePath: projectPath });
        utils.changes.getWorkingFileLineChanges.invalidate({
          worktreePath: projectPath,
          filePath: activeFile.path,
        });
        utils.changes.getOriginalContent.invalidate({
          worktreePath: projectPath,
          filePath: activeFile.path,
        });
        // Trigger file tree refresh event so expanded folders reload with fresh git status
        triggerFileTreeRefresh(projectPath);
      }
    } catch (_err) {
      toast.error('Failed to save file');
    }
  }, [activePath, activeFile, projectPath, pinFile, markFileSaved, utils]);

  const toggleMarkdownPreview = useCallback(() => {
    setMarkdownPreviewVisible((prev) => {
      const next = !prev;
      const file = activeFileRef.current;
      if (next && file?.content !== undefined) {
        setDebouncedMarkdownPreview(file.content);
        requestAnimationFrame(() => {
          markdownPreviewSurfaceRef.current?.focus();
        });
      } else if (!next) {
        requestAnimationFrame(() => {
          editorRef.current?.focus();
        });
      }
      return next;
    });
  }, []);

  // Handle ESC to close, Cmd+W close tab, Cmd+S save, Cmd+Shift+I diff toggle,
  // Cmd+Shift+]/[ cycle tab, Cmd+Shift+M maximize; Cmd+Alt+V markdown preview (markdown files)
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const inPanel = Boolean(panelRef.current?.contains(e.target as Node));
      const isToggleMaximize = e.code === 'KeyM' || e.key.toLowerCase() === 'm';

      // Cmd+Shift+M — toggle maximize/restore while editor panel is open (global)
      if (mod && e.shiftKey && isToggleMaximize && isOpen) {
        e.preventDefault();
        e.stopPropagation();
        setIsMaximized((prev) => !prev);
        return;
      }

      if (
        isInlineDiffToggleShortcut({
          key: e.key,
          code: e.code,
          metaKey: e.metaKey,
          ctrlKey: e.ctrlKey,
          shiftKey: e.shiftKey,
          isEditorOpen: isOpen,
          canShowInlineDiff,
        })
      ) {
        e.preventDefault();
        e.stopPropagation();
        setDiffModePreference((prev) => !prev);
        return;
      }

      if (
        isMarkdownPreviewToggleShortcut({
          key: e.key,
          code: e.code,
          metaKey: e.metaKey,
          ctrlKey: e.ctrlKey,
          shiftKey: e.shiftKey,
          altKey: e.altKey,
          isEditorOpen: isOpen,
          inPanel,
          filePath: activeFileRef.current?.path,
        })
      ) {
        e.preventDefault();
        e.stopPropagation();
        toggleMarkdownPreview();
        return;
      }

      // Cmd+Shift+]/[ — next/prev editor tab (fallback when focus is in Monaco)
      if (mod && e.shiftKey && inPanel) {
        const isNext = e.key === ']' || e.key === '}' || e.code === 'BracketRight';
        const isPrev = e.key === '[' || e.key === '{' || e.code === 'BracketLeft';
        if (isNext) {
          e.preventDefault();
          e.stopPropagation();
          window.dispatchEvent(new CustomEvent('editor:cycle-pane-group', { detail: 1 }));
          return;
        }
        if (isPrev) {
          e.preventDefault();
          e.stopPropagation();
          window.dispatchEvent(new CustomEvent('editor:cycle-pane-group', { detail: -1 }));
          return;
        }
      }

      if (isOpen && closesEditorOnEscape(e)) {
        e.stopPropagation();
        setIsOpen(false);
        setIsMaximized(false);
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'w' && isOpen && activePath) {
        e.preventDefault();
        closeFile(activePath);
      }
      if (
        (e.metaKey || e.ctrlKey) &&
        e.key === 's' &&
        isOpen &&
        activeFile &&
        (activeFile.isDirty || activeFile.isPreview)
      ) {
        e.preventDefault();
        void handleSave();
      }
    },
    [
      isOpen,
      activePath,
      activeFile,
      canShowInlineDiff,
      closeFile,
      handleSave,
      setDiffModePreference,
      setIsMaximized,
      setIsOpen,
      toggleMarkdownPreview,
    ],
  );

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [handleKeyDown]);

  // Vertical resize handling (bottom edge)
  const handleVerticalResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setIsResizing(true);
      resizeStartY.current = e.clientY;
      resizeStartHeight.current = height;
    },
    [height],
  );

  // Side resize handling (left/right edge)
  const handleHorizontalResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setIsResizing(true);
      resizeStartX.current = e.clientX;
      resizeStartWidth.current = width;
    },
    [width],
  );

  useEffect(() => {
    if (!isResizing) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (layout === 'top') {
        // Dragging down (positive delta) should increase editor height
        const delta = e.clientY - resizeStartY.current;
        const newHeight = Math.min(
          90,
          Math.max(20, resizeStartHeight.current + (delta / window.innerHeight) * 100),
        );
        setHeight(newHeight);
      } else {
        // Left layout grows when dragging right; right layout grows when dragging left.
        const delta = e.clientX - resizeStartX.current;
        const effectiveDelta = layout === 'left' ? delta : -delta;
        const newWidth = Math.min(
          80,
          Math.max(20, resizeStartWidth.current + (effectiveDelta / window.innerWidth) * 100),
        );
        setWidth(newWidth);
      }
    };

    const handleMouseUp = () => {
      setIsResizing(false);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizing, layout, setHeight, setWidth]);

  const handleTabSelect = useCallback(
    (path: string) => {
      setActivePath(path);
    },
    [setActivePath],
  );

  const handleTabClose = useCallback(
    (path: string) => {
      closeFile(path);
    },
    [closeFile],
  );

  const handleTabPin = useCallback(
    (path: string) => {
      pinFile(path);
    },
    [pinFile],
  );

  const handleEditorChange = useCallback(
    (value: string | undefined) => {
      if (activePath && value !== undefined) {
        updateContent({ key: activePath, content: value });
        // Trigger ATA for type acquisition (debounced internally by ATA)
        acquireTypes(value);
      }
    },
    [activePath, updateContent],
  );

  const handleToggleMaximize = useCallback(() => {
    setIsMaximized((prev) => !prev);
  }, [setIsMaximized]);

  const handleToggleLayout = useCallback(() => {
    setLayout((prev) => getNextCodeEditorLayout(prev));
  }, [setLayout]);

  if (files.length === 0) {
    return null;
  }

  const effectiveHeight = isMaximized ? 100 : height;
  const effectiveWidth = isMaximized ? 100 : width;
  const isTopLayout = layout === 'top';
  const isLeftLayout = layout === 'left';
  const isRightLayout = layout === 'right';
  const isSideLayout = isLeftLayout || isRightLayout;
  const nextLayout = getNextCodeEditorLayout(layout);

  const getLayoutControlIcon = (next: CodeEditorLayout) => {
    if (next === 'top') return <PanelTop className="h-4 w-4 text-muted-foreground" />;
    if (next === 'left') return <PanelLeft className="h-4 w-4 text-muted-foreground" />;
    return <PanelRight className="h-4 w-4 text-muted-foreground" />;
  };

  const getLayoutControlLabel = (next: CodeEditorLayout): string => {
    if (next === 'top') return 'Move editor to top';
    if (next === 'left') return 'Move editor to left';
    return 'Move editor to right';
  };

  // Animation variants based on layout
  const animationProps = isTopLayout
    ? {
        initial: { y: '-100%', opacity: 0 },
        animate: { y: 0, opacity: 1 },
        exit: { y: '-100%', opacity: 0 },
      }
    : isLeftLayout
      ? {
          initial: { x: '-100%', opacity: 0 },
          animate: { x: 0, opacity: 1 },
          exit: { x: '-100%', opacity: 0 },
        }
      : {
          initial: { x: '100%', opacity: 0 },
          animate: { x: 0, opacity: 1 },
          exit: { x: '100%', opacity: 0 },
        };

  // Panel positioning based on layout
  const panelStyle = isSideLayout
    ? { width: `${effectiveWidth}%`, height: '100%' }
    : {
        height: `${effectiveHeight}%`,
        // Top layout: width must be explicit so maximized + markdown preview fills the host (inset-x alone can shrink-wrap in some flex parents).
        width: '100%',
      };

  const panelZ = isMaximized ? 'z-60' : 'z-40';
  const panelClassName = isTopLayout
    ? `absolute inset-x-0 top-0 ${panelZ} min-h-0 bg-background border-b border-border shadow-lg flex flex-col`
    : isLeftLayout
      ? `absolute inset-y-0 left-0 ${panelZ} min-h-0 bg-background border-r border-border shadow-lg flex flex-col`
      : `absolute inset-y-0 right-0 ${panelZ} min-h-0 bg-background border-l border-border shadow-lg flex flex-col`;

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          ref={panelRef}
          data-code-editor-panel="true"
          {...animationProps}
          transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
          className={panelClassName}
          style={panelStyle}
        >
          {/* Resize handle - positioned based on layout */}
          {!isMaximized && (
            <div
              role="slider"
              aria-label="Resize editor panel"
              aria-valuemin={20}
              aria-valuemax={isSideLayout ? 80 : 90}
              aria-valuenow={Math.round(isSideLayout ? width : height)}
              tabIndex={0}
              className={cn(
                'absolute transition-colors z-10',
                isTopLayout
                  ? 'bottom-0 left-0 right-0 h-1.5 cursor-ns-resize hover:bg-primary/30'
                  : cn(
                      'top-0 bottom-0 w-1.5 cursor-ew-resize hover:bg-primary/30',
                      isLeftLayout ? 'right-0' : 'left-0',
                    ),
                isResizing && 'bg-primary/50',
              )}
              onMouseDown={isTopLayout ? handleVerticalResizeStart : handleHorizontalResizeStart}
            >
              {/* Visual indicator line */}
              <div
                className={cn(
                  'absolute bg-border',
                  isTopLayout
                    ? 'bottom-0 left-0 right-0 h-px'
                    : cn('top-0 bottom-0 w-px', isLeftLayout ? 'right-0' : 'left-0'),
                )}
              />
            </div>
          )}

          {/* Header with tabs — shrink-0 + z so tall markdown preview cannot overlap toolbar clicks */}
          <div className="relative z-10 flex shrink-0 items-center border-b border-border bg-muted/30 min-h-[36px]">
            {/* File tabs - grouped by project in split view */}
            <div className="relative flex-1 min-w-0">
              {canScrollLeft && <TabOverflowFade side="left" />}
              {canScrollRight && <TabOverflowFade side="right" />}
              {/* Screen reader announcement for hidden tabs beyond scroll bounds */}
              {(canScrollLeft || canScrollRight) && (
                <span className="sr-only" aria-live="polite">
                  {canScrollLeft && canScrollRight
                    ? 'More tabs available on both sides'
                    : canScrollLeft
                      ? 'More tabs available to the left'
                      : 'More tabs available to the right'}
                </span>
              )}
              <div
                className="flex items-center overflow-x-auto scrollbar-thin"
                role="tablist"
                ref={tabBarRef}
                onScroll={recheckTabOverflow}
              >
                {visibleFiles.length === 0 && filterToActivePane ? (
                  <output className="px-3 py-1.5 text-xs text-muted-foreground italic">
                    No files from this pane
                  </output>
                ) : isSplitActive && groupedFiles.length > 1 ? (
                  groupedFiles.map((group) => (
                    <div key={group.projectPath ?? 'none'} className="flex items-center shrink-0">
                      <ProjectGroupSeparator
                        projectName={
                          group.projectPath
                            ? (projectDisplayNames.get(group.projectPath) ?? group.projectName)
                            : group.projectName
                        }
                      />
                      {group.files.map((file) => {
                        const key = fileKey(file.path, file.projectPath);
                        return (
                          <FileTab
                            key={key}
                            tabKey={key}
                            file={file}
                            isActive={key === activePath}
                            onSelect={handleTabSelect}
                            onPin={handleTabPin}
                            onClose={handleTabClose}
                            isSplitActive={isSplitActive}
                            animateEntrance={animateTabs}
                          />
                        );
                      })}
                    </div>
                  ))
                ) : (
                  visibleFiles.map((file) => {
                    const key = fileKey(file.path, file.projectPath);
                    return (
                      <FileTab
                        key={key}
                        tabKey={key}
                        file={file}
                        isActive={key === activePath}
                        onSelect={handleTabSelect}
                        onPin={handleTabPin}
                        onClose={handleTabClose}
                        isSplitActive={isSplitActive}
                        animateEntrance={animateTabs}
                      />
                    );
                  })
                )}
              </div>
            </div>

            {/* Window controls */}
            <div className="flex items-center gap-0.5 px-2">
              {isSplitActive && (
                <ToolbarIconButton
                  onClick={() => {
                    setFilterToActivePane((prev) => !prev);
                    setAnimateTabs(true);
                    if (animateTimerRef.current) clearTimeout(animateTimerRef.current);
                    animateTimerRef.current = setTimeout(() => setAnimateTabs(false), 300);
                  }}
                  icon={<Filter className="h-4 w-4" aria-hidden />}
                  label={filterToActivePane ? 'Show all tabs' : 'Show active pane tabs only'}
                  className={cn(
                    'p-2 rounded transition-colors min-w-[28px] min-h-[28px] flex items-center justify-center',
                    filterToActivePane
                      ? 'bg-primary/20 text-primary hover:bg-primary/30'
                      : 'text-muted-foreground',
                  )}
                  ariaPressed={filterToActivePane}
                />
              )}
              {canShowInlineDiff && (
                <ToolbarIconButton
                  onClick={() => setDiffModePreference((prev) => !prev)}
                  icon={<GitCompare className="h-4 w-4" aria-hidden />}
                  label={isDiffModeActive ? 'Hide inline diff' : 'Show inline diff'}
                  shortcutId="editor-toggle-inline-diff"
                  className={cn(
                    'p-2 rounded transition-colors min-w-[28px] min-h-[28px] flex items-center justify-center',
                    isDiffModeActive
                      ? 'bg-primary/20 text-primary hover:bg-primary/30'
                      : 'text-muted-foreground',
                  )}
                  ariaPressed={isDiffModeActive}
                />
              )}
              {isActiveMarkdownFile && (
                <ToolbarIconButton
                  onClick={toggleMarkdownPreview}
                  icon={<BookOpen className="h-4 w-4" aria-hidden />}
                  label={
                    markdownPreviewVisible
                      ? 'Edit Markdown source (Mermaid diagrams show as code in preview)'
                      : 'Markdown preview'
                  }
                  shortcutId="editor-toggle-markdown-preview"
                  className={cn(
                    'p-2 rounded transition-colors min-w-[28px] min-h-[28px] flex items-center justify-center',
                    markdownPreviewVisible
                      ? 'bg-primary/20 text-primary hover:bg-primary/30'
                      : 'text-muted-foreground',
                  )}
                  ariaPressed={markdownPreviewVisible}
                />
              )}
              {!isImagePath(activeFile?.path ?? '') && !isPdfPath(activeFile?.path ?? '') && (
                <ToolbarIconButton
                  onClick={() => void handleSave()}
                  icon={<Save className="h-4 w-4 text-muted-foreground" />}
                  label="Save"
                  shortcutId="editor-save"
                  disabled={!activeFile || (!activeFile.isDirty && !activeFile.isPreview)}
                  className="p-1 rounded transition-colors disabled:opacity-50 disabled:pointer-events-none"
                />
              )}
              {!isMaximized && (
                <ToolbarIconButton
                  onClick={handleToggleLayout}
                  icon={getLayoutControlIcon(nextLayout)}
                  label={getLayoutControlLabel(nextLayout)}
                  shortcutId="toggle-editor-layout"
                />
              )}
              <ToolbarIconButton
                onClick={handleToggleMaximize}
                icon={
                  isMaximized ? (
                    <Minimize2 className="h-4 w-4 text-muted-foreground" />
                  ) : (
                    <Maximize2 className="h-4 w-4 text-muted-foreground" />
                  )
                }
                label={isMaximized ? 'Restore' : 'Maximize'}
                shortcutId="editor-toggle-maximize"
              />
              <ToolbarIconButton
                onClick={() => {
                  setIsOpen(false);
                  setIsMaximized(false);
                }}
                icon={<X className="h-4 w-4 text-muted-foreground" />}
                label="Close"
                shortcut="Esc"
              />
            </div>
          </div>

          {/* Breadcrumbs: project name + file path */}
          {activeFile && !activeFile.loadError && activeFile.content !== undefined && (
            <nav
              className="relative z-10 flex shrink-0 items-center gap-1 border-b border-border bg-muted/20 px-3 py-1.5 text-xs text-muted-foreground overflow-x-auto scrollbar-thin"
              aria-label="File path"
            >
              {/* Project name prefix (shown when file has project context) */}
              {activeFile.projectPath && (
                <>
                  <span className="flex items-center gap-1 shrink-0">
                    <span
                      className={cn(
                        'font-semibold',
                        isSplitActive && activeFile.sourcePaneIndex !== undefined
                          ? getPaneColor(activeFile.sourcePaneIndex).badgeText
                          : 'text-primary/80',
                      )}
                    >
                      {projectDisplayNames.get(activeFile.projectPath) ??
                        getProjectName(activeFile.projectPath)}
                    </span>
                    {activeFile.isWorktreeContext && <WorktreeBadge />}
                  </span>
                  <ChevronRight className="h-3.5 w-3.5 opacity-60 shrink-0" aria-hidden />
                </>
              )}
              {(() => {
                const segments = activeFile.path.split('/');
                let segmentPath = '';
                return segments.map((segment, i, arr) => {
                  segmentPath = segmentPath ? `${segmentPath}/${segment}` : segment;
                  return (
                    <span key={segmentPath} className="flex items-center gap-1 shrink-0">
                      {i > 0 && <ChevronRight className="h-3.5 w-3.5 opacity-60" aria-hidden />}
                      <span className={i === arr.length - 1 ? 'text-foreground font-medium' : ''}>
                        {segment || '/'}
                      </span>
                    </span>
                  );
                });
              })()}
            </nav>
          )}

          {/* Editor area — min-h-0 lets content scroll instead of growing over the header (isolate = stacking) */}
          <div className="isolate min-h-0 flex-1 overflow-hidden">
            {activeFile ? (
              activeFile.loadError ? (
                <div
                  className="flex flex-col items-center justify-center h-full gap-2 text-muted-foreground px-4 text-center"
                  role="alert"
                  aria-live="assertive"
                  aria-atomic="true"
                >
                  <p>{activeFile.loadErrorMessage ?? 'Could not load file.'}</p>
                  <p className="text-xs truncate max-w-full">{activeFile.path}</p>
                </div>
              ) : isImagePath(activeFile.path) ? (
                activeFile.content !== undefined ? (
                  <div className="flex h-full min-h-0 items-center justify-center overflow-auto p-4">
                    <img
                      src={activeFile.content}
                      alt={activeFile.name}
                      className="max-h-full max-w-full object-contain"
                    />
                  </div>
                ) : (
                  <div className="flex items-center justify-center h-full gap-2 text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    <span>{LOADING_MESSAGE}</span>
                  </div>
                )
              ) : isPdfPath(activeFile.path) ? (
                typeof activeFile.content === 'string' && activeFile.content.startsWith('blob:') ? (
                  <div className="flex h-full min-h-0 items-center justify-center overflow-auto p-4">
                    <iframe
                      src={activeFile.content}
                      title={activeFile.name}
                      className="w-full h-full min-h-0 border-0 rounded"
                    />
                  </div>
                ) : activeFile.content !== undefined ? (
                  <div
                    className="flex flex-col items-center justify-center h-full gap-2 text-muted-foreground px-4 text-center"
                    role="alert"
                    aria-live="assertive"
                    aria-atomic="true"
                  >
                    <p>Blocked non-blob PDF URL.</p>
                    <p className="text-xs truncate max-w-full">{activeFile.path}</p>
                  </div>
                ) : (
                  <div className="flex items-center justify-center h-full gap-2 text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    <span>{LOADING_MESSAGE}</span>
                  </div>
                )
              ) : activeFile.content !== undefined ? (
                markdownPreviewVisible && isMarkdownPath(activeFile.path) ? (
                  activeFile.content.length > MARKDOWN_PREVIEW_MAX_CHARS ? (
                    <div className="flex h-full min-h-0 items-center justify-center p-4 text-sm text-muted-foreground text-center">
                      Preview paused — file exceeds {MARKDOWN_PREVIEW_MAX_CHARS.toLocaleString()}{' '}
                      characters for live preview.
                    </div>
                  ) : (
                    <article
                      ref={markdownPreviewSurfaceRef}
                      tabIndex={-1}
                      className="h-full min-h-0 overflow-y-auto px-4 py-3 outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                      aria-label="Markdown preview"
                    >
                      <MemoizedMarkdown
                        content={debouncedMarkdownPreview}
                        id={activeFile.path}
                        size="md"
                        className="text-sm"
                      />
                    </article>
                  )
                ) : (
                  <Editor
                    height="100%"
                    path={activeFileModelPath}
                    keepCurrentModel
                    language={activeFile.language}
                    value={activeFile.content}
                    onChange={handleEditorChange}
                    beforeMount={(monaco) => {
                      monacoRef.current = monaco;
                      // CRITICAL: Disable built-in diagnostics BEFORE Monaco processes files
                      // This must happen in beforeMount, not in useEffect
                      disableBuiltinTsDiagnostics(monaco);
                      configureMonacoForNodeScripts(monaco);
                      // Initialize TypeScript ATA (Automatic Type Acquisition)
                      // Uses official @typescript/ata to fetch types from jsdelivr
                      // Runs async in background - dependencies are lazy-loaded
                      void initializeATA(monaco);
                      // Route cross-file navigation (Ctrl+Click) through our tab system
                      editorOpenerDisposableRef.current?.dispose();
                      editorOpenerDisposableRef.current = monaco.editor.registerEditorOpener({
                        openCodeEditor(
                          source: Monaco.editor.ICodeEditor,
                          resource: Monaco.Uri,
                          selectionOrPosition?: Monaco.IRange | Monaco.IPosition,
                        ) {
                          const targetPath = decodeURIComponent(resource.path);
                          const sourceUri = source?.getModel()?.uri?.toString() ?? 'none';
                          if (!targetPath) return false;
                          if (resource.toString() === sourceUri) return false;
                          const currentProjectPath = projectPathRef.current;
                          const relativePath =
                            currentProjectPath && targetPath.startsWith(`${currentProjectPath}/`)
                              ? targetPath.slice(currentProjectPath.length + 1)
                              : targetPath;
                          const fileName = relativePath.split('/').pop() ?? relativePath;
                          appStore.set(openFileAtom, {
                            path: relativePath,
                            name: fileName,
                            projectPath: currentProjectPath,
                            intent: 'preview',
                          });
                          const lineNumber =
                            selectionOrPosition && 'lineNumber' in selectionOrPosition
                              ? selectionOrPosition.lineNumber
                              : selectionOrPosition && 'startLineNumber' in selectionOrPosition
                                ? (selectionOrPosition as { startLineNumber: number })
                                    .startLineNumber
                                : undefined;
                          if (lineNumber !== undefined) {
                            requestAnimationFrame(() => {
                              window.dispatchEvent(
                                new CustomEvent('editor:reveal-line', {
                                  detail: { filePath: targetPath, lineNumber },
                                }),
                              );
                            });
                          }
                          return true;
                        },
                      });
                    }}
                    onMount={(editor, _monaco) => {
                      editorRef.current = editor;
                      editor.updateOptions(getMonacoNavigationOptions());
                      // Signal that Monaco is ready so project types can be loaded
                      setIsMonacoReady(true);
                      // Acquire types for the initial content
                      const content = editor.getValue();
                      if (content) {
                        acquireTypes(content);
                      }
                      // Apply any pending reveal that was queued before Monaco mounted
                      const pending = pendingRevealRef.current;
                      if (pending) {
                        const model = editor.getModel();
                        if (model) {
                          revealLineInEditor(pending);
                          pendingRevealRef.current = null;
                        }
                      }
                    }}
                    theme={monacoTheme}
                    options={{
                      readOnly: false,
                      minimap: { enabled: false },
                      glyphMargin: true,
                      fontSize: 14,
                      fontFamily: "Menlo, Monaco, 'Courier New', monospace",
                      lineNumbers: 'on',
                      scrollBeyondLastLine: false,
                      wordWrap: 'on',
                      automaticLayout: true,
                      ...getMonacoNavigationOptions(),
                      padding: { top: 8, bottom: 8 },
                      renderLineHighlight: 'line',
                      cursorBlinking: 'smooth',
                    }}
                  />
                )
              ) : (
                <div className="flex items-center justify-center h-full text-muted-foreground">
                  {LOADING_MESSAGE}
                </div>
              )
            ) : (
              <div className="flex items-center justify-center h-full text-muted-foreground">
                Select a file to view
              </div>
            )}
          </div>

          {/* File path status bar */}
          {activeFile && (
            <div className="flex shrink-0 items-center gap-2 min-w-0 border-t border-border bg-muted/30 px-3 py-1 text-xs text-muted-foreground">
              <span className="min-w-0 flex-1 truncate">
                {isSplitActive && activeFile.projectPath && (
                  <span className="font-medium text-foreground/70">
                    {projectDisplayNames.get(activeFile.projectPath) ??
                      getProjectName(activeFile.projectPath)}
                    {' · '}
                  </span>
                )}
                {activeFile.path}
              </span>
              <div className="flex items-center gap-2 shrink-0 ml-auto">
                <span>
                  {isPdfPath(activeFile.path)
                    ? 'pdf'
                    : isImagePath(activeFile.path)
                      ? 'image'
                      : activeFile.language}
                </span>
                {(isTextEditorFile &&
                  shouldLoadWorkingLineChanges &&
                  shouldShowWorkingLineChangeStatus) ||
                isDiffModeActive ||
                (markdownPreviewVisible && isActiveMarkdownFile) ? (
                  <span className="text-muted-foreground/50 select-none" aria-hidden>
                    ·
                  </span>
                ) : null}
                {isTextEditorFile &&
                  shouldLoadWorkingLineChanges &&
                  shouldShowWorkingLineChangeStatus && (
                    <span className="font-medium text-foreground/80">
                      {workingLineChanges?.unsupported
                        ? 'diff: unsupported'
                        : `diff: ${workingLineChangeCount}`}
                    </span>
                  )}
                {isDiffModeActive && (
                  <span className="font-medium text-primary/80">inline diff</span>
                )}
                {markdownPreviewVisible && isActiveMarkdownFile && (
                  <span className="font-medium text-primary/80">markdown preview</span>
                )}
              </div>
            </div>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
