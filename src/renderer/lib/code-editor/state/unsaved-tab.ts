import type { OpenFile } from './atoms';

/**
 * An unsaved tab an automatic close keeps. It counts as another project's file from then on, so a
 * chat names it by full path, and it loses its pane colour.
 */
export function keepUnsavedTab({ sourcePaneIndex: _, ...file }: OpenFile): OpenFile {
  return { ...file, isOtherProject: true };
}

export function tabsChanged(before: OpenFile[], after: OpenFile[]): boolean {
  return before.length !== after.length || after.some((f, i) => f !== before[i]);
}
