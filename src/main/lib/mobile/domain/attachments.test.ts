import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ userData: '', requireChat: vi.fn() }));

vi.mock('electron', () => ({ app: { getPath: () => fixture.userData } }));
vi.mock('./context', async () => ({
  MobileApiError: (await import('./errors')).MobileApiError,
  requireChat: fixture.requireChat,
}));

import {
  __resetMobileAttachments,
  MOBILE_IMAGE_MAX_BYTES,
  resolveMobileAttachments,
  safeAttachmentName,
  storeMobileAttachment,
} from './attachments';
import { MobileApiError } from './errors';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const target = { chatId: 'chat-1', subChatId: 'mq7zk90vzeoypywd' };
const upload = (over: Partial<Parameters<typeof storeMobileAttachment>[0]> = {}) =>
  storeMobileAttachment({
    ...target,
    name: 'photo.png',
    mimeType: 'image/png',
    bytes: PNG,
    ...over,
  });

describe('mobile attachments', () => {
  beforeEach(() => {
    fixture.userData = mkdtempSync(join(tmpdir(), 'frink-mobile-attachments-'));
    fixture.requireChat.mockResolvedValue({});
    __resetMobileAttachments();
  });

  afterEach(() => rmSync(fixture.userData, { recursive: true, force: true }));

  it('stores into the sub-chat pasted folder the agent can already read', async () => {
    const stored = await upload({
      name: 'notes.txt',
      mimeType: 'text/plain',
      bytes: new Uint8Array([104, 105]),
    });
    expect(stored).toMatchObject({ kind: 'file', name: 'notes.txt', size: 2 });

    const { fileMentions } = await resolveMobileAttachments([stored.id], target);
    const path = /\|(.+)\]$/.exec(fileMentions[0])?.[1] ?? '';
    expect(
      path.startsWith(join(fixture.userData, 'claude-sessions', 'mq7zk90vzeoypywd', 'pasted')),
    ).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe('hi');
    expect(fileMentions[0]).toMatch(/^@\[pasted:2:notes\.txt\|/);
  });

  it('decides "image" from the bytes, not the declared type', async () => {
    expect((await upload({ mimeType: 'application/octet-stream' })).kind).toBe('image');
    expect(
      (await upload({ name: 'fake.png', mimeType: 'image/png', bytes: new Uint8Array([1, 2, 3]) }))
        .kind,
    ).toBe('file');
  });

  it('sends an image inline and removes its file once the send is accepted', async () => {
    const stored = await upload();
    const resolved = await resolveMobileAttachments([stored.id], target);
    expect(resolved.imageParts).toEqual([
      { type: 'file', mimeType: 'image/png', data: Buffer.from(PNG).toString('base64') },
    ]);

    await resolved.release();
    await expect(resolveMobileAttachments([stored.id], target)).rejects.toBeInstanceOf(
      MobileApiError,
    );
  });

  it('refuses an id uploaded for a different chat', async () => {
    const stored = await upload();
    await expect(
      resolveMobileAttachments([stored.id], { chatId: 'chat-1', subChatId: 'other' }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('rejects oversize images, empty files and unsafe session ids before writing', async () => {
    const big = new Uint8Array(MOBILE_IMAGE_MAX_BYTES + 1);
    big.set(PNG);
    await expect(upload({ bytes: big })).rejects.toMatchObject({ status: 422 });
    await expect(upload({ bytes: new Uint8Array() })).rejects.toMatchObject({ status: 400 });
    await expect(upload({ subChatId: '../escape' })).rejects.toMatchObject({ status: 400 });
    expect(existsSync(join(fixture.userData, 'claude-sessions'))).toBe(false);
  });

  it('keeps names safe on disk and inside a mention token', () => {
    expect(safeAttachmentName('../../etc/passwd')).toBe('_.._etc_passwd');
    expect(safeAttachmentName('a[b]|c.pdf')).toBe('a_b__c.pdf');
    expect(safeAttachmentName('   ')).toBe('attachment');
  });
});
