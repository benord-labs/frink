import { fileKey, type OpenFile } from '@/lib/code-editor/state';

/**
 * The tab the editor shows while the tab bar shows `visibleFiles`, only the active pane's tabs when
 * `isFiltered`: the active tab while the bar shows it, else the pane's last tab (`paneLastTab`)
 * while the bar shows that, else the bar's first tab, else none. So the editor never shows a tab
 * the filtered bar hides, and shows one again once the filter is off.
 */
export function activeTabInFilter(
  visibleFiles: OpenFile[],
  activePath: string | null,
  isFiltered: boolean,
  paneLastTab?: string,
): string | null {
  const keys = visibleFiles.map((f) => fileKey(f.path, f.projectPath));
  if (activePath && (!isFiltered || keys.includes(activePath))) return activePath;
  if (paneLastTab && keys.includes(paneLastTab)) return paneLastTab;
  return keys[0] ?? null;
}
