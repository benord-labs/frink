import { Button } from '@benord-labs/frink-primitives';
import type { CodeViewItem } from '@pierre/diffs';
import { CodeView, type CodeViewHandle } from '@pierre/diffs/react';
import { useAtomValue, useSetAtom } from 'jotai';
import { ChevronDown, ChevronRight, Clipboard, FilePenLine, Folder } from 'lucide-react';
import { type MouseEvent, useCallback, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { diffPanelLayoutAtom } from '@/lib/atoms';
import { useFocusedDiffFile } from '@/lib/hooks/diff-panel/use-focused-diff-file';
import { useCodeTheme, useIsLightCode } from '@/lib/hooks/use-code-theme';
import { trpcClient } from '@/lib/trpc';
import { type RenderableDiffFile, toCodeViewItems } from '@/lib/utils/diff/diff-code-view-items';
import { getCodeViewFilePathFromEvent } from '@/lib/utils/diff-file-path';
import { getRevealLabel } from '@/lib/utils/platform';
import { buildOpenWorktreeFileInput } from '@/lib/worktree/open-worktree-file-in-editor';
import { openFileAtom } from '../../code-editor';

const HEADER_HEIGHT = 32;

// Matches the chat's Edit card: faint green/red rows with an edge bar and 12px code. Code stays
// solid in the panel's tone (transparency-glass-surfaces); sticky headers blur the code under them.
const DIFF_VIEW_CSS = `
  :host {
    --diffs-bg: hsl(var(--card));
    background-color: var(--diffs-bg);
    --diffs-bg-separator-override: hsl(var(--muted) / 0.3);
    --diffs-font-family: var(--font-mono, ui-monospace, monospace);
    --diffs-font-size: 12px;
    --diffs-addition-base: rgb(34 197 94);
    --diffs-deletion-base: rgb(239 68 68);
    --diffs-bg-addition-override: rgb(34 197 94 / 0.75);
    --diffs-bg-deletion-override: rgb(239 68 68 / 0.75);
    --diffs-fg-number-override: hsl(var(--muted-foreground) / 0.6);
    --diffs-fg-number-addition-override: hsl(var(--muted-foreground) / 0.6);
    --diffs-fg-number-deletion-override: hsl(var(--muted-foreground) / 0.6);
  }
  [data-diffs-header] {
    min-height: ${HEADER_HEIGHT}px;
    padding-inline: 4px 12px;
    font-family: inherit;
    font-size: 12px;
    background: hsl(var(--card) / var(--glass-opacity));
    backdrop-filter: var(--glass-filter);
    border-block: 0.5px solid hsl(var(--border));
    color: hsl(var(--muted-foreground));
  }
  [data-change-icon] { display: none; }
  [data-title] {
    color: hsl(var(--foreground));
    direction: rtl;
    text-align: left;
    cursor: pointer;
    text-underline-offset: 2px;
  }
  [data-title]:hover { text-decoration: underline; }
  [data-metadata] { display: flex; gap: 6px; }
  [data-additions-count] { order: -1; color: light-dark(rgb(22 163 74), rgb(74 222 128)); }
  [data-deletions-count] { color: light-dark(rgb(220 38 38), rgb(248 113 113)); }
`;

function CollapseToggle({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  return (
    <Button
      variant="ghost"
      size="xs"
      iconOnly
      aria-expanded={!collapsed}
      aria-label={collapsed ? 'Expand file' : 'Collapse file'}
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
    >
      {collapsed ? <ChevronRight className="size-3.5" /> : <ChevronDown className="size-3.5" />}
    </Button>
  );
}

type DiffFileListProps = {
  chatId: string;
  worktreePath: string;
  files: readonly RenderableDiffFile[];
  collapsedKeys: ReadonlySet<string>;
  onToggleCollapsed: (key: string) => void;
  onExpand: (key: string) => void;
};

export function DiffFileList({
  chatId,
  worktreePath,
  files,
  collapsedKeys,
  onToggleCollapsed,
  onExpand,
}: DiffFileListProps) {
  const viewerRef = useRef<CodeViewHandle<undefined>>(null);
  const layout = useAtomValue(diffPanelLayoutAtom);
  const [menuPath, setMenuPath] = useState<string | null>(null);
  const openFile = useSetAtom(openFileAtom);
  const codeThemeId = useCodeTheme();
  const isLight = useIsLightCode();

  const items = useMemo(() => toCodeViewItems(files, collapsedKeys), [files, collapsedKeys]);
  // CodeView re-renders every visible file when these change identity; keep them stable
  const renderHeaderPrefix = useCallback(
    (item: CodeViewItem) => (
      <CollapseToggle
        collapsed={collapsedKeys.has(item.id)}
        onToggle={() => onToggleCollapsed(item.id)}
      />
    ),
    [collapsedKeys, onToggleCollapsed],
  );
  const options = useMemo(
    () => ({
      diffStyle: layout,
      diffIndicators: 'bars' as const,
      itemMetrics: { diffHeaderHeight: HEADER_HEIGHT },
      overflow: 'scroll' as const,
      stickyHeaders: true,
      themeType: isLight ? ('light' as const) : ('dark' as const),
      theme: codeThemeId,
      unsafeCSS: DIFF_VIEW_CSS,
    }),
    [layout, isLight, codeThemeId],
  );

  const scrollToFile = useCallback(
    (key: string) => viewerRef.current?.scrollTo({ type: 'item', id: key, align: 'start' }),
    [],
  );
  useFocusedDiffFile(chatId, files, onExpand, scrollToFile);

  const openInEditor = (filePath: string) => {
    const input = buildOpenWorktreeFileInput({ filePath, worktreePath, chatId });
    if (input) openFile(input);
  };

  const copy = async (text: string) => {
    await navigator.clipboard.writeText(text);
    toast.success('Copied to clipboard', { description: text });
  };

  // A click on a file's title opens it; the rest of the header is left to the viewer.
  const handleClickCapture = (event: MouseEvent) => {
    const onTitle = event.nativeEvent
      .composedPath()
      .some((node) => node instanceof HTMLElement && node.hasAttribute('data-title'));
    const filePath = onTitle ? getCodeViewFilePathFromEvent(event.nativeEvent) : null;
    if (filePath) openInEditor(filePath);
  };

  // Right-clicking outside any file opens no menu at all.
  const handleContextMenu = (event: MouseEvent) => {
    const filePath = getCodeViewFilePathFromEvent(event.nativeEvent);
    if (!filePath) {
      event.preventDefault();
      return;
    }
    setMenuPath(filePath);
  };

  const absoluteMenuPath = menuPath ? `${worktreePath}/${menuPath}` : null;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        {/* biome-ignore lint/a11y/noStaticElementInteractions: forwards clicks from the viewer's shadow DOM */}
        <div
          className="min-h-0 flex-1"
          onClickCapture={handleClickCapture}
          onContextMenu={handleContextMenu}
        >
          <CodeView
            ref={viewerRef}
            className="h-full overflow-auto"
            items={items}
            renderHeaderPrefix={renderHeaderPrefix}
            options={options}
          />
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-56">
        {menuPath && absoluteMenuPath && (
          <>
            <ContextMenuItem onClick={() => openInEditor(menuPath)} className="text-xs">
              <FilePenLine className="mr-2 size-3.5" />
              Open in Editor
            </ContextMenuItem>
            <ContextMenuItem
              onClick={() => trpcClient.external.openInFinder.mutate(absoluteMenuPath)}
              className="text-xs"
            >
              <Folder className="mr-2 size-3.5" />
              {getRevealLabel()}
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={() => copy(menuPath)} className="text-xs">
              <Clipboard className="mr-2 size-3.5" />
              Copy Relative Path
            </ContextMenuItem>
            <ContextMenuItem onClick={() => copy(absoluteMenuPath)} className="text-xs">
              <Clipboard className="mr-2 size-3.5" />
              Copy Path
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}
