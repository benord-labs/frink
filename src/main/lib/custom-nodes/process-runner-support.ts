export const PROCESS_TERMINATION_GRACE_MS = 500;

export function outputLimitMessage(
  nodeName: string,
  stream: 'stdout' | 'stderr',
  maxBuffer: number,
): string {
  return `Custom node "${nodeName}" exceeded the ${maxBuffer}-byte ${stream} output limit. Reduce emitted output or increase the configured limit.`;
}

export function bufferFromChunk(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  return Buffer.from(String(chunk), 'utf8');
}

export function sendHardKill(pid: number | undefined): 'sent' | 'gone' | 'retry' {
  if (typeof pid !== 'number') return 'retry';
  try {
    process.kill(pid, 'SIGKILL');
    return 'sent';
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code: unknown }).code)
        : undefined;
    return code === 'ESRCH' ? 'gone' : 'retry';
  }
}
