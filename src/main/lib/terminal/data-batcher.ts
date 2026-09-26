import { StringDecoder } from 'node:string_decoder';

/**
 * Batches terminal data to reduce IPC overhead between main and renderer processes.
 * Based on Hyper terminal's DataBatcher implementation.
 *
 * This minimizes the number of IPC messages by:
 * 1. Time-based batching: Flushes every BATCH_DURATION_MS (16ms = ~60fps)
 * 2. Size-based batching: Flushes when batch exceeds BATCH_MAX_SIZE (200KB)
 * 3. Proper UTF-8 handling: Uses StringDecoder to handle multi-byte characters
 *    that may be split across data chunks
 */

const BATCH_DURATION_MS = 16;
const BATCH_MAX_SIZE = 200 * 1024;

export class DataBatcher {
  private decoder: StringDecoder;
  private buffer: string = '';
  private timeout: ReturnType<typeof setTimeout> | null = null;
  private onFlush: (data: string) => void;
  private disposed = false;

  constructor(onFlush: (data: string) => void) {
    this.decoder = new StringDecoder('utf8');
    this.onFlush = onFlush;
  }

  /**
   * Add data to the batch. Data will be flushed either when:
   * - BATCH_DURATION_MS has elapsed since the first write
   * - Buffer size exceeds BATCH_MAX_SIZE
   */
  write(data: Buffer | string): void {
    if (this.disposed) {
      return;
    }
    const decoded = typeof data === 'string' ? data : this.decoder.write(data);
    this.buffer += decoded;

    if (this.buffer.length >= BATCH_MAX_SIZE) {
      this.flush();
      return;
    }

    if (this.timeout === null) {
      this.timeout = setTimeout(() => this.flush(), BATCH_DURATION_MS);
    }
  }

  /**
   * Flush any buffered data immediately.
   */
  flush(): void {
    if (this.timeout !== null) {
      clearTimeout(this.timeout);
      this.timeout = null;
    }

    if (this.buffer.length > 0) {
      this.onFlush(this.buffer);
      this.buffer = '';
    }
  }

  /**
   * Dispose of the batcher, flushing any remaining data.
   * Calls decoder.end() to handle any trailing incomplete sequences.
   * Idempotent: safe when pty exit handlers or cleanup run dispose more than once.
   */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.flush();

    // Flush any incomplete multi-byte sequences
    const remaining = this.decoder.end();
    if (remaining) {
      this.onFlush(remaining);
    }
  }
}
