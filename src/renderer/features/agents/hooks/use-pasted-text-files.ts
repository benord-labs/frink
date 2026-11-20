import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  PASTED_FILE_MAX_BYTES,
  PASTED_FILE_TOO_LARGE,
} from '../../../../shared/pasted-file-limits';
import { trpc } from '../../../lib/trpc';
import {
  beginPastedCopy,
  deliverPastedChip,
  type PastedChipSink,
  type PastedChipTarget,
  registerPastedChipSink,
  usePastedCopyInFlight,
} from '../lib/pasted-chip-delivery';

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
  /** A file is still copying into this composer's slot, possibly started by a departed instance. */
  isCopying: boolean;
};

/** Why a dropped file cannot be copied in, or null when it can. */
function whyNotAttachable(file: File, sourcePath: string): string | null {
  if (file.size > PASTED_FILE_MAX_BYTES) return PASTED_FILE_TOO_LARGE;
  return sourcePath ? null : 'Save it to your computer, then drag it in or use the attach button.';
}

const newChipId = () => `pasted_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

export function usePastedTextFiles(
  subChatId: string,
  target: PastedChipTarget | null = null,
): UsePastedTextFilesReturn {
  const [pastedTexts, setPastedTexts] = useState<PastedTextFile[]>([]);
  const pastedTextsRef = useRef<PastedTextFile[]>([]);

  // Keep ref in sync with state
  pastedTextsRef.current = pastedTexts;

  const writePastedTextMutation = trpc.files.writePastedText.useMutation();
  const attachPastedFileMutation = trpc.files.attachPastedFile.useMutation();
  const subChatIdRef = useRef(subChatId);
  subChatIdRef.current = subChatId;
  const targetRef = useRef(target);
  targetRef.current = target;
  const targetKey = target?.key ?? null;
  const isCopying = usePastedCopyInFlight(targetKey);

  const sinkRef = useRef<PastedChipSink | undefined>(undefined);

  useEffect(() => {
    if (!targetKey) return;
    const sink: PastedChipSink = (chip) => {
      if (targetRef.current?.isReady?.() === false) return false;
      setPastedTexts((prev) => [...prev, chip]);
      return true;
    };
    sinkRef.current = sink;
    return registerPastedChipSink(targetKey, sink);
  }, [targetKey]);

  /** Snapshots the slot a paste or drop starts in, so its chips land there even if this composer
   *  has gone or moved to another slot meanwhile. `beginCopy` holds Send for that slot. */
  const snapshotSlot = useCallback(() => {
    const dropTarget = targetRef.current;
    const origin = sinkRef.current;
    const atSubChatId = subChatIdRef.current;
    const deliver = dropTarget
      ? (chip: PastedTextFile) => deliverPastedChip(dropTarget, chip, atSubChatId, origin)
      : (chip: PastedTextFile) => setPastedTexts((prev) => [...prev, chip]);
    const beginCopy = () => beginPastedCopy(dropTarget?.key ?? null);
    return { subChatId: atSubChatId, deliver, beginCopy };
  }, []);

  const addPastedText = useCallback(
    async (text: string, options?: PastedTextOptions) => {
      const { subChatId: atSubChatId, deliver, beginCopy } = snapshotSlot();
      const endCopy = beginCopy();
      try {
        const result = await writePastedTextMutation.mutateAsync({
          subChatId: atSubChatId,
          text,
          kind: options?.kind,
        });

        // Create preview from first 50 chars, replace newlines with spaces
        const preview = text.slice(0, 50).replace(/\n/g, ' ');
        deliver({
          id: newChipId(),
          filePath: result.filePath,
          filename: result.filename,
          size: result.size,
          preview: options?.label ?? (preview.length < text.length ? `${preview}...` : preview),
          createdAt: new Date(),
        });
      } catch (error) {
        // Rethrown so the paste handler can fall back to inline text: the default paste was
        // already cancelled, so swallowing this would drop the pasted text entirely.
        throw error instanceof Error ? error : new Error('Failed to save pasted text');
      } finally {
        endCopy();
      }
    },
    [snapshotSlot, writePastedTextMutation],
  );

  /** Copies each file into the chat's pasted folder, one chip per file. */
  const addPastedFiles = useCallback(
    async (files: File[]) => {
      const { subChatId: atSubChatId, deliver, beginCopy } = snapshotSlot();
      for (const file of files) {
        const sourcePath = window.webUtils?.getPathForFile(file) ?? '';
        const refusal = whyNotAttachable(file, sourcePath);
        if (refusal) {
          toast.error(`Couldn't attach ${file.name}`, { description: refusal });
          continue;
        }
        const endCopy = beginCopy();
        try {
          const saved = await attachPastedFileMutation.mutateAsync({
            subChatId: atSubChatId,
            sourcePath,
          });
          deliver({ ...saved, id: newChipId(), preview: file.name, createdAt: new Date() });
        } catch (error) {
          toast.error(`Couldn't attach ${file.name}`, {
            description: error instanceof Error ? error.message : undefined,
          });
        } finally {
          endCopy();
        }
      }
    },
    [snapshotSlot, attachPastedFileMutation],
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
    isCopying,
  };
}
