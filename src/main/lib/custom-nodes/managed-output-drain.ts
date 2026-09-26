import type { Readable } from 'node:stream';

const MANAGED_OUTPUT_DRAIN_TIMEOUT_MS = 500;

type ManagedOutputDrainOptions = {
  nodeName: string;
  stdout: Readable;
  stderr: Readable;
  onStdout: (chunk: unknown) => void;
  onStderr: (chunk: unknown) => void;
  onComplete: () => void;
  onFailure: (message: string) => void;
};

type StreamBinding = {
  stream: Readable;
  onData: (chunk: unknown) => void;
  onDone: () => void;
  onError: (error: Error) => void;
};

function removeBinding(binding: StreamBinding): void {
  const { stream, onData, onDone, onError } = binding;
  stream.removeListener('data', onData);
  stream.removeListener('end', onDone);
  stream.removeListener('close', onDone);
  stream.removeListener('error', onError);
}

/**
 * Electron removes every UtilityProcess pipe listener immediately after emitting `exit`. Pause the
 * captured streams synchronously, then rebind after Electron's cleanup and drain buffered bytes.
 */
export function drainManagedOutputAfterExit(options: ManagedOutputDrainOptions): () => void {
  const { nodeName, stdout, stderr, onStdout, onStderr, onComplete, onFailure } = options;
  const bindings: StreamBinding[] = [];
  let remaining = 2;
  let settled = false;
  let deadline: ReturnType<typeof setTimeout> | undefined;

  stdout.pause();
  stderr.pause();

  const cleanup = () => {
    if (deadline) clearTimeout(deadline);
    for (const binding of bindings) removeBinding(binding);
  };
  const finish = (failure?: string) => {
    if (settled) return;
    settled = true;
    cleanup();
    if (failure) onFailure(failure);
    else onComplete();
  };
  const bind = (stream: Readable, onData: (chunk: unknown) => void, streamName: string) => {
    if (stream.readableEnded || stream.destroyed) {
      remaining -= 1;
      if (remaining === 0) finish();
      return;
    }

    let streamFinished = false;
    const onDone = () => {
      if (streamFinished) return;
      streamFinished = true;
      removeBinding(binding);
      remaining -= 1;
      if (remaining === 0) finish();
    };
    const onError = (error: Error) => {
      const detail = error instanceof Error ? error.message : String(error);
      finish(
        `Frink's bundled Node.js process failed while draining ${streamName} for custom node "${nodeName}": ${detail}. Output may be incomplete.`,
      );
    };
    const binding = { stream, onData, onDone, onError };
    bindings.push(binding);
    stream.on('data', onData);
    stream.once('end', onDone);
    stream.once('close', onDone);
    stream.once('error', onError);
  };

  queueMicrotask(() => {
    if (settled) return;
    bind(stdout, onStdout, 'stdout');
    bind(stderr, onStderr, 'stderr');
    if (settled) return;
    deadline = setTimeout(() => {
      finish(
        `Frink's bundled Node.js process output did not finish draining for custom node "${nodeName}" within ${MANAGED_OUTPUT_DRAIN_TIMEOUT_MS}ms after exit. Output may be incomplete.`,
      );
    }, MANAGED_OUTPUT_DRAIN_TIMEOUT_MS);
    stdout.resume();
    stderr.resume();
  });

  return () => {
    if (settled) return;
    settled = true;
    cleanup();
  };
}
