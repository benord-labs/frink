/** Phone attachments: raw-body uploads referenced by id in `sendMessage`, stored in the sub-chat's
 *  agent-readable `pasted/` folder, sent as image parts or the desktop's pasted-file mention. */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { app } from 'electron';
import type { MobileAttachment } from '../../../../shared/types/remote/mobile';
import { isValidSubChatIdForSessionPaths } from '../../claude/session-plan-paths';
import { MobileApiError, requireChat } from './context';

/** Claude rejects larger images; the phone resizes before upload so this is a backstop. */
export const MOBILE_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const MOBILE_FILE_MAX_BYTES = 20 * 1024 * 1024;
/** An upload that is never sent is deleted after this long. */
const UPLOAD_TTL_MS = 60 * 60 * 1000;

const IMAGE_SIGNATURES: Array<{ mimeType: string; matches: (b: Uint8Array) => boolean }> = [
  { mimeType: 'image/png', matches: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e },
  { mimeType: 'image/jpeg', matches: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mimeType: 'image/gif', matches: (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 },
  {
    mimeType: 'image/webp',
    matches: (b) =>
      b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42,
  },
];

type StoredUpload = MobileAttachment & {
  chatId: string;
  subChatId: string;
  path: string;
  mimeType: string;
  expiresAt: number;
};

const uploads = new Map<string, StoredUpload>();

/** A name safe to put on disk and inside a `[...]` mention token. */
export function safeAttachmentName(name: string): string {
  const cleaned = name
    .normalize('NFC')
    .replace(/[/\\[\]|\0-\x1f]/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 120);
  return cleaned || 'attachment';
}

function detectImage(bytes: Uint8Array): string | null {
  return IMAGE_SIGNATURES.find((signature) => signature.matches(bytes))?.mimeType ?? null;
}

async function sweepExpired(now: number): Promise<void> {
  for (const [id, upload] of uploads) {
    if (upload.expiresAt > now) continue;
    uploads.delete(id);
    await rm(upload.path, { force: true }).catch(() => {});
  }
}

export async function storeMobileAttachment(input: {
  chatId: string;
  subChatId: string;
  name: string;
  mimeType: string;
  bytes: Uint8Array;
}): Promise<MobileAttachment> {
  if (!isValidSubChatIdForSessionPaths(input.subChatId)) {
    throw new MobileApiError(400, 'Chat session not found.');
  }
  await requireChat(input.chatId, input.subChatId);
  if (input.bytes.byteLength === 0) throw new MobileApiError(400, 'The file is empty.');
  await sweepExpired(Date.now());

  // Trust the bytes, not the declared type: only a real image travels as an image part.
  const imageType = detectImage(input.bytes);
  const kind = imageType ? 'image' : 'file';
  const limit = kind === 'image' ? MOBILE_IMAGE_MAX_BYTES : MOBILE_FILE_MAX_BYTES;
  if (input.bytes.byteLength > limit) {
    throw new MobileApiError(422, `Attachments must be under ${limit / (1024 * 1024)} MB.`);
  }

  const id = randomUUID();
  const name = safeAttachmentName(input.name);
  const dir = join(app.getPath('userData'), 'claude-sessions', input.subChatId, 'pasted');
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${id.slice(0, 8)}-${name}`);
  await writeFile(path, input.bytes);

  const attachment: MobileAttachment = { id, kind, name, size: input.bytes.byteLength };
  uploads.set(id, {
    ...attachment,
    chatId: input.chatId,
    subChatId: input.subChatId,
    path,
    mimeType: imageType ?? (input.mimeType || 'application/octet-stream'),
    expiresAt: Date.now() + UPLOAD_TTL_MS,
  });
  return attachment;
}

export type ResolvedAttachments = {
  /** Inline image parts, the shape the desktop composer sends. */
  imageParts: Array<{ type: 'file'; mimeType: string; data: string }>;
  /** Path tokens for other files, the desktop's large-paste mention (drawn as a chip). */
  fileMentions: string[];
  /** Call after the send was accepted, so a failed send can be retried with the same ids. */
  release: () => Promise<void>;
};

export async function resolveMobileAttachments(
  ids: readonly string[],
  target: { chatId: string; subChatId: string },
): Promise<ResolvedAttachments> {
  const now = Date.now();
  const claimed = ids.map((id) => {
    const upload = uploads.get(id);
    if (
      !upload ||
      upload.expiresAt <= now ||
      upload.chatId !== target.chatId ||
      upload.subChatId !== target.subChatId
    ) {
      throw new MobileApiError(409, 'An attachment expired. Remove it and attach it again.');
    }
    return upload;
  });
  const imageParts = await Promise.all(
    claimed
      .filter((upload) => upload.kind === 'image')
      .map(async (upload) => ({
        type: 'file' as const,
        mimeType: upload.mimeType,
        data: (await readFile(upload.path)).toString('base64'),
      })),
  );
  const fileMentions = claimed
    .filter((upload) => upload.kind === 'file')
    .map((upload) => `@[pasted:${upload.size}:${upload.name}|${upload.path}]`);
  return {
    imageParts,
    fileMentions,
    release: async () => {
      for (const upload of claimed) {
        uploads.delete(upload.id);
        // The image now lives inline in the transcript; files stay for the agent to Read.
        if (upload.kind === 'image') await rm(upload.path, { force: true }).catch(() => {});
      }
    },
  };
}

/** Test-only reset. */
export function __resetMobileAttachments(): void {
  uploads.clear();
}
