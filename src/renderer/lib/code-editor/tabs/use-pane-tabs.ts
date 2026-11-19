import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { useEffect, useMemo, useRef } from 'react';
import {
  activeFileAtom,
  activeFilePathAtom,
  editorActivePaneIndexAtom,
  editorIsSplitActiveAtom,
  fileKey,
  filterTabsToActivePaneAtom,
  lastActiveTabPerPaneAtom,
  type OpenFile,
  openFilesAtom,
  trackPaneTabAtom,
} from '@/lib/code-editor/state';
import { activeTabInFilter } from './active-tab-in-filter';

/**
 * The tabs the tab bar shows: every open tab, or in split view with "Show active pane tabs only"
 * on, the active pane's. Keeps the editor on one of them: each pane remembers its last tab and gets
 * it back when it becomes active, and a filtered pane with no tabs shows none.
 */
export function usePaneTabs(): OpenFile[] {
  const files = useAtomValue(openFilesAtom);
  const [activePath, setActivePath] = useAtom(activeFilePathAtom);
  const activeTabPane = useAtomValue(activeFileAtom)?.sourcePaneIndex;
  const isSplitActive = useAtomValue(editorIsSplitActiveAtom);
  const paneIndex = useAtomValue(editorActivePaneIndexAtom);
  const filterToActivePane = useAtomValue(filterTabsToActivePaneAtom);
  const lastTabPerPane = useAtomValue(lastActiveTabPerPaneAtom);
  const trackPaneTab = useSetAtom(trackPaneTabAtom);
  const isFiltered = isSplitActive && filterToActivePane && paneIndex !== null;

  const visibleFiles = useMemo(
    () => (isFiltered ? files.filter((f) => f.sourcePaneIndex === paneIndex) : files),
    [files, isFiltered, paneIndex],
  );

  useEffect(() => {
    if (activePath && activeTabPane !== undefined) {
      trackPaneTab({ paneIndex: activeTabPane, key: activePath });
    }
  }, [activePath, activeTabPane, trackPaneTab]);

  // One pass, so a stale active tab can't override the pane's own: a newly active pane gets its
  // last tab back, then the bar decides whether the editor may show it.
  const prevPaneIndexRef = useRef(paneIndex);
  useEffect(() => {
    const isNewPane = isSplitActive && paneIndex !== null && paneIndex !== prevPaneIndexRef.current;
    prevPaneIndexRef.current = paneIndex;
    const lastTab = paneIndex === null ? undefined : lastTabPerPane[paneIndex];
    const lastTabIsOpen = files.some((f) => fileKey(f.path, f.projectPath) === lastTab);
    const current = isNewPane && lastTab && lastTabIsOpen ? lastTab : activePath;
    const shown = activeTabInFilter(visibleFiles, current, isFiltered, lastTab);
    if (shown !== activePath) setActivePath(shown);
  }, [
    activePath,
    files,
    isFiltered,
    isSplitActive,
    lastTabPerPane,
    paneIndex,
    setActivePath,
    visibleFiles,
  ]);

  return visibleFiles;
}
