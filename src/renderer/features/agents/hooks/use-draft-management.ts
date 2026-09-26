import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { TaskData } from '@/lib/tasks/format-task-message';
import {
  clearDraft,
  clearDraftIfUnchanged,
  type FullDraftData,
  getDraftWriteCount,
  readDraftStamp,
  readNewChatDraft,
  writeDraft,
} from '../lib/drafts';
import type { AgentsMentionsEditorHandle } from '../mentions';
import { useAgentsFileUpload } from './use-agents-file-upload';
import { type PastedTextFile, usePastedTextFiles } from './use-pasted-text-files';
import { useTaskAttachment } from './use-task-attachment';

/** Trailing debounce on keystrokes. Attachment changes and teardown flush immediately instead. */
const DRAFT_SAVE_DEBOUNCE_MS = 300;

type EditorRef = React.RefObject<AgentsMentionsEditorHandle | null>;

/** Everything a composer holds that is worth surviving a trip to another destination. */
type ComposerSnapshot = {
  text: string;
  images: FullDraftData['images'];
  pastedTexts: PastedTextFile[];
  task: TaskData | null;
};

type RestoreTargets = {
  editorRef: EditorRef;
  setHasContent: (hasContent: boolean) => void;
  setImagesFromDraft: (images: FullDraftData['images']) => void;
  setPastedTextsFromDraft: (pastedTexts: PastedTextFile[]) => void;
  setAttachedTask: (task: TaskData | null) => void;
};

/**
 * Normalises a stored draft (or its absence) into one non-optional shape to apply. Always a fresh
 * object — callers alias it directly into state they later mutate in place (`s.latest.text =
 * ...`), so a shared constant here would let one composer's typing corrupt every other
 * instance's "nothing stored" restore for the rest of the session.
 */
function toSnapshot(saved: FullDraftData | null): ComposerSnapshot {
  if (!saved) return { text: '', images: [], pastedTexts: [], task: null };
  return {
    text: saved.text ?? '',
    images: saved.images,
    pastedTexts: saved.pastedTexts,
    task: saved.task,
  };
}

function snapshotHasContent(s: ComposerSnapshot): boolean {
  return Boolean(s.text || s.task) || s.images.length + s.pastedTexts.length > 0;
}

/**
 * Pours a stored draft into a mounted composer. `next` must already be seeded into the instance
 * state's `lastSavedText`/`latest` by the caller BEFORE this runs — `editor.setValue`/`clear` fire
 * `onContentChange` SYNCHRONOUSLY, and the equality guard in `handleContentChange` is what keeps a
 * restore from being misread as a user edit and silently refreshing `updatedAt` on a mere view.
 *
 * `isFirstSync` decides what an EMPTY slot means: re-pointing an existing composer at one has to
 * blank it, or the previous slot's content stays on screen; on the very first sync there is no
 * previous slot, so content already in a freshly-mounted composer is left alone.
 */
function applyRestoredDraft(next: ComposerSnapshot, isFirstSync: boolean, t: RestoreTargets): void {
  const editor = t.editorRef.current;
  if (!editor) return;

  if (next.text) editor.setValue(next.text);
  else if (!isFirstSync) editor.clear();

  // Set unconditionally: on a re-point the incoming slot's (possibly empty) attachments must
  // replace the outgoing slot's, and on a first sync these are already empty. Task included — a
  // re-point FROM a slot with a task TO one without must drop it, not leave it visibly attached.
  t.setImagesFromDraft(next.images);
  t.setPastedTextsFromDraft(next.pastedTexts);
  t.setAttachedTask(next.task);

  t.setHasContent(snapshotHasContent(next));
}

type PersistenceParams = RestoreTargets & {
  draftKey: string;
  images: FullDraftData['images'];
  pastedTexts: PastedTextFile[];
  attachedTask: TaskData | null;
};

/**
 * All of one composer instance's mutable, non-rendering state, held in a single `useRef` so the
 * extracted functions below are plain calls, not memoized hooks — hook-count itself is a
 * complexity signal, and a dozen individually-named refs cost as much on that axis as one bundle.
 */
type PersistenceState = {
  lastSavedText: string;
  saveTimer: ReturnType<typeof setTimeout> | null;
  /**
   * False until an editor has actually mounted and its stored draft has been applied. Guards two
   * ways of destroying a good draft: the attachment effect firing on first commit with empty
   * arrays, and the no-accounts branch, which renders an empty state INSTEAD of the editor and so
   * must never write its (necessarily empty) view of the composer back over storage.
   */
  restored: boolean;
  /**
   * The slot is keyed by pane, not by mount — a departed composer and its replacement address the
   * same storage, and `useMutation`'s onSuccess still runs after unmount. Together these decide
   * WHOSE copy a late clear may delete: mounted, the slot is ours; gone, only our own last write.
   */
  mounted: boolean;
  lastWriteStamp: number | null;
  lastSeenWriteCount: number; // flushDraft guard: a seeded prompt taking the slot beats older captures
  /**
   * True from Send commit until the create mutation settles. The editor keeps SHOWING the sent
   * text (cleared only on success), and that window is long enough to navigate away and back to
   * the SAME pane, remounting a fresh composer (chatIds[idx] stays the NEW_CHAT_PANE sentinel
   * until success). Without this, this instance's unmount/debounce flush would persist the
   * about-to-be-sent text and the fresh instance would restore it — resurrecting an already-sent
   * message as a stuck draft. Suspending every write closes the window whole.
   */
  isSending: boolean;
  /** The slot the editor's visible content currently belongs to; null until the first sync. */
  syncedKey: string | null;
  latest: ComposerSnapshot;
  /** The LIVE props, refreshed unconditionally every render — see `flushDraft`. */
  params: PersistenceParams;
  /** `syncFromStorage`'s last applied snapshot — see `isJustRestored`. */
  restoredSnapshot: ComposerSnapshot | null;
};

type StateRef = { current: PersistenceState };

/** Clears any armed debounce timer and forgets it — safe to call whether or not one is pending. */
function cancelPendingSave(state: StateRef): void {
  if (state.current.saveTimer) clearTimeout(state.current.saveTimer);
  state.current.saveTimer = null;
}

/** Every write is a no-op until `resumeSend` lifts it — no re-persisting the still-visible sent text. */
function pauseSend(state: StateRef): void {
  state.current.isSending = true;
  cancelPendingSave(state);
}

/**
 * Call when a send FAILS. Mounted: flushes the live editor, which still shows the sent text — the
 * pre-emptive clear in `beginSend` only touched storage, not the DOM, so this recaptures it.
 *
 * Unmounted: does nothing. `onError` can fire long after unmount — no live editor is left to read
 * a retry from, and a write here could never reach a replacement composer's own state. The
 * composer-draft-persistence decision only promises text survives NAVIGATION, so recovering a
 * failed send after navigating away is deliberately not attempted.
 */
function resumeSend(state: StateRef): void {
  state.current.isSending = false;
  if (state.current.mounted) flushDraft(state.current.params.draftKey, state);
}

/**
 * True (and consumed) if `images`/`pastedTexts`/`task` are exactly what `syncFromStorage` just
 * restored — the attachment effect's follow-up render, fired by the restore's own setters, is
 * otherwise indistinguishable from a genuine change. A stale marker can't suppress a later real
 * one: any genuine edit changes at least one field, breaking the three-way match.
 */
function isJustRestored(
  state: StateRef,
  images: FullDraftData['images'],
  pastedTexts: PastedTextFile[],
  task: TaskData | null,
): boolean {
  const r = state.current.restoredSnapshot;
  const matched = !!r && r.images === images && r.pastedTexts === pastedTexts && r.task === task;
  if (matched) state.current.restoredSnapshot = null;
  return matched;
}

/**
 * Writes the composer's current state to storage. Cancels the pending debounce UNCONDITIONALLY,
 * before the early-return — a timer armed late (content changing after `beginSend()`) can't outlive an early-returning unmount call and later fire unguarded once
 * resume flips `isSending` back false. No-ops before the first restore or while a send is in
 * flight. Attachments read from `params` — the LIVE props — not `latest`: `clearCurrentDraft`
 * wipes it pre-emptively before a send's outcome is known, and `onError` never clears live
 * attachment state, so on failure the two would disagree.
 */
function flushDraft(key: string, state: StateRef, ignoreSending = false): void {
  cancelPendingSave(state);
  const s = state.current;
  if (!s.restored || (s.isSending && !ignoreSending)) return;
  const writes = getDraftWriteCount(key);
  if (writes !== s.lastSeenWriteCount) {
    // A takeover (seeded prompt) drops ONE stale capture; adopting resumes persistence.
    s.lastSeenWriteCount = writes;
    return;
  }
  const { images: img, pastedTexts: pasted, attachedTask: task, editorRef } = s.params;
  const text = editorRef.current?.getValue() ?? s.latest.text;
  s.latest = { text, images: img, pastedTexts: pasted, task };
  writeDraft(key, { text, images: img, pastedTexts: pasted, task });
  s.lastWriteStamp = readDraftStamp(key);
  s.lastSeenWriteCount = writes + 1; // writeDraft above bumped exactly once, synchronously
}

/**
 * Unmount teardown flush. Unlike `flushDraft`'s other callers (each triggered BY a genuine edit),
 * an unconditional call here would blindly re-persist the SAME already-stored content on a mere
 * view, refreshing `updatedAt` and defeating the 7-day staleness bound for no reason. Only a
 * pending timer proves there is something genuinely unpersisted to capture.
 */
function flushIfPending(key: string, state: StateRef): void {
  if (state.current.saveTimer !== null) flushDraft(key, state);
}

/**
 * `beforeunload`-only. The app itself is disappearing here, so the `isSending` suppression —
 * which exists only to stop a same-session remount from restoring an about-to-be-sent text before
 * its outcome is known (see `pauseSend`) — cannot apply: there is no later remount within this
 * process to race with. Flushes on a pending timer OR a send still in flight, so a process kill
 * mid-send never silently loses the still-visible text.
 */
function flushBeforeUnload(key: string, state: StateRef): void {
  if (state.current.saveTimer !== null || state.current.isSending) flushDraft(key, state, true);
}

/** Applies the stored slot to the editor. No-ops until an editor actually exists. */
function syncFromStorage(key: string, state: StateRef): void {
  const s = state.current;
  if (!s.params.editorRef.current) return;
  const next = toSnapshot(readNewChatDraft(key));
  s.lastSeenWriteCount = getDraftWriteCount(key);
  // Seed BEFORE applyRestoredDraft touches the editor — see that function's doc comment.
  s.lastSavedText = next.text;
  s.latest = next;
  s.restoredSnapshot = next;
  applyRestoredDraft(next, s.syncedKey === null, s.params);
  s.syncedKey = key;
  s.restored = true;
}

/**
 * True if this images/pastedTexts/task update is a genuine change to persist — false if it is
 * merely the restore's own follow-up render (see `isJustRestored`) or nothing has restored yet.
 * Mirrors the live values into `latest` either way — `flushDraft` reads that mirror after unmount.
 */
function shouldFlushAttachments(
  state: StateRef,
  images: FullDraftData['images'],
  pastedTexts: PastedTextFile[],
  attachedTask: TaskData | null,
): boolean {
  state.current.latest.images = images;
  state.current.latest.pastedTexts = pastedTexts;
  state.current.latest.task = attachedTask;
  if (isJustRestored(state, images, pastedTexts, attachedTask)) return false;
  return state.current.restored;
}

/**
 * Records a keystroke and arms the debounced flush, unless the text is unchanged from the last
 * save (also true right after a restore, since the caller seeds this mirror first). The timer
 * reads the draft key at FIRE time (not now), so a re-point mid-debounce still lands correctly.
 */
function recordContentChange(text: string, state: StateRef): void {
  const s = state.current;
  if (text === s.lastSavedText) return;
  s.lastSavedText = text;
  s.latest.text = text;
  cancelPendingSave(state);
  s.saveTimer = setTimeout(
    () => flushDraft(state.current.params.draftKey, state),
    DRAFT_SAVE_DEBOUNCE_MS,
  );
}

/**
 * Clears the slot: outright while still mounted (the slot is ours), else only the copy we
 * ourselves last wrote, so a send resolving late cannot delete what a replacement composer has
 * since typed. `revokeBlobUrls=false` only for `beginSend`'s pre-emptive clear — see its comment.
 */
function clearDraftForInstance(key: string, state: StateRef, revokeBlobUrls: boolean): void {
  if (state.current.mounted) clearDraft(key, revokeBlobUrls);
  else clearDraftIfUnchanged(key, state.current.lastWriteStamp);
}

/**
 * Keeps one composer slot in localStorage: restores on mount, saves on a debounce while typing,
 * flushes synchronously on every way out. Split from `useDraftManagement` so each half stays
 * readable — that one owns content, this one owns durability.
 */
function useComposerPersistence(params: PersistenceParams): {
  handleContentChange: (hasContent: boolean) => void;
  clearCurrentDraft: () => void;
  beginSend: () => void;
  resumeDraftPersistence: () => void;
} {
  const { draftKey, editorRef, setHasContent, images, pastedTexts, attachedTask } = params;

  const state = useRef<PersistenceState>({
    lastSavedText: '',
    saveTimer: null,
    restored: false,
    mounted: true,
    lastWriteStamp: null,
    lastSeenWriteCount: 0,
    isSending: false,
    syncedKey: null,
    latest: { text: '', images: [], pastedTexts: [], task: null },
    params,
    restoredSnapshot: null,
  });
  // Refreshed unconditionally every render — see `flushDraft`'s doc comment.
  state.current.params = params;

  // Declared BEFORE the restore effect: on the mount pass these props still hold PRE-restore
  // values, so this sees `restored` still false and writes nothing. Attachments live in React
  // state, so their change IS the save signal — nothing to debounce. NOT keyed on draftKey: a key
  // change is not an attachment change, and re-running here would copy the outgoing slot's
  // content into the incoming one.
  useEffect(() => {
    if (shouldFlushAttachments(state, images, pastedTexts, attachedTask)) {
      flushDraft(state.current.params.draftKey, state);
    }
  }, [images, pastedTexts, attachedTask]);

  // Restore on mount; persist on the way out (destination change, window close). Flushes to
  // draftKey (this render's own, closure-captured) rather than the always-latest params.draftKey:
  // by the time this cleanup runs on a re-point, the render above has already refreshed
  // state.current.params to the NEW key, so reading it here would flush this pane's text into the
  // incoming slot instead of the one it was typed in.
  useEffect(() => {
    syncFromStorage(draftKey, state);

    // React skips effect cleanups on renderer teardown, so an unmount-only save would drop whatever
    // was typed inside the debounce window when the app is quit.
    const onBeforeUnload = (): void => flushBeforeUnload(draftKey, state);
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      flushIfPending(draftKey, state);
    };
  }, [draftKey]);

  // The editor can arrive LATER than this hook: while no account is connected the form renders an
  // empty state in its place, and connecting one swaps the editor in without remounting the form.
  // Runs every render (cheap no-op once restored) — otherwise this composer's persistence would
  // stay switched off for the rest of its life.
  useEffect(() => {
    if (!state.current.restored) syncFromStorage(draftKey, state);
  });

  const handleContentChange = useCallback(
    (hasContent: boolean) => {
      setHasContent(hasContent);
      const text = editorRef.current?.getValue() || '';
      recordContentChange(text, state);
    },
    [editorRef, setHasContent],
  );

  /** Called once a chat has been created from this draft, and by `beginSend` before that. */
  const clearCurrentDraft = useCallback((revokeBlobUrls = true) => {
    cancelPendingSave(state);
    state.current.lastSavedText = '';
    state.current.latest = { text: '', images: [], pastedTexts: [], task: null };
    clearDraftForInstance(state.current.params.draftKey, state, revokeBlobUrls);
  }, []);

  /**
   * Call once a send is committed. Suspends every further write until `resumeDraftPersistence`
   * lifts it — a composer remounted at the same pane mid-request would otherwise restore and
   * resurrect the still-visible sent text as a stuck draft. Clears WITHOUT revoking attachment
   * blob URLs: still-mounted and visibly showing them, revoking now would strand a broken
   * thumbnail with no repair path on failure — traded for a bounded, unload-scoped leak.
   */
  const beginSend = useCallback(() => {
    clearCurrentDraft(false);
    pauseSend(state);
  }, [clearCurrentDraft]);

  /** Call when a send FAILS — flushes immediately since onError never clears the editor. */
  const resumeDraftPersistence = useCallback(() => resumeSend(state), []);

  // Declared last so its cleanup runs AFTER the persist effect's final flush.
  useEffect(() => {
    state.current.mounted = true;
    return () => {
      state.current.mounted = false;
    };
  }, []);

  return {
    handleContentChange,
    clearCurrentDraft,
    beginSend,
    resumeDraftPersistence,
  };
}

type Props = {
  editorRef: EditorRef;
  setHasContent: (hasContent: boolean) => void;
  /** Stable per-pane storage slot — see `newChatDraftKey`. */
  draftKey: string;
};

type ReturnValue = Pick<
  ReturnType<typeof useAgentsFileUpload>,
  'images' | 'handleAddAttachments' | 'removeImage' | 'clearImages' | 'isUploading'
> &
  Pick<
    ReturnType<typeof usePastedTextFiles>,
    'pastedTexts' | 'addPastedText' | 'removePastedText' | 'clearPastedTexts'
  > & {
    taskAttachment: ReturnType<typeof useTaskAttachment>;
    handleContentChange: (hasContent: boolean) => void;
    clearCurrentDraft: () => void;
    beginSend: () => void;
    resumeDraftPersistence: () => void;
    /** True when an image, pasted-text chip or task alone would make a send valid. */
    hasAttachments: boolean;
  };

/**
 * Owns the new-chat composer's content AND its persistence.
 *
 * The composer unmounts whenever the user visits another destination (Flows and Settings replace
 * the whole chat surface), so without this the typed prompt and everything attached to it is
 * discarded on every trip away. Ownership sits here rather than in the form because saving and
 * restoring has to both read and write the attachments — threading them back out as props would put
 * the same state on both sides of the boundary.
 *
 * Note the draft deliberately outlives its pane's TERMINAL state, which `cleanupSentinelState`
 * resets on navigation. Authored text is not scratch state.
 */
export function useDraftManagement({ editorRef, setHasContent, draftKey }: Props): ReturnValue {
  const focusEditor = useCallback(() => editorRef.current?.focus(), [editorRef]);

  const fileUpload = useAgentsFileUpload();
  const pasted = usePastedTextFiles(draftKey);
  const taskAttachment = useTaskAttachment({ editorRef, onDrop: focusEditor });

  const { images, handleAddAttachments, removeImage, clearImages, isUploading } = fileUpload;
  const { pastedTexts, addPastedText, removePastedText, clearPastedTexts } = pasted;

  const { handleContentChange, clearCurrentDraft, beginSend, resumeDraftPersistence } =
    useComposerPersistence({
      draftKey,
      editorRef,
      setHasContent,
      images,
      pastedTexts,
      attachedTask: taskAttachment.attachedTask,
      setImagesFromDraft: fileUpload.setImagesFromDraft,
      setPastedTextsFromDraft: pasted.setPastedTextsFromDraft,
      setAttachedTask: taskAttachment.setAttachedTask,
    });

  const hasAttachments =
    images.length > 0 || pastedTexts.length > 0 || !!taskAttachment.attachedTask;

  return useMemo(
    () => ({
      images,
      handleAddAttachments,
      removeImage,
      clearImages,
      isUploading,
      pastedTexts,
      addPastedText,
      removePastedText,
      clearPastedTexts,
      taskAttachment,
      handleContentChange,
      clearCurrentDraft,
      beginSend,
      resumeDraftPersistence,
      hasAttachments,
    }),
    [
      images,
      handleAddAttachments,
      removeImage,
      clearImages,
      isUploading,
      pastedTexts,
      addPastedText,
      removePastedText,
      clearPastedTexts,
      taskAttachment,
      handleContentChange,
      clearCurrentDraft,
      beginSend,
      resumeDraftPersistence,
      hasAttachments,
    ],
  );
}
