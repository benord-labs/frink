import { type RefObject, useCallback } from 'react';
import type { useAgentsFileUpload } from '../../../../hooks/use-agents-file-upload';
import type { usePastedTextFiles } from '../../../../hooks/use-pasted-text-files';
import type { useTextContextSelection } from '../../../../hooks/use-text-context-selection';
import {
  clearSubChatDraft,
  type FullDraftData,
  hasDraftContent,
  writeSubChatDraft,
} from '../../../../lib/drafts';
import type { AgentQueueItem } from '../../../../lib/queue-utils';
import { createTextPreview, editableQueuedImages } from '../../../../lib/queue-utils';
import type { AgentsMentionsEditorHandle } from '../../../../mentions/agents-mentions-editor';
import { useMessageQueueStore } from '../../../../stores/message-queue-store';

type Upload = Pick<ReturnType<typeof useAgentsFileUpload>, 'clearAll' | 'setImagesFromDraft'>;
type TextContexts = Pick<
  ReturnType<typeof useTextContextSelection>,
  | 'clearTextContexts'
  | 'clearDiffTextContexts'
  | 'setTextContextsFromDraft'
  | 'setDiffTextContextsFromDraft'
>;

type Pasted = Pick<
  ReturnType<typeof usePastedTextFiles>,
  'clearPastedTexts' | 'setPastedTextsFromDraft'
>;

/** The composer content an Edit loads. A turn restored after a reload previews its images from
 * inline data. */
function editContent(item: AgentQueueItem) {
  const images = editableQueuedImages(item.images).map((img) => ({
    ...img,
    filename: img.filename ?? img.id,
    isLoading: false,
  }));
  const textContexts = (item.textContexts ?? []).map((ctx) => ({
    ...ctx,
    preview: createTextPreview(ctx.text),
    createdAt: new Date(),
  }));
  const diffTextContexts = (item.diffTextContexts ?? []).map((ctx) => ({
    ...ctx,
    preview: createTextPreview(ctx.text),
    createdAt: new Date(),
  }));
  const pastedTexts = (item.pastedTexts ?? []).map((p) => ({ ...p, createdAt: new Date() }));
  return { images, textContexts, diffTextContexts, pastedTexts };
}

/** Saved at once, not on blur, so a reload or switch before blur finds the whole edit. */
function saveEditDraft(
  chatId: string,
  subChatId: string,
  text: string,
  { images, textContexts, pastedTexts }: ReturnType<typeof editContent>,
) {
  writeSubChatDraft(chatId, subChatId, { text, images, textContexts, pastedTexts });
}

/** Whether a mount should release the sub-chat's editing flag: only when the saved draft holds
 * nothing. */
export function shouldReleaseEdit(subChatId: string, draft: FullDraftData | null): boolean {
  if (!useMessageQueueStore.getState().editingItemIds[subChatId]) return false;
  return !(draft && hasDraftContent(draft));
}

/** Edit a queued item in the composer; the original keeps an "Editing…" badge until the edit is sent
 * or abandoned. The flag outlives unmount; the next mount releases it if the saved draft is empty. */
export function useQueueEdit({
  subChatId,
  parentChatId,
  editorRef,
  inputHasContent,
  upload,
  textContexts,
  pasted,
}: {
  subChatId: string;
  parentChatId: string | null | undefined;
  editorRef: RefObject<AgentsMentionsEditorHandle | null>;
  inputHasContent: boolean;
  upload: Upload;
  textContexts: TextContexts;
  /** A large paste lives only as a chip, so an edit that dropped it would re-send without it. */
  pasted?: Pasted;
}) {
  const setEditingItemId = useMessageQueueStore((s) => s.setEditingItemId);
  const { clearAll, setImagesFromDraft } = upload;
  const {
    clearTextContexts,
    clearDiffTextContexts,
    setTextContextsFromDraft,
    setDiffTextContextsFromDraft,
  } = textContexts;
  const { clearPastedTexts, setPastedTextsFromDraft } = pasted ?? {};

  const handleAbandonEdit = useCallback(() => {
    const currentEditingId = useMessageQueueStore.getState().editingItemIds[subChatId];
    if (!currentEditingId) return;
    setEditingItemId(subChatId, null);
    // Edit saved the draft eagerly, so an abandoned edit must not come back on reload.
    if (parentChatId) clearSubChatDraft(parentChatId, subChatId);
    editorRef.current?.clear();
    clearAll();
    clearTextContexts();
    clearDiffTextContexts();
    clearPastedTexts?.();
  }, [
    subChatId,
    parentChatId,
    editorRef,
    setEditingItemId,
    clearAll,
    clearTextContexts,
    clearDiffTextContexts,
    clearPastedTexts,
  ]);

  const handleEditFromQueue = useCallback(
    (itemId: string) => {
      // Don't let the user clobber unsaved input. UI also disables the button in this state.
      if (inputHasContent) return;
      // No composer to load into — an AskUserQuestion card owns its slot. Leave the queue alone
      // rather than flag an item as "Editing…" against an editor that cannot receive its text.
      if (!editorRef.current) return;
      const { queues, editingItemIds } = useMessageQueueStore.getState();
      const item = queues[subChatId]?.find((i) => i.id === itemId);
      if (!item) return;
      // Switching to another item abandons the previous edit's flag; that original stays queued.
      if (editingItemIds[subChatId] !== itemId) setEditingItemId(subChatId, null);

      editorRef.current.setValue(item.message);
      const content = editContent(item);
      setImagesFromDraft(content.images);
      setTextContextsFromDraft(content.textContexts);
      setDiffTextContextsFromDraft(content.diffTextContexts);
      setPastedTextsFromDraft?.(content.pastedTexts);
      if (parentChatId) saveEditDraft(parentChatId, subChatId, item.message, content);
      // codeSelectionContexts live in per-chat Jotai atoms and are not restored to the editor (v1).
      setEditingItemId(subChatId, itemId);
      editorRef.current.focus();
    },
    [
      subChatId,
      parentChatId,
      editorRef,
      inputHasContent,
      setEditingItemId,
      setImagesFromDraft,
      setTextContextsFromDraft,
      setDiffTextContextsFromDraft,
      setPastedTextsFromDraft,
    ],
  );

  return { handleAbandonEdit, handleEditFromQueue };
}
