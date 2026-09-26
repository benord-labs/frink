import { useCallback } from 'react';
import type { TextSelectionSource } from '../../../context/text-selection-context';

type UseTextContextWrapperParams = {
  addTextContextOriginal: (text: string, messageId: string) => void;
  addDiffTextContext: (
    text: string,
    filePath: string,
    lineNumber?: number,
    lineType?: 'old' | 'new',
  ) => void;
};

/**
 * Hook to wrap text context addition with source type handling
 * Handles different types of text selection sources (assistant messages, diffs, tool edits, plans)
 */
export const useTextContextWrapper = ({
  addTextContextOriginal,
  addDiffTextContext,
}: UseTextContextWrapperParams) => {
  // Wrapper for addTextContext that handles TextSelectionSource
  const addTextContext = useCallback(
    (text: string, source: TextSelectionSource) => {
      if (source.type === 'assistant-message') {
        addTextContextOriginal(text, source.messageId);
      } else if (source.type === 'diff') {
        addDiffTextContext(text, source.filePath, source.lineNumber, source.lineType);
      } else if (source.type === 'tool-edit') {
        // Tool edit selections are treated as code selections (similar to diff)
        addDiffTextContext(text, source.filePath);
      } else if (source.type === 'plan') {
        // Plan selections are treated as code selections (similar to diff)
        addDiffTextContext(text, source.planPath);
      }
    },
    [addTextContextOriginal, addDiffTextContext],
  );

  return { addTextContext };
};
