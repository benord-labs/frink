import type { RevealLineDetail } from '@/lib/code-editor/state';

export function dispatchEditorRevealLine(
  filePath: string,
  lineNumber: number,
  startColumn?: number,
  endColumn?: number,
): void {
  window.dispatchEvent(
    new CustomEvent<RevealLineDetail>('editor:reveal-line', {
      detail: { filePath, lineNumber, startColumn, endColumn },
    }),
  );
}
