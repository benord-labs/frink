import { createHash } from 'node:crypto';
import { type FileHandle, open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  type CodexState,
  codexStateSchema,
  initialCodexState,
  parseClaudeLine,
  parseCodexLine,
  parseCodexOrigin,
  USAGE_LINE_MARKERS,
  type UsageProvider,
  type UsageRecord,
} from './transcripts';

/** Reads transcripts from disk incrementally: a re-scan parses only the bytes appended since the
 * last read, never the whole file again. */

export type TranscriptFile = { path: string; size: number; mtimeMs: number };

/** Where a read stopped. Persisted in the scan cache, so numbers and hashes only, never content. */
export const parsePositionSchema = z.object({
  /** Bytes consumed: the end of the last complete line. */
  offset: z.number(),
  /** Hash of the bytes just before `offset`. A file that no longer holds them there was rewritten
   * or truncated, so it is read again from the start. */
  tail: z.string(),
  /** Codex parse state at `offset`; null for Claude, whose lines stand alone. */
  codex: codexStateSchema.nullable(),
});
export type ParsePosition = z.infer<typeof parsePositionSchema>;

const CHUNK_BYTES = 1 << 20;
const TAIL_BYTES = 1024;
const NEWLINE = 0x0a;

const MARKERS: Record<UsageProvider, Buffer[]> = {
  claude: USAGE_LINE_MARKERS.claude.map((m) => Buffer.from(m)),
  codex: USAGE_LINE_MARKERS.codex.map((m) => Buffer.from(m)),
};

function isErrno(err: unknown, code: string): err is NodeJS.ErrnoException {
  return err instanceof Error && (err as NodeJS.ErrnoException).code === code;
}

async function collect(dir: string, out: TranscriptFile[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return collect(path, out);
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) return;
      const { size, mtimeMs } = await stat(path);
      out.push({ path, size, mtimeMs });
    }),
  );
}

/** Every `*.jsonl` under `root`. `[]` when `root` doesn't exist; null when the walk fails in any
 * other way (a subfolder vanishing mid-walk included), which must never read as deletions. */
export async function listTranscriptFiles(root: string): Promise<TranscriptFile[] | null> {
  const files: TranscriptFile[] = [];
  try {
    await collect(root, files);
    return files;
  } catch (err) {
    return isErrno(err, 'ENOENT') && err.path === root ? [] : null;
  }
}

/** Calls `onLine` per newline-terminated line from byte `from`, reading bounded chunks; stops when
 * it returns false. An unfinished last line is left unread. */
async function forEachLine(
  handle: FileHandle,
  from: number,
  onLine: (line: Buffer, start: number) => boolean | void,
): Promise<void> {
  let pending = Buffer.alloc(0);
  let pendingStart = from;
  for (let position = from; ;) {
    const chunk = Buffer.allocUnsafe(CHUNK_BYTES);
    const { bytesRead } = await handle.read(chunk, 0, CHUNK_BYTES, position);
    if (bytesRead === 0) return;
    position += bytesRead;
    const data = Buffer.concat([pending, chunk.subarray(0, bytesRead)]);
    let start = 0;
    for (let end = data.indexOf(NEWLINE); end !== -1; end = data.indexOf(NEWLINE, start)) {
      if (onLine(data.subarray(start, end), pendingStart + start) === false) return;
      start = end + 1;
    }
    pending = data.subarray(start);
    pendingStart += start;
  }
}

async function tailHash(handle: FileHandle, offset: number): Promise<string> {
  const length = Math.min(offset, TAIL_BYTES);
  const buffer = Buffer.alloc(length);
  if (length > 0) await handle.read(buffer, 0, length, offset - length);
  return createHash('sha256').update(buffer).digest('base64url');
}

/** Who started a Codex rollout, from its first line. Null means "not known yet" (unreadable, or
 * the first line is still being written), never a verdict. */
export async function readCodexOrigin(
  path: string,
): Promise<{ fromFrink: boolean; subagent: boolean } | null> {
  let handle: FileHandle | null = null;
  try {
    handle = await open(path, 'r');
    let first: string | null = null;
    await forEachLine(handle, 0, (line) => {
      first = line.toString('utf8');
      return false;
    });
    return first === null ? null : parseCodexOrigin(first);
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

/** True when the file still holds the bytes `position` ended on, i.e. it was only appended to. */
async function continues(handle: FileHandle, position: ParsePosition): Promise<boolean> {
  const { size } = await handle.stat();
  return size >= position.offset && (await tailHash(handle, position.offset)) === position.tail;
}

async function parseFrom(
  handle: FileHandle,
  provider: UsageProvider,
  offset: number,
  codex: CodexState | null,
): Promise<{ records: UsageRecord[]; position: ParsePosition }> {
  const records: UsageRecord[] = [];
  const markers = MARKERS[provider];
  let consumed = offset;
  await forEachLine(handle, offset, (line, start) => {
    consumed = start + line.length + 1;
    if (!markers.some((marker) => line.includes(marker))) return;
    const text = line.toString('utf8');
    const record = codex ? parseCodexLine(text, codex, start === 0) : parseClaudeLine(text);
    if (record) records.push(record);
  });
  return { records, position: { offset: consumed, tail: await tailHash(handle, consumed), codex } };
}

/** Records appended since `resumeFrom` (`resumed: true`), else the whole file, as when it was
 * rewritten or truncated. Null when unreadable, which never means "no usage". */
export async function readTranscript(
  path: string,
  provider: UsageProvider,
  resumeFrom?: ParsePosition,
): Promise<{ records: UsageRecord[]; position: ParsePosition; resumed: boolean } | null> {
  let handle: FileHandle | null = null;
  try {
    handle = await open(path, 'r');
    const from = resumeFrom && (await continues(handle, resumeFrom)) ? resumeFrom : null;
    const codex = provider === 'codex' ? { ...(from?.codex ?? initialCodexState()) } : null;
    const read = await parseFrom(handle, provider, from?.offset ?? 0, codex);
    return { ...read, resumed: from !== null };
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}
