import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { getCodeViewFilePath } from '@/lib/utils/diff-file-path';

// Discriminated union for selection source
export type TextSelectionSource =
  | { type: 'assistant-message'; messageId: string }
  | { type: 'diff'; filePath: string; lineNumber?: number; lineType?: 'old' | 'new' }
  | { type: 'tool-edit'; filePath: string; isWrite: boolean }
  | { type: 'plan'; planPath: string };

type TextSelectionState = {
  selectedText: string | null;
  source: TextSelectionSource | null;
  selectionRect: DOMRect | null;
};

type TextSelectionContextValue = TextSelectionState & {
  clearSelection: () => void;
  // Legacy getters for backwards compatibility
  selectedMessageId: string | null;
};

const TextSelectionContext = createContext<TextSelectionContextValue | null>(null);

export function useTextSelection(): TextSelectionContextValue {
  const ctx = useContext(TextSelectionContext);
  if (!ctx) {
    throw new Error('useTextSelection must be used within TextSelectionProvider');
  }
  return ctx;
}

// Regex pattern to match numeric line numbers
const LINE_NUMBER_REGEX = /^\d+$/;

/** Exact float equality: subpixel jitter yields a new selection update (popover tracks the rect). */
export function rectsSemanticallyEqual(a: DOMRect | null, b: DOMRect | null): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

export function sourcesSemanticallyEqual(
  a: TextSelectionSource | null,
  b: TextSelectionSource | null,
): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  if (a.type !== b.type) return false;
  switch (a.type) {
    case 'assistant-message':
      return b.type === 'assistant-message' && a.messageId === b.messageId;
    case 'diff':
      return (
        b.type === 'diff' &&
        a.filePath === b.filePath &&
        a.lineNumber === b.lineNumber &&
        a.lineType === b.lineType
      );
    case 'tool-edit':
      return b.type === 'tool-edit' && a.filePath === b.filePath && a.isWrite === b.isWrite;
    case 'plan':
      return b.type === 'plan' && a.planPath === b.planPath;
    default:
      return false;
  }
}

export function selectionStateSemanticallyEqual(
  a: TextSelectionState,
  b: TextSelectionState,
): boolean {
  if (a.selectedText !== b.selectedText) return false;
  if (!sourcesSemanticallyEqual(a.source, b.source)) return false;
  return rectsSemanticallyEqual(a.selectionRect, b.selectionRect);
}

type TextSelectionProviderProps = {
  children: ReactNode;
};

function getDiffShadowRoots(): ShadowRoot[] {
  const roots: ShadowRoot[] = [];
  document.querySelectorAll('diffs-container').forEach((el) => {
    const sr = (el as HTMLElement).shadowRoot;
    if (sr) roots.push(sr);
  });
  return roots;
}

/**
 * Convert a StaticRange to a live Range (needed for toString() and getBoundingClientRect()).
 * StaticRange from getComposedRanges doesn't have these methods.
 */
function toLiveRange(staticRange: StaticRange): Range | null {
  try {
    const range = document.createRange();
    range.setStart(staticRange.startContainer, staticRange.startOffset);
    range.setEnd(staticRange.endContainer, staticRange.endOffset);
    return range;
  } catch {
    return null;
  }
}

/**
 * Get the selection range that works across Shadow DOM boundaries.
 * Uses getComposedRanges (Chromium 137+) to resolve nodes inside shadow trees.
 * Falls back to getRangeAt(0) for non-shadow selections.
 *
 * Returns the resolved range, the element at the start, and the extracted text.
 * We extract text here because selection.toString() may be empty/incorrect
 * for selections inside Shadow DOM.
 */
function getSelectionRange(
  selection: Selection,
): { range: Range; element: Element | null; text: string } | null {
  if (typeof selection.getComposedRanges === 'function') {
    const shadowRoots = getDiffShadowRoots();
    try {
      const ranges = selection.getComposedRanges({ shadowRoots });
      const firstRange = ranges[0];
      if (firstRange) {
        const staticRange = firstRange;
        if (
          staticRange.startContainer === staticRange.endContainer &&
          staticRange.startOffset === staticRange.endOffset
        ) {
          return null;
        }
        const liveRange = toLiveRange(staticRange);
        if (!liveRange) return null;

        const container = staticRange.startContainer;
        const element =
          container.nodeType === Node.TEXT_NODE ? container.parentElement : (container as Element);
        const text = liveRange.toString();
        return { range: liveRange, element, text };
      }
    } catch {
      // Fall through to legacy path
    }
  }

  if (selection.rangeCount === 0 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  const container = range.commonAncestorContainer;
  const element =
    container.nodeType === Node.TEXT_NODE ? container.parentElement : (container as Element);
  const text = selection.toString();
  return { range, element, text };
}

// Helper to extract line number from diff selection
export function extractDiffLineInfo(element: Element): {
  lineNumber?: number;
  lineType?: 'old' | 'new';
} {
  const row = element.closest('tr, [data-diff-line], [data-line-type]');
  if (!row) return {};

  let lineNumber: number | undefined;
  let lineType: 'old' | 'new' | undefined;

  const explicitNew = row.getAttribute('data-line-new') ?? row.getAttribute('data-line-num-new');
  const explicitOld = row.getAttribute('data-line-old') ?? row.getAttribute('data-line-num-old');

  if (explicitNew && LINE_NUMBER_REGEX.test(explicitNew)) {
    lineNumber = parseInt(explicitNew, 10);
    lineType = 'new';
  } else if (explicitOld && LINE_NUMBER_REGEX.test(explicitOld)) {
    lineNumber = parseInt(explicitOld, 10);
    lineType = 'old';
  }

  if (!lineNumber) {
    const candidates = row.querySelectorAll(
      '[data-line-new], [data-line-old], [data-line-num-new], [data-line-num-old], .diff-line-num, .diff-line-old-num, .diff-line-new-num, [data-line-number], [class*="line-number"], [class*="lineNumber"]',
    );

    for (let i = 0; i < candidates.length; i++) {
      const cell = candidates[i];
      const attrs = [
        cell.getAttribute('data-line-new'),
        cell.getAttribute('data-line-old'),
        cell.getAttribute('data-line-num-new'),
        cell.getAttribute('data-line-num-old'),
        cell.getAttribute('data-line-number'),
      ].filter(Boolean) as string[];

      const attrNumber = attrs.find((v) => LINE_NUMBER_REGEX.test(v));
      const textNumber = cell.textContent?.trim();
      const raw =
        attrNumber ?? (textNumber && LINE_NUMBER_REGEX.test(textNumber) ? textNumber : null);

      if (raw) {
        lineNumber = parseInt(raw, 10);
        if (
          cell.classList.contains('diff-line-old-num') ||
          cell.classList.contains('line-old-num') ||
          cell.classList.contains('lineOldNum') ||
          cell.getAttribute('data-line-old') !== null ||
          cell.getAttribute('data-line-num-old') !== null
        ) {
          lineType = 'old';
        } else {
          lineType = 'new';
        }
        break;
      }
    }
  }

  // Fallback for table-based diff renderers that expose only plain numeric cells.
  if (!lineNumber && row.tagName === 'TR') {
    const rowCells = Array.from((row as HTMLTableRowElement).cells);
    const numericCells = rowCells
      .map((cell) => ({
        cell,
        value: cell.textContent?.trim() ?? '',
      }))
      .filter((entry) => LINE_NUMBER_REGEX.test(entry.value));

    if (numericCells.length > 0) {
      const oldCandidate = numericCells[0];
      const newCandidate = numericCells[1] ?? numericCells[0];
      const selectedCell = element.closest('td');
      const prefersOld = selectedCell ? selectedCell === oldCandidate.cell : false;
      const chosen = prefersOld ? oldCandidate : newCandidate;
      lineNumber = parseInt(chosen.value, 10);
      lineType = prefersOld ? 'old' : 'new';
    }
  }

  return { lineNumber, lineType };
}

export function TextSelectionProvider({ children }: TextSelectionProviderProps) {
  const [state, setState] = useState<TextSelectionState>({
    selectedText: null,
    source: null,
    selectionRect: null,
  });

  const setSelectionState = useCallback((next: TextSelectionState) => {
    setState((prev) => (selectionStateSemanticallyEqual(prev, next) ? prev : next));
  }, []);

  const clearSelection = useCallback(() => {
    window.getSelection()?.removeAllRanges();
    setSelectionState({
      selectedText: null,
      source: null,
      selectionRect: null,
    });
  }, [setSelectionState]);

  useEffect(() => {
    let rafId: number | null = null;

    const handleSelectionChange = () => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
      }

      rafId = requestAnimationFrame(() => {
        rafId = null;

        const selection = window.getSelection();
        if (!selection) {
          setSelectionState({ selectedText: null, source: null, selectionRect: null });
          return;
        }

        const result = getSelectionRange(selection);
        if (!result) {
          setSelectionState({ selectedText: null, source: null, selectionRect: null });
          return;
        }

        const { range, element, text: rawText } = result;
        const text = rawText.trim();
        if (!text) {
          setSelectionState({ selectedText: null, source: null, selectionRect: null });
          return;
        }

        let source: TextSelectionSource | null = null;

        if (element) {
          const planElement = element.closest?.('[data-plan-path]') as HTMLElement | null;

          const toolEditElement = element.closest?.(
            '[data-part-type="tool-Edit"], [data-part-type="tool-Write"]',
          ) as HTMLElement | null;

          const messageElement = element.closest?.(
            '[data-assistant-message-id]',
          ) as HTMLElement | null;

          // A diff line lives inside its file's CodeView shadow root
          const diffRoot = element.getRootNode();
          const diffFilePath =
            diffRoot instanceof ShadowRoot ? getCodeViewFilePath(diffRoot) : null;

          // Priority: plan > tool-edit > diff > assistant-message
          if (planElement) {
            const planPath = planElement.getAttribute('data-plan-path') || 'unknown';
            source = { type: 'plan', planPath };
          }

          if (!source && toolEditElement) {
            const partType = toolEditElement.getAttribute('data-part-type');
            const isWrite = partType === 'tool-Write';
            const filePath = toolEditElement.getAttribute('data-tool-file-path') || 'unknown';
            source = { type: 'tool-edit', filePath, isWrite };
          }

          if (!source && diffFilePath) {
            const lineInfo = extractDiffLineInfo(element);
            source = {
              type: 'diff',
              filePath: diffFilePath,
              lineNumber: lineInfo.lineNumber,
              lineType: lineInfo.lineType,
            };
          }

          if (!source && messageElement) {
            const messageId = messageElement.getAttribute('data-assistant-message-id');
            if (messageId) {
              source = { type: 'assistant-message', messageId };
            }
          }
        }

        if (!source) {
          setSelectionState({ selectedText: null, source: null, selectionRect: null });
          return;
        }

        const rect = range.getBoundingClientRect();
        setSelectionState({ selectedText: text, source, selectionRect: rect });
      });
    };

    document.addEventListener('selectionchange', handleSelectionChange);

    return () => {
      document.removeEventListener('selectionchange', handleSelectionChange);
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
      }
    };
  }, [setSelectionState]);

  // Compute legacy selectedMessageId for backwards compatibility
  const selectedMessageId =
    state.source?.type === 'assistant-message' ? state.source.messageId : null;

  // Memoize context value to prevent unnecessary re-renders of consumers
  const contextValue = useMemo<TextSelectionContextValue>(
    () => ({
      ...state,
      clearSelection,
      selectedMessageId,
    }),
    [state, clearSelection, selectedMessageId],
  );

  return (
    <TextSelectionContext.Provider value={contextValue}>{children}</TextSelectionContext.Provider>
  );
}
