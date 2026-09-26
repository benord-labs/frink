import { useCallback, useRef, useState } from 'react';
import { trpc } from '../../../lib/trpc';

export type PastedTextFile = {
  id: string;
  filePath: string;
  filename: string;
  size: number;
  preview: string;
  createdAt: Date;
};

type UsePastedTextFilesReturn = {
  pastedTexts: PastedTextFile[];
  addPastedText: (text: string) => Promise<void>;
  removePastedText: (id: string) => void;
  clearPastedTexts: () => void;
  setPastedTextsFromDraft: (drafts: PastedTextFile[]) => void;
  pastedTextsRef: React.RefObject<PastedTextFile[]>;
};

export function usePastedTextFiles(subChatId: string): UsePastedTextFilesReturn {
  const [pastedTexts, setPastedTexts] = useState<PastedTextFile[]>([]);
  const pastedTextsRef = useRef<PastedTextFile[]>([]);

  // Keep ref in sync with state
  pastedTextsRef.current = pastedTexts;

  const writePastedTextMutation = trpc.files.writePastedText.useMutation();

  const addPastedText = useCallback(
    async (text: string) => {
      try {
        const result = await writePastedTextMutation.mutateAsync({
          subChatId,
          text,
        });

        // Create preview from first 50 chars, replace newlines with spaces
        const preview = text.slice(0, 50).replace(/\n/g, ' ');
        const newPasted: PastedTextFile = {
          id: `pasted_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
          filePath: result.filePath,
          filename: result.filename,
          size: result.size,
          preview: preview.length < text.length ? `${preview}...` : preview,
          createdAt: new Date(),
        };

        setPastedTexts((prev) => [...prev, newPasted]);
      } catch (_error) {
        // Ignore write failures here - message send still works without pasted-file mentions.
      }
    },
    [subChatId, writePastedTextMutation],
  );

  const removePastedText = useCallback((id: string) => {
    setPastedTexts((prev) => prev.filter((p) => p.id !== id));
  }, []);

  const clearPastedTexts = useCallback(() => {
    setPastedTexts([]);
  }, []);

  const setPastedTextsFromDraft = useCallback((drafts: PastedTextFile[]) => {
    setPastedTexts(drafts);
  }, []);

  return {
    pastedTexts,
    addPastedText,
    removePastedText,
    clearPastedTexts,
    setPastedTextsFromDraft,
    pastedTextsRef,
  };
}
