// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UploadedImage } from '../hooks/use-agents-file-upload';
import type { PastedTextFile } from '../hooks/use-pasted-text-files';
import {
  clearDraft,
  clearDraftIfUnchanged,
  clearSubChatDraft,
  getSubChatDraftFull,
  hasDraftContent,
  newChatDraftKey,
  readDraft,
  readDraftStamp,
  readNewChatDraft,
  saveSubChatDraftText,
  saveSubChatDraftWithAttachments,
  writeDraft,
} from './drafts';

const STORAGE_KEY = 'agent-drafts-global';
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/** `null` means "upload finished without base64" — an explicit `undefined` would hit the default. */
function makeImage(id: string, base64Data: string | null = 'aGk='): UploadedImage {
  return {
    id,
    filename: `${id}.png`,
    url: `blob:seed-${id}`,
    isLoading: false,
    mediaType: 'image/png',
    base64Data: base64Data ?? undefined,
  };
}

function makePasted(id: string): PastedTextFile {
  return {
    id,
    filePath: `/tmp/${id}.txt`,
    filename: `${id}.txt`,
    size: 42,
    preview: 'hello',
    createdAt: new Date(),
  };
}

/** Write a slot straight to storage so a test can control `updatedAt`. */
function seedRaw(key: string, content: Record<string, unknown>): void {
  const drafts = readRaw();
  drafts[key] = { updatedAt: Date.now(), ...content };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(drafts));
}

/** The whole stored map, for asserting on slots the public API deliberately hides. */
function readRaw(): Record<string, Record<string, unknown> & { text?: string }> {
  return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
}

describe('drafts store', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn(() => `blob:mock-${Math.random()}`),
      revokeObjectURL: vi.fn(),
    });
  });

  describe('round trip', () => {
    it('restores text, images, pasted texts and task', () => {
      const key = newChatDraftKey(0);
      writeDraft(key, {
        text: 'hello world',
        images: [makeImage('img-1')],
        pastedTexts: [makePasted('p-1')],
        task: { id: 't-1', title: 'Ticket', description: 'Do the thing' },
      });

      const restored = readDraft(key);
      expect(restored?.text).toBe('hello world');
      expect(restored?.images).toHaveLength(1);
      expect(restored?.images[0]?.base64Data).toBe('aGk=');
      expect(restored?.pastedTexts).toHaveLength(1);
      expect(restored?.pastedTexts[0]?.filePath).toBe('/tmp/p-1.txt');
      expect(restored?.task?.title).toBe('Ticket');
    });

    it('rebuilds a blob url for each restored image', () => {
      const key = newChatDraftKey(0);
      writeDraft(key, { text: '', images: [makeImage('img-1')] });
      expect(readDraft(key)?.images[0]?.url).toMatch(/^blob:mock-/);
    });

    it('drops an image that never finished base64 conversion rather than storing it broken', () => {
      const key = newChatDraftKey(0);
      writeDraft(key, { text: 'text', images: [makeImage('img-1', null)] });
      expect(readDraft(key)?.images).toHaveLength(0);
      expect(readDraft(key)?.text).toBe('text');
    });
  });

  describe('emptiness', () => {
    it('deletes the slot when nothing is left, rather than storing a husk', () => {
      const key = newChatDraftKey(0);
      writeDraft(key, { text: 'something' });
      expect(writeDraft(key, { text: '   ' })).toBe('cleared');
      expect(readDraft(key)).toBeNull();
      expect(readRaw()[key]).toBeUndefined();
    });

    it('keeps a slot that has attachments but no text', () => {
      const key = newChatDraftKey(0);
      expect(writeDraft(key, { text: '', images: [makeImage('img-1')] })).toBe('saved');
      expect(readDraft(key)?.images).toHaveLength(1);
    });

    it('keeps a slot that has only an attached task', () => {
      const key = newChatDraftKey(0);
      writeDraft(key, { text: '', task: { id: 't', title: 'T', description: '' } });
      expect(readDraft(key)?.task?.id).toBe('t');
    });

    it('keeps a slot that has only pasted text', () => {
      const key = newChatDraftKey(0);
      writeDraft(key, { text: '', pastedTexts: [makePasted('p-1')] });
      expect(readDraft(key)?.pastedTexts).toHaveLength(1);
    });

    // The sub-chat composer is the only writer of these two, so they need their own emptiness
    // cases — a text-less draft carrying either must survive rather than be swept as empty.
    it('keeps a sub-chat slot that has only a selected text context', () => {
      writeDraft('chat-1:sub-1', {
        text: '',
        textContexts: [
          {
            id: 'ctx-1',
            text: 'selected words',
            sourceMessageId: 'msg-1',
            preview: 'selected',
            createdAt: new Date(),
          },
        ],
      });
      expect(getSubChatDraftFull('chat-1', 'sub-1')?.textContexts).toHaveLength(1);
    });

    it('keeps an uploaded file when the sub-chat text is emptied', () => {
      seedRaw('chat-1:sub-1', {
        text: 'about to be deleted',
        files: [{ id: 'f-1', filename: 'notes.txt', base64Data: 'aGk=', type: 'text/plain' }],
      });

      saveSubChatDraftText('chat-1', 'sub-1', '');

      const restored = getSubChatDraftFull('chat-1', 'sub-1');
      expect(restored?.text).toBeNull();
      expect(restored?.files).toHaveLength(1);
    });
  });

  describe('storage budget', () => {
    // ~1.4MB of base64 per image; four would blow the 4MB cap if counted twice.
    const bigImage = (id: string) => makeImage(id, 'a'.repeat(700_000));

    it('does not trip the cap by re-saving the same slot repeatedly', () => {
      const key = newChatDraftKey(0);
      for (let i = 0; i < 10; i++) {
        expect(writeDraft(key, { text: `tick ${i}`, images: [bigImage('img-1')] })).toBe('saved');
      }
      expect(readDraft(key)?.images).toHaveLength(1);
    });

    it('does not trip the cap by re-saving the same SUB-CHAT slot repeatedly', async () => {
      for (let i = 0; i < 10; i++) {
        await saveSubChatDraftWithAttachments('chat-1', 'sub-1', `tick ${i}`, {
          images: [bigImage('img-1')],
        });
      }
      expect(getSubChatDraftFull('chat-1', 'sub-1')?.images).toHaveLength(1);
    });

    it('degrades to text-only when genuinely over budget, keeping pasted texts and task', () => {
      seedRaw('chat-x:sub-x', { text: 'x'.repeat(1_600_000) });
      const key = newChatDraftKey(0);
      const outcome = writeDraft(key, {
        text: 'keep me',
        images: [bigImage('img-1')],
        pastedTexts: [makePasted('p-1')],
        task: { id: 't', title: 'T', description: '' },
      });
      expect(outcome).toBe('attachments_skipped');
      const restored = readDraft(key);
      expect(restored?.text).toBe('keep me');
      expect(restored?.images).toHaveLength(0);
      expect(restored?.pastedTexts).toHaveLength(1);
      expect(restored?.task?.id).toBe('t');
    });
  });

  describe('stamped clearing', () => {
    it('clears when the slot still holds the stamped copy', () => {
      const key = newChatDraftKey(0);
      writeDraft(key, { text: 'mine' });
      const stamp = readDraftStamp(key);

      expect(clearDraftIfUnchanged(key, stamp)).toBe(true);
      expect(readDraft(key)).toBeNull();
    });

    it('refuses when someone else has written since', () => {
      const key = newChatDraftKey(0);
      writeDraft(key, { text: 'mine' });
      const stamp = readDraftStamp(key);
      seedRaw(key, { text: 'theirs', updatedAt: (stamp ?? 0) + 1 });

      expect(clearDraftIfUnchanged(key, stamp)).toBe(false);
      expect(readDraft(key)?.text).toBe('theirs');
    });

    it('refuses without a stamp, and reports none for an empty slot', () => {
      const key = newChatDraftKey(0);
      expect(readDraftStamp(key)).toBeNull();
      writeDraft(key, { text: 'mine' });
      expect(clearDraftIfUnchanged(key, null)).toBe(false);
      expect(readDraft(key)?.text).toBe('mine');
    });
  });

  describe('slot isolation', () => {
    it('keeps new-chat and sub-chat drafts independent', () => {
      writeDraft(newChatDraftKey(0), { text: 'new chat text' });
      saveSubChatDraftText('chat-1', 'sub-1', 'sub chat text');

      expect(readDraft(newChatDraftKey(0))?.text).toBe('new chat text');
      expect(getSubChatDraftFull('chat-1', 'sub-1')?.text).toBe('sub chat text');

      clearSubChatDraft('chat-1', 'sub-1');
      expect(readDraft(newChatDraftKey(0))?.text).toBe('new chat text');
    });

    it('keeps each pane independent', () => {
      writeDraft(newChatDraftKey(0), { text: 'left' });
      writeDraft(newChatDraftKey(1), { text: 'right' });
      expect(readDraft(newChatDraftKey(0))?.text).toBe('left');
      expect(readDraft(newChatDraftKey(1))?.text).toBe('right');
    });

    it('treats the non-split composer and pane 0 as the same surface', () => {
      writeDraft(newChatDraftKey(undefined), { text: 'typed at home' });
      expect(readDraft(newChatDraftKey(0))?.text).toBe('typed at home');
    });

    it('never collides with a chatId:subChatId key', () => {
      expect(newChatDraftKey(0)).not.toContain(':');
    });

    // The same value names a directory under userData/claude-sessions/<id>/pasted/, and the server
    // rejects traversal characters. Colons are legal there but illegal in Windows directory names.
    it('is safe to use as a directory name on every platform', () => {
      for (const index of [undefined, 0, 1, 3]) {
        const key = newChatDraftKey(index);
        expect(key).not.toMatch(/[:/\\]/);
        expect(key).not.toContain('..');
      }
    });
  });

  // A half-written or hand-edited storage entry must degrade to "no draft", never crash the
  // composer — the store is the first thing the composer touches on mount.
  describe('malformed storage', () => {
    const CORRUPT = ['null', 'not json at all', '"just a string"', '42', '[]'];

    it.each(CORRUPT)('reads through corrupt storage (%s) without throwing', (raw) => {
      localStorage.setItem(STORAGE_KEY, raw);
      expect(() => readDraft(newChatDraftKey(0))).not.toThrow();
      expect(readDraft(newChatDraftKey(0))).toBeNull();
    });

    it.each(CORRUPT)('writes over corrupt storage (%s) without throwing', (raw) => {
      localStorage.setItem(STORAGE_KEY, raw);
      expect(() => writeDraft(newChatDraftKey(0), { text: 'recovered' })).not.toThrow();
      expect(readDraft(newChatDraftKey(0))?.text).toBe('recovered');
    });

    it.each(CORRUPT)('clears through corrupt storage (%s) without throwing', (raw) => {
      localStorage.setItem(STORAGE_KEY, raw);
      expect(() => clearDraft(newChatDraftKey(0))).not.toThrow();
    });

    it('survives a slot whose stored shape lost its fields', () => {
      seedRaw(newChatDraftKey(0), { text: undefined, updatedAt: undefined });
      expect(() => readDraft(newChatDraftKey(0))).not.toThrow();
    });
  });

  describe('legacy pruning', () => {
    it('drops orphaned draft-* entries on the next write without touching live slots', () => {
      seedRaw('draft-1700000000000-abc123', { text: 'orphan' });
      seedRaw('chat-1:sub-1', { text: 'sub chat' });
      writeDraft(newChatDraftKey(0), { text: 'new' });

      const stored = readRaw();
      expect(stored['draft-1700000000000-abc123']).toBeUndefined();
      expect(stored['chat-1:sub-1']?.text).toBe('sub chat');
      expect(stored[newChatDraftKey(0)]?.text).toBe('new');
    });
  });

  describe('staleness', () => {
    it('ignores and prunes a new-chat draft older than the retention window', () => {
      const key = newChatDraftKey(0);
      seedRaw(key, { text: 'ancient', updatedAt: Date.now() - SEVEN_DAYS_MS - 1000 });
      expect(readNewChatDraft(key)).toBeNull();
      expect(readRaw()[key]).toBeUndefined();
    });

    it('keeps a new-chat draft inside the retention window', () => {
      const key = newChatDraftKey(0);
      seedRaw(key, { text: 'recent', updatedAt: Date.now() - SEVEN_DAYS_MS + 60_000 });
      expect(readNewChatDraft(key)?.text).toBe('recent');
    });

    // Sub-chat replies have always been kept indefinitely; a long-paused project chat is a normal
    // reason to leave one sitting, so the new-chat expiry must not reach them.
    it('never expires a sub-chat draft, however old', () => {
      seedRaw('chat-1:sub-1', {
        text: 'left for a fortnight',
        updatedAt: Date.now() - SEVEN_DAYS_MS * 2,
      });
      expect(getSubChatDraftFull('chat-1', 'sub-1')?.text).toBe('left for a fortnight');
      expect(readRaw()['chat-1:sub-1']).toBeDefined();
    });
  });

  // Blob-url bookkeeping is module-level and keyed by image id, so every case here needs an id no
  // other test has used.
  describe('blob url lifecycle', () => {
    it('revokes the previous url before recreating one on a repeat read', () => {
      const key = newChatDraftKey(0);
      writeDraft(key, { text: '', images: [makeImage('blob-repeat-read')] });

      readDraft(key, true);
      expect(URL.revokeObjectURL).not.toHaveBeenCalled();
      readDraft(key, true);
      expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
      readDraft(key, true);
      expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
    });

    it('leaves prior urls alone when the slot may have more than one reader', () => {
      const key = 'chat-1:sub-1';
      writeDraft(key, { text: '', images: [makeImage('blob-shared-reader')] });
      readDraft(key);
      readDraft(key);
      expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    });

    it('revokes on clear', () => {
      const key = newChatDraftKey(0);
      writeDraft(key, { text: '', images: [makeImage('blob-on-clear')] });
      readDraft(key);
      clearDraft(key);
      expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
    });
  });

  describe('interleaving with the async sub-chat save', () => {
    it('does not blind-write over a new-chat draft saved while it was converting', async () => {
      const pending = saveSubChatDraftWithAttachments('chat-1', 'sub-1', 'sub chat text', {
        images: [makeImage('interleave-img')],
      });
      writeDraft(newChatDraftKey(0), { text: 'typed during the await' });
      await pending;

      expect(readDraft(newChatDraftKey(0))?.text).toBe('typed during the await');
      expect(getSubChatDraftFull('chat-1', 'sub-1')?.text).toBe('sub chat text');
    });

    it('yields its own slot to a synchronous writer that landed first', async () => {
      const pending = saveSubChatDraftWithAttachments('chat-1', 'sub-1', 'stale text', {
        images: [makeImage('interleave-bail')],
      });
      // A composer unmount writing the same slot synchronously — newer than the captured copy.
      saveSubChatDraftText('chat-1', 'sub-1', 'newer text');
      await pending;

      expect(getSubChatDraftFull('chat-1', 'sub-1')?.text).toBe('newer text');
    });
  });

  describe('sub-chat text save', () => {
    it('never expires the slot: a week-old draft keeps its attachments through a text save', async () => {
      await saveSubChatDraftWithAttachments('chat-1', 'sub-1', 'first', {
        images: [makeImage('img-old')],
      });
      vi.useFakeTimers();
      try {
        vi.advanceTimersByTime(8 * 24 * 60 * 60 * 1000);
        saveSubChatDraftText('chat-1', 'sub-1', 'second');
      } finally {
        vi.useRealTimers();
      }

      const restored = getSubChatDraftFull('chat-1', 'sub-1');
      expect(restored?.text).toBe('second');
      expect(restored?.images).toHaveLength(1);
    });

    it('preserves attachments already stored for that slot', async () => {
      await saveSubChatDraftWithAttachments('chat-1', 'sub-1', 'first', {
        images: [makeImage('img-1')],
      });
      saveSubChatDraftText('chat-1', 'sub-1', 'second');

      const restored = getSubChatDraftFull('chat-1', 'sub-1');
      expect(restored?.text).toBe('second');
      expect(restored?.images).toHaveLength(1);
    });

    it('clears the slot when the text empties and nothing else remains', () => {
      saveSubChatDraftText('chat-1', 'sub-1', 'something');
      saveSubChatDraftText('chat-1', 'sub-1', '');
      expect(getSubChatDraftFull('chat-1', 'sub-1')).toBeNull();
    });
  });
});

describe('hasDraftContent', () => {
  const empty = {
    text: null,
    images: [],
    files: [],
    textContexts: [],
    pastedTexts: [],
    task: null,
  };

  it.each([
    ['an empty draft', empty],
    ['whitespace-only text', { ...empty, text: '  \n ' }],
  ])('is false for %s', (_label, draft) => {
    expect(hasDraftContent(draft)).toBe(false);
  });

  it.each([
    ['text', { ...empty, text: 'edited' }],
    ['only an image', { ...empty, images: [{ id: 'i' } as UploadedImage] }],
    ['only a file', { ...empty, files: [{ id: 'f' } as never] }],
    ['only an attached task', { ...empty, task: { id: 't' } as never }],
  ])('is true for %s', (_label, draft) => {
    expect(hasDraftContent(draft)).toBe(true);
  });
});
