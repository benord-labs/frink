import type { RefObject } from 'react';
import { dispatchEditorRevealLine } from '../../layout/editor-reveal-line';
import type { FilesSidebarTab } from '../atoms';

export function activateSearchTabAndFocus(
  setActiveTab: (tab: FilesSidebarTab) => void,
  inputRef: RefObject<HTMLInputElement | null>,
): void {
  setActiveTab('search');
  requestAnimationFrame(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  });
}

export function openContentSearchMatchInEditor(
  projectPath: string,
  relativePath: string,
  lineNumber: number,
  startColumn: number,
  endColumn: number,
  onOpenAbsoluteFile: (absolutePath: string) => void,
): void {
  const absoluteFilePath = `${projectPath}/${relativePath}`;
  onOpenAbsoluteFile(absoluteFilePath);
  requestAnimationFrame(() => {
    dispatchEditorRevealLine(absoluteFilePath, lineNumber, startColumn, endColumn);
  });
}

export function shouldHandlePaneSearchActivation(
  detail: { paneIndex?: number } | undefined,
  paneIndex: number | undefined,
): boolean {
  return detail?.paneIndex === paneIndex;
}
