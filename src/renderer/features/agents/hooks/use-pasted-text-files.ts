import { useCallback, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  PASTED_FILE_MAX_BYTES,
  PASTED_FILE_TOO_LARGE,
} from '../../../../shared/pasted-file-limits';
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

/** `label` names the chip instead of the text's opening words; `kind` prefixes the saved file. */
export type PastedTextOptions = { label?: string; kind?: 'terminal' };

type UsePastedTextFilesReturn = {
  pastedTexts: PastedTextFile[];
  addPastedText: (text: string, options?: PastedTextOptions) => Promise<void>;
  addPastedFiles: (files: File[]) => Promise<void>;
  removePastedText: (id: string) => void;
  clearPastedTexts: () => void;
  setPastedTextsFromDraft: (drafts: RestorablePastedText[]) => void;
  pastedTextsRef: React.RefObject<PastedTextFile[]>;
};

const newChipId = () => `pasted_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

export function usePastedTextFiles(subChatId: string): UsePastedTextFilesReturn {
  const [pastedTexts, setPastedTexts] = useState<PastedTextFile[]>([]);
  const pastedTextsRef = useRef<PastedTextFile[]>([]);

  // Keep ref in sync with state
  pastedTextsRef.current = pastedTexts;

  const writePastedTextMutation = trpc.files.writePastedText.useMutation();

  const addPastedText = useCallback(
    async (text: string, options?: PastedTextOptions) => {
      try {
        const result = await writePastedTextMutation.mutateAsync({
          subChatId,
          text,
          kind: options?.kind,
        });

        // Create preview from first 50 chars, replace newlines with spaces
        const preview = text.slice(0, 50).replace(/\n/g, ' ');
        const newPasted: PastedTextFile = {
          id: newChipId(),
          filePath: result.filePath,
          filename: result.filename,
          size: result.size,
          preview: options?.label ?? (preview.length < text.length ? `${preview}...` : preview),
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

  const attachPastedFileMutation = trpc.files.attachPastedFile.useMutation();

  /** Copies each file from its place on disk into the chat's pasted folder, one chip per file. */
  const addPastedFiles = useCallback(
    async (files: File[]) => {
      for (const file of files) {
        const sourcePath = window.webUtils?.getPathForFile(file) ?? '';
        if (file.size > PASTED_FILE_MAX_BYTES || !sourcePath) {
          toast.error(`Couldn't attach ${file.name}`, {
            description:
              file.size > PASTED_FILE_MAX_BYTES
                ? PASTED_FILE_TOO_LARGE
                : 'Save it to your computer, then drag it in or use the attach button.',
          });
          continue;
        }
        try {
          const saved = await attachPastedFileMutation.mutateAsync({ subChatId, sourcePath });
          const chip = { ...saved, id: newChipId(), preview: file.name, createdAt: new Date() };
          setPastedTexts((prev) => [...prev, chip]);
        } catch (error) {
          toast.error(`Couldn't attach ${file.name}`, {
            description: error instanceof Error ? error.message : undefined,
          });
        }
      }
    },
    [subChatId, attachPastedFileMutation],
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
    addPastedFiles,
    removePastedText,
    clearPastedTexts,
    setPastedTextsFromDraft,
    pastedTextsRef,
  };
}
