import { type RefObject, useCallback, useEffect, useRef } from 'react';
import type { UploadedFile, UploadedImage } from '../../hooks/use-agents-file-upload';
import type { AgentsMentionsEditorHandle } from '../../mentions';
import {
  clearSubChatDraft,
  getSubChatDraftFull,
  saveSubChatDraftText,
  saveSubChatDraftWithAttachments,
} from '../drafts';
import type { SelectedTextContext } from '../queue-utils';

type ComposerDraftParams = {
  editorRef: RefObject<AgentsMentionsEditorHandle | null>;
  chatIdRef: RefObject<string | null>;
  subChatIdRef: RefObject<string>;
  /** Kept current by `onContentChange`; the only text still readable once the editor is detached. */
  draftTextRef: RefObject<string>;
  images: UploadedImage[];
  files: UploadedFile[];
  textContexts: SelectedTextContext[];
  /** Contexts that count as content but are not stored — they rebuild themselves from the diff. */
  extraContextCount: number;
  onContentChange: (hasContent: boolean) => void;
};

/**
 * Owns a composer's draft across its own lifetime, which is SHORTER than its sub-chat's: the
 * composer unmounts when an AskUserQuestion card takes its slot, or when the pane closes, and
 * neither fires the editor's blur — which used to be the draft's only save.
 *
 * Returns the blur save (attachments included, async). The unmount save writes TEXT ONLY and does so
 * synchronously: an unmount cannot await, and an async write there could land after a later clear —
 * a send's, say — and resurrect what that clear discarded. Attachments need no such rescue; they
 * live in the parent's state, outlive this component, and are rewritten by the next blur.
 */
export function useComposerDraft(params: ComposerDraftParams): () => Promise<void> {
  const paramsRef = useRef(params);
  paramsRef.current = params;

  const saveWithAttachments = useCallback(async () => {
    const { editorRef, chatIdRef, subChatIdRef, draftTextRef } = paramsRef.current;
    const { images, files, textContexts, extraContextCount } = paramsRef.current;
    const text = editorRef.current?.getValue() || '';
    draftTextRef.current = text;
    const chatId = chatIdRef.current;
    if (!chatId) return;
    const total = images.length + files.length + textContexts.length + extraContextCount;
    if (!text.trim() && total === 0) {
      clearSubChatDraft(chatId, subChatIdRef.current);
      return;
    }
    await saveSubChatDraftWithAttachments(chatId, subChatIdRef.current, text, {
      images,
      files,
      textContexts,
    });
  }, []);

  useEffect(() => {
    const { editorRef, chatIdRef, subChatIdRef, onContentChange } = paramsRef.current;
    const chatId = chatIdRef.current;
    const saved = chatId ? getSubChatDraftFull(chatId, subChatIdRef.current)?.text : null;
    if (saved) {
      // Restores only an editor that mounted empty (the parent restores on sub-chat SWITCH, which
      // does not remount this component). Either way the text ref is synced from the editor, so the
      // unmount save below knows what is really held.
      if (!editorRef.current?.getValue()) editorRef.current?.setValue(saved);
      onContentChange(true);
    }
    return () => {
      const { chatIdRef: chat, subChatIdRef: sub, draftTextRef: draft } = paramsRef.current;
      if (chat.current) saveSubChatDraftText(chat.current, sub.current, draft.current);
    };
  }, []);

  return saveWithAttachments;
}
