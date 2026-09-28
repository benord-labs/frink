import { type RefObject, useCallback } from 'react';
import type { useAgentsFileUpload } from '../../../../hooks/use-agents-file-upload';
import type { useTextContextSelection } from '../../../../hooks/use-text-context-selection';
import {
  clearSubChatDraft,
  type FullDraftData,
  hasDraftContent,
  saveSubChatDraftWithAttachments,
  writeSubChatDraft,
} from '../../../../lib/drafts';
import type { AgentQueueItem } from '../../../../lib/queue-utils';
import { createTextPreview, editableQueuedImages } from '../../../../lib/queue-utils';
import type { AgentsMentionsEditorHandle } from '../../../../mentions/agents-mentions-editor';
import { useMessageQueueStore } from '../../../../stores/message-queue-store';

type Upload = Pick<
  ReturnType<typeof useAgentsFileUpload>,
  'clearAll' | 'setImagesFromDraft' | 'setFilesFromDraft'
>;
type TextContexts = Pick<
  ReturnType<typeof useTextContextSelection>,
  | 'clearTextContexts'
  | 'clearDiffTextContexts'
  | 'setTextContextsFromDraft'
  | 'setDiffTextContextsFromDraft'
>;

/** The composer content an Edit loads. A turn restored after a reload has no files left (the user
 * re-attaches them) and previews its images from inline data. */
function editContent(item: AgentQueueItem) {
  const images = editableQueuedImages(item.images).map((img) => ({
    ...img,
    filename: img.filename ?? img.id,
    isLoading: false,
  }));
  const files = item.attachmentsLost
    ? []
    : (item.files ?? []).map((f) => ({
        id: f.id,
        filename: f.filename,
        url: f.url,
        isLoading: false,
        size: f.size,
        type: f.mediaType,
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
  return { images, files, textContexts, diffTextContexts };
}

/** Saved at once, not on blur, so a reload or switch before blur finds the whole edit. Files need
 * an async read of their blob, so a turn that still has them re-saves once that completes. */
function saveEditDraft(
  chatId: string,
  subChatId: string,
  text: string,
  { images, files, textContexts }: Omit<ReturnType<typeof editContent>, 'diffTextContexts'>,
) {
  writeSubChatDraft(chatId, subChatId, { text, images, textContexts });
  if (files.length === 0) return;
  fileDraftWrites.set(subChatId, (fileDraftWrites.get(subChatId) ?? 0) + 1);
  void saveSubChatDraftWithAttachments(chatId, subChatId, text, { images, files, textContexts })
    .catch(() => undefined)
    .finally(() => {
      const left = (fileDraftWrites.get(subChatId) ?? 1) - 1;
      if (left > 0) fileDraftWrites.set(subChatId, left);
      else fileDraftWrites.delete(subChatId);
    });
}

/** In-flight edit draft writes with files (an async blob read), counted per sub-chat so overlapping
 * edits cannot clear each other's marker. */
const fileDraftWrites = new Map<string, number>();

/** Whether a mount should release the sub-chat's editing flag: only when the saved draft holds
 * nothing and no file draft write for it is still in flight. */
export function shouldReleaseEdit(subChatId: string, draft: FullDraftData | null): boolean {
  if (!useMessageQueueStore.getState().editingItemIds[subChatId]) return false;
  return !(draft && hasDraftContent(draft)) && !fileDraftWrites.get(subChatId);
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
}: {
  subChatId: string;
  parentChatId: string | null | undefined;
  editorRef: RefObject<AgentsMentionsEditorHandle | null>;
  inputHasContent: boolean;
  upload: Upload;
  textContexts: TextContexts;
}) {
  const setEditingItemId = useMessageQueueStore((s) => s.setEditingItemId);
  const { clearAll, setImagesFromDraft, setFilesFromDraft } = upload;
  const {
    clearTextContexts,
    clearDiffTextContexts,
    setTextContextsFromDraft,
    setDiffTextContextsFromDraft,
  } = textContexts;

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
  }, [
    subChatId,
    parentChatId,
    editorRef,
    setEditingItemId,
    clearAll,
    clearTextContexts,
    clearDiffTextContexts,
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
      setFilesFromDraft(content.files);
      setTextContextsFromDraft(content.textContexts);
      setDiffTextContextsFromDraft(content.diffTextContexts);
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
      setFilesFromDraft,
      setTextContextsFromDraft,
      setDiffTextContextsFromDraft,
    ],
  );

  return { handleAbandonEdit, handleEditFromQueue };
}
