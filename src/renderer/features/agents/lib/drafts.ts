/**
 * Local draft store for in-progress composer content, shared by two surfaces:
 *
 * - sub-chat composers, keyed `${chatId}:${subChatId}`
 * - the new-chat (home) composer, keyed by its pane sentinel (see `newChatDraftKey`)
 *
 * Both live in one localStorage entry under a shared byte budget. Every write goes through
 * `commitDraft`, so the budget is measured the same way for both and neither can silently starve
 * the other.
 */
import type { TaskData } from '@/lib/tasks/format-task-message';
import { newChatTerminalId } from '../../../lib/agent-chat/sentinel-ids';
import type { UploadedFile, UploadedImage } from '../hooks/use-agents-file-upload';
import type { PastedTextFile } from '../hooks/use-pasted-text-files';
import type { SelectedTextContext } from './queue-utils';

const DRAFTS_STORAGE_KEY = 'agent-drafts-global';
const MAX_DRAFT_STORAGE_BYTES = 4 * 1024 * 1024; // 4MB safe limit
/** Keys written by the removed new-chat draft API; pruned on first write. */
const LEGACY_NEW_CHAT_KEY_PREFIX = 'draft-';
/** A composer draft is working state, not an archive — past this it is noise, not context. */
const STALE_DRAFT_MS = 7 * 24 * 60 * 60 * 1000;

const draftBlobUrls = new Map<string, string[]>();

type DraftImage = {
  id: string;
  filename: string;
  base64Data: string;
  mediaType: string;
};

type DraftFile = {
  id: string;
  filename: string;
  base64Data: string;
  size?: number;
  type?: string;
};

type DraftTextContext = {
  id: string;
  text: string;
  sourceMessageId: string;
  preview: string;
  createdAt: string; // ISO string instead of Date
};

/** Pasted text is already a real file on disk — only the chip metadata needs persisting. */
type DraftPastedText = {
  id: string;
  filePath: string;
  filename: string;
  size: number;
  preview: string;
};

type DraftContent = {
  text: string;
  updatedAt: number;
  images?: DraftImage[];
  files?: DraftFile[];
  textContexts?: DraftTextContext[];
  pastedTexts?: DraftPastedText[];
  task?: TaskData;
};

type GlobalDraftsRaw = Record<string, DraftContent>;

/**
 * Every read of the store goes through here, including the composer's mount. A hand-edited or
 * half-written entry must therefore degrade to "no drafts" rather than throw — `JSON.parse` happily
 * returns null, a string or an array, none of which can be indexed or written to.
 */
function loadGlobalDrafts(): GlobalDraftsRaw {
  if (typeof window === 'undefined') return {};
  try {
    const stored = localStorage.getItem(DRAFTS_STORAGE_KEY);
    const parsed = stored ? JSON.parse(stored) : {};
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function saveGlobalDrafts(drafts: GlobalDraftsRaw): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(DRAFTS_STORAGE_KEY, JSON.stringify(drafts));
  } catch {
    // Ignore localStorage errors
  }
}

function getSubChatDraftKey(chatId: string, subChatId: string): string {
  return `${chatId}:${subChatId}`;
}

/**
 * Storage key for the new-chat composer's draft.
 *
 * `?? 0` is load-bearing: the non-split and mobile composers render without a `splitPaneIndex`
 * while split pane 0 renders with `0`. Those are ONE surface to the user, so both must resolve to
 * the same key or typing at home and then opening split view would look like the draft was lost.
 * Deliberately not the same call as the form's `terminalId` (which keeps its unnormalised index so
 * existing terminal state is not orphaned).
 */
export function newChatDraftKey(splitPaneIndex?: number): string {
  return newChatTerminalId(splitPaneIndex ?? 0);
}

/**
 * Counts the SYNCHRONOUS writes per slot — a composer unmount's text save, a clear. Only
 * `saveSubChatDraftWithAttachments` yields, and its `text` is captured before that yield; if this
 * count moved while it converted attachments, something newer has landed and it must not write its
 * own stale copy back over it. Async saves deliberately do not count, so two of them overlapping
 * keep resolving last-write-wins rather than the earlier one blocking the later.
 */
const draftWriteCount = new Map<string, number>();

function bumpDraftWriteCount(key: string): void {
  draftWriteCount.set(key, (draftWriteCount.get(key) ?? 0) + 1);
}
export const getDraftWriteCount = (key: string): number => draftWriteCount.get(key) ?? 0;

// Shared sync core

function hasItems(list: unknown[] | undefined): boolean {
  return (list?.length ?? 0) > 0;
}

/** Whether a draft — stored or restored — holds anything the user could still send. */
export function hasDraftContent(draft: {
  text: string | null;
  images?: unknown[];
  files?: unknown[];
  textContexts?: unknown[];
  pastedTexts?: unknown[];
  task?: unknown;
}): boolean {
  const attachments = [draft.images, draft.files, draft.textContexts, draft.pastedTexts];
  return Boolean(draft.text?.trim() || draft.task) || attachments.some(hasItems);
}

/** Revoke blob URLs associated with a draft item */
function revokeDraftBlobUrls(draftId: string): void {
  const urls = draftBlobUrls.get(draftId);
  if (urls) {
    urls.forEach((url) => {
      URL.revokeObjectURL(url);
    });
    draftBlobUrls.delete(draftId);
  }
}

function revokeDraftAttachments(draft: DraftContent | undefined): void {
  for (const img of draft?.images ?? []) revokeDraftBlobUrls(img.id);
  for (const file of draft?.files ?? []) revokeDraftBlobUrls(file.id);
}

/**
 * The one write path. Drops the slot's PREVIOUS copy from the map before measuring, so a draft is
 * never counted twice against the shared budget — re-saving the same content on every debounce tick
 * used to inflate the estimate until it degraded itself to text-only.
 */
function commitDraft(
  key: string,
  draft: DraftContent,
): 'saved' | 'attachments_skipped' | 'cleared' {
  const drafts = loadGlobalDrafts();
  const previous = drafts[key];
  delete drafts[key];
  for (const existing of Object.keys(drafts)) {
    if (existing.startsWith(LEGACY_NEW_CHAT_KEY_PREFIX)) delete drafts[existing];
  }

  if (!hasDraftContent(draft)) {
    revokeDraftAttachments(previous);
    saveGlobalDrafts(drafts);
    return 'cleared';
  }

  // UTF-16 chars = 2 bytes each.
  const overBudget =
    JSON.stringify(drafts).length * 2 + JSON.stringify(draft).length * 2 > MAX_DRAFT_STORAGE_BYTES;
  if (overBudget) {
    const { images: _images, files: _files, ...rest } = draft;
    drafts[key] = rest;
    saveGlobalDrafts(drafts);
    return 'attachments_skipped';
  }

  drafts[key] = draft;
  saveGlobalDrafts(drafts);
  return 'saved';
}

/** `revokeBlobUrls=false` clears storage but leaves attachment URLs live — for a pre-emptive
 * clear whose composer may still be showing them (see beginSend in use-draft-management.ts). */
export function clearDraft(key: string, revokeBlobUrls = true): void {
  const drafts = loadGlobalDrafts();
  if (!(key in drafts)) return;
  if (revokeBlobUrls) revokeDraftAttachments(drafts[key]);
  delete drafts[key];
  saveGlobalDrafts(drafts);
}

/** The slot's current write stamp, or null when it holds nothing. Pairs with `clearDraftIfUnchanged`. */
export function readDraftStamp(key: string): number | null {
  return loadGlobalDrafts()[key]?.updatedAt ?? null;
}

/**
 * Clears the slot only if it still holds the copy identified by `stamp`.
 *
 * Slots are keyed by pane rather than by mount, so a composer that has already gone away can still
 * be told (by a send that resolves late) to clear "its" draft — by which time a replacement composer
 * may own that slot. Comparing the stamp settles which of the two the stored copy belongs to.
 */
export function clearDraftIfUnchanged(key: string, stamp: number | null): boolean {
  if (stamp === null || readDraftStamp(key) !== stamp) return false;
  clearDraft(key);
  return true;
}

// Attachment conversion

/** Convert blob URL to base64 data */
async function blobUrlToBase64(blobUrl: string): Promise<string> {
  const response = await fetch(blobUrl);
  const blob = await response.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string;
      // Remove the data:xxx;base64, prefix
      const base64 = result.split(',')[1];
      resolve(base64 || '');
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

/** Convert UploadedImage to DraftImage (filter out images without base64) */
function toDraftImage(img: UploadedImage): DraftImage | null {
  if (!img.base64Data) return null;
  return {
    id: img.id,
    filename: img.filename,
    base64Data: img.base64Data,
    mediaType: img.mediaType || 'image/png',
  };
}

/** Convert UploadedFile to DraftFile (requires async conversion) */
async function toDraftFile(file: UploadedFile): Promise<DraftFile | null> {
  if (!file.url) return null;
  try {
    const base64Data = await blobUrlToBase64(file.url);
    return {
      id: file.id,
      filename: file.filename,
      base64Data,
      size: file.size,
      type: file.type,
    };
  } catch (_err) {
    return null;
  }
}

function toDraftTextContext(ctx: SelectedTextContext): DraftTextContext {
  return {
    id: ctx.id,
    text: ctx.text,
    sourceMessageId: ctx.sourceMessageId,
    preview: ctx.preview,
    createdAt: ctx.createdAt instanceof Date ? ctx.createdAt.toISOString() : String(ctx.createdAt),
  };
}

function toDraftPastedText(pasted: PastedTextFile): DraftPastedText {
  return {
    id: pasted.id,
    filePath: pasted.filePath,
    filename: pasted.filename,
    size: pasted.size,
    preview: pasted.preview,
  };
}

function base64ToBlobUrl(id: string, base64Data: string, type: string): string {
  const byteCharacters = atob(base64Data);
  const byteNumbers = new Array(byteCharacters.length);
  for (let i = 0; i < byteCharacters.length; i++) {
    byteNumbers[i] = byteCharacters.charCodeAt(i);
  }
  const url = URL.createObjectURL(new Blob([new Uint8Array(byteNumbers)], { type }));
  draftBlobUrls.set(id, [...(draftBlobUrls.get(id) || []), url]);
  return url;
}

/** Restore UploadedImage from DraftImage (creates a tracked blob URL) */
function fromDraftImage(draft: DraftImage): UploadedImage | null {
  if (!draft.base64Data) return null;
  try {
    return {
      id: draft.id,
      filename: draft.filename,
      url: base64ToBlobUrl(draft.id, draft.base64Data, draft.mediaType),
      base64Data: draft.base64Data,
      mediaType: draft.mediaType,
      isLoading: false,
    };
  } catch (_err) {
    return null;
  }
}

/** Restore UploadedFile from DraftFile (creates a tracked blob URL) */
function fromDraftFile(draft: DraftFile): UploadedFile | null {
  if (!draft.base64Data) return null;
  try {
    return {
      id: draft.id,
      filename: draft.filename,
      url: base64ToBlobUrl(draft.id, draft.base64Data, draft.type || 'application/octet-stream'),
      size: draft.size,
      type: draft.type,
      isLoading: false,
    };
  } catch (_err) {
    return null;
  }
}

function fromDraftTextContext(draft: DraftTextContext): SelectedTextContext {
  return {
    id: draft.id,
    text: draft.text,
    sourceMessageId: draft.sourceMessageId,
    preview: draft.preview,
    createdAt: new Date(draft.createdAt),
  };
}

/** `createdAt` is not rendered for pasted chips, so it is re-synthesised rather than stored. */
function fromDraftPastedText(draft: DraftPastedText): PastedTextFile {
  return { ...draft, createdAt: new Date() };
}

// Read / write

/** Hydrated draft — blob URLs and Dates rebuilt, ready to hand straight to composer state. */
export type FullDraftData = {
  text: string | null;
  images: UploadedImage[];
  files: UploadedFile[];
  textContexts: SelectedTextContext[];
  pastedTexts: PastedTextFile[];
  task: TaskData | null;
};

/** Composer state as the caller holds it, before persistence converts it. */
export type DraftState = {
  text: string;
  images?: UploadedImage[];
  files?: UploadedFile[];
  textContexts?: SelectedTextContext[];
  pastedTexts?: PastedTextFile[];
  task?: TaskData | null;
};

function toDraftContent(state: DraftState): DraftContent {
  const images = state.images?.map(toDraftImage).filter((i): i is DraftImage => i !== null) ?? [];
  const textContexts = state.textContexts?.map(toDraftTextContext) ?? [];
  const pastedTexts = state.pastedTexts?.map(toDraftPastedText) ?? [];
  return {
    text: state.text,
    updatedAt: Date.now(),
    ...(images.length > 0 && { images }),
    ...(textContexts.length > 0 && { textContexts }),
    ...(pastedTexts.length > 0 && { pastedTexts }),
    ...(state.task && { task: state.task }),
  };
}

/**
 * Read and hydrate a draft. Drops (and prunes) anything past STALE_DRAFT_MS.
 *
 * `revokePriorBlobUrls` releases the URLs a previous read of this same slot created, before making
 * new ones. Only safe when ONE component owns the slot — true for the new-chat composer, false for
 * sub-chats, where two panes can display the same chat and would revoke each other's live URLs.
 */
export function readDraft(key: string, revokePriorBlobUrls = false): FullDraftData | null {
  const drafts = loadGlobalDrafts();
  const draft = drafts[key];
  if (!draft) return null;

  if (revokePriorBlobUrls) revokeDraftAttachments(draft);

  return {
    text: draft.text || null,
    images: draft.images?.map(fromDraftImage).filter((i): i is UploadedImage => i !== null) ?? [],
    files: draft.files?.map(fromDraftFile).filter((f): f is UploadedFile => f !== null) ?? [],
    textContexts: draft.textContexts?.map(fromDraftTextContext) ?? [],
    pastedTexts: draft.pastedTexts?.map(fromDraftPastedText) ?? [],
    task: draft.task ?? null,
  };
}

/**
 * Read for the new-chat composer: its slot has exactly ONE owner, so prior blob URLs are released
 * before new ones are made and the staleness bound applies. Sub-chat drafts deliberately do NOT
 * expire — that path has always kept a reply indefinitely, and a paused chat is a normal reason to.
 */
export function readNewChatDraft(key: string): FullDraftData | null {
  const stamp = readDraftStamp(key);
  if (stamp !== null && Date.now() - stamp > STALE_DRAFT_MS) {
    clearDraft(key);
    return null;
  }
  return readDraft(key, true);
}

/** Synchronous whole-record write. Empty state deletes the slot rather than storing a husk. */
export function writeDraft(
  key: string,
  state: DraftState,
): 'saved' | 'attachments_skipped' | 'cleared' {
  bumpDraftWriteCount(key);
  return commitDraft(key, toDraftContent(state));
}

// Sub-chat wrappers

export function getSubChatDraftFull(chatId: string, subChatId: string): FullDraftData | null {
  return readDraft(getSubChatDraftKey(chatId, subChatId));
}

export function clearSubChatDraft(chatId: string, subChatId: string): void {
  const key = getSubChatDraftKey(chatId, subChatId);
  bumpDraftWriteCount(key);
  clearDraft(key);
}

/**
 * Save sub-chat draft with attachments (async — files must be read off their blob URLs first)
 */
export async function saveSubChatDraftWithAttachments(
  chatId: string,
  subChatId: string,
  text: string,
  options?: {
    images?: UploadedImage[];
    files?: UploadedFile[];
    textContexts?: SelectedTextContext[];
  },
): Promise<{ success: boolean; error?: string }> {
  const key = getSubChatDraftKey(chatId, subChatId);
  const writesAtEntry = draftWriteCount.get(key) ?? 0;

  const draftFiles = options?.files
    ? await Promise.all(options.files.map(toDraftFile)).then((results) =>
        results.filter((f): f is DraftFile => f !== null),
      )
    : [];

  // A SYNCHRONOUS writer got this slot while the attachments converted — its text is newer than the
  // copy captured above, so leave it alone; the next blur re-saves these attachments against it.
  // Two overlapping calls to this function do not bump, so they keep resolving last-write-wins.
  if ((draftWriteCount.get(key) ?? 0) !== writesAtEntry) return { success: true };

  const draft = toDraftContent({ text, ...options });
  if (draftFiles.length > 0) draft.files = draftFiles;

  const outcome = commitDraft(key, draft);
  if (outcome === 'attachments_skipped') return { success: true, error: 'attachments_skipped' };
  return { success: true };
}

/** Replace a slot's TEXT synchronously, keeping stored attachments byte-for-byte — an unmounting
 * composer cannot await, and an async write could land after a later clear and resurrect it.
 * `expireStale` opts the expiring new-chat slot into its staleness bound (see readNewChatDraft);
 * sub-chat slots never expire, so their callers must not pass it. */
export function replaceDraftText(key: string, text: string, expireStale = false): void {
  bumpDraftWriteCount(key);
  const stamp = expireStale ? readDraftStamp(key) : null;
  if (stamp !== null && Date.now() - stamp > STALE_DRAFT_MS) clearDraft(key);
  commitDraft(key, { ...loadGlobalDrafts()[key], text, updatedAt: Date.now() });
}

export function writeSubChatDraft(chatId: string, subChatId: string, state: DraftState): void {
  writeDraft(getSubChatDraftKey(chatId, subChatId), state);
}

export function saveSubChatDraftText(chatId: string, subChatId: string, text: string): void {
  replaceDraftText(getSubChatDraftKey(chatId, subChatId), text);
}
