import { constants } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { MAX_TEXT_FILE_BYTES } from '../../../../shared/text-file-limits';

/** The path is not a regular file (directory, device, FIFO, socket). */
export class NotAFileError extends Error {
  constructor() {
    super('Not a file');
    this.name = 'NotAFileError';
  }
}

/** Thrown when a file holds more than the caller's byte cap. */
export class FileTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`File too large to display (max ${Math.floor(maxBytes / (1024 * 1024))}MB)`);
    this.name = 'FileTooLargeError';
  }
}

// O_NONBLOCK stops open() waiting for a FIFO writer; Windows has no such flag.
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0);

/** UTF-8 read capped on bytes actually read (a growing file can't beat it); fstat on the handle
 * catches a path swapped after the caller's stat. Decoded once so split characters survive. */
export async function readTextFileBounded(
  filePath: string,
  maxBytes: number,
  chunkBytes = 64 * 1024,
): Promise<string> {
  const handle = await open(filePath, OPEN_FLAGS);
  try {
    if (!(await handle.stat()).isFile()) {
      throw new NotAFileError();
    }

    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const chunk = Buffer.alloc(chunkBytes);
      const { bytesRead } = await handle.read(chunk, 0, chunkBytes, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) {
        throw new FileTooLargeError(maxBytes);
      }
      chunks.push(bytesRead === chunkBytes ? chunk : chunk.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, total).toString('utf-8');
  } finally {
    await handle.close();
  }
}

/** files.readFile: refuse non-files and >MAX_TEXT_FILE_BYTES so main never hangs or OOMs.
 * Guard errors reach the editor verbatim; anything else becomes "Failed to read file: …". */
export async function readEditorTextFile(filePath: string): Promise<string> {
  try {
    // stat() never blocks, even on a FIFO or device, so non-files are refused before open().
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) {
      throw new NotAFileError();
    }
    if (fileStat.size > MAX_TEXT_FILE_BYTES) {
      throw new FileTooLargeError(MAX_TEXT_FILE_BYTES);
    }
    return await readTextFileBounded(filePath, MAX_TEXT_FILE_BYTES);
  } catch (error) {
    if (error instanceof NotAFileError || error instanceof FileTooLargeError) {
      throw error;
    }
    throw new Error(
      `Failed to read file: ${error instanceof Error ? error.message : 'Unknown error'}`,
    );
  }
}
