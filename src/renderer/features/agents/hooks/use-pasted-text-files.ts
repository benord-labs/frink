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

/** A chip restored from a draft or a queued item; the queue does not keep `createdAt`. */
type RestorablePastedText = Omit<PastedTextFile, 'createdAt'> & { createdAt?: Date };

type UsePastedTextFilesReturn = {
  pastedTexts: PastedTextFile[];
  addPastedText: (text: string) => Promise<void>;
  removePastedText: (id: string) => void;
  clearPastedTexts: () => void;
  setPastedTextsFromDraft: (drafts: RestorablePastedText[]) => void;
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
      } catch (error) {
        // Rethrown so the paste handler can fall back to inline text: the default paste was
        // cancelled, so swallowing this dropped the pasted text entirely (sc-3666).
        throw error instanceof Error ? error : new Error('Failed to save pasted text');
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

  const setPastedTextsFromDraft = useCallback((drafts: RestorablePastedText[]) => {
    setPastedTexts(drafts.map((d) => ({ ...d, createdAt: d.createdAt ?? new Date() })));
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
