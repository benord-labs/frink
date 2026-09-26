import type { Readable } from 'node:stream';
import { utilityProcess } from 'electron';
import type { CustomNodeManifest } from './discovery';
import { getManagedCustomNodeBootstrapPath } from './managed-bootstrap-path';
import { drainManagedOutputAfterExit } from './managed-output-drain';
import {
  bufferFromChunk,
  outputLimitMessage,
  PROCESS_TERMINATION_GRACE_MS,
  sendHardKill,
} from './process-runner-support';
import { parseCustomNodeEntrypointSpec, resolveCustomNodeEntrypoint } from './runtime';

export type CustomNodeProcessResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  cancelled: boolean;
  spawnMessage?: string;
};

export type RunCustomNodeProcessOptions = {
  manifest: CustomNodeManifest;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  maxBuffer: number;
  signal?: AbortSignal;
};

function emptyResult(overrides: Partial<CustomNodeProcessResult> = {}): CustomNodeProcessResult {
  return {
    stdout: '',
    stderr: '',
    exitCode: null,
    timedOut: false,
    cancelled: false,
    ...overrides,
  };
}

function assertExplicitStringEnv(env: Record<string, string>): void {
  if (!env || typeof env !== 'object' || Array.isArray(env)) {
    throw new Error('[custom-node-runner] env must be an explicit string map');
  }
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== 'string') {
      throw new Error(`[custom-node-runner] env value for "${key}" must be a string`);
    }
  }
}

function assertPositiveLimit(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`[custom-node-runner] ${label} must be a positive finite number`);
  }
}

function runManagedProcess(params: {
  manifest: CustomNodeManifest;
  entrypoint: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  maxBuffer: number;
  signal?: AbortSignal;
}): Promise<CustomNodeProcessResult> {
  const { manifest, entrypoint, args, cwd, env, timeoutMs, maxBuffer, signal } = params;
  if (signal?.aborted) {
    return Promise.resolve(
      emptyResult({
        cancelled: true,
        spawnMessage: `Custom node "${manifest.name}" was cancelled before it started.`,
      }),
    );
  }
  return new Promise((resolve) => {
    let child: ReturnType<typeof utilityProcess.fork>;
    try {
      child = utilityProcess.fork(getManagedCustomNodeBootstrapPath(), [entrypoint, ...args], {
        cwd,
        env,
        stdio: 'pipe',
        serviceName: `Frink custom node: ${manifest.name}`,
        allowLoadingUnsignedLibraries: false,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      resolve(
        emptyResult({
          spawnMessage: `Frink's bundled Node.js could not start custom node "${manifest.name}": ${detail}`,
        }),
      );
      return;
    }
    const stdout = child.stdout as Readable | null;
    const stderr = child.stderr as Readable | null;
    const missingPipesMessage = `Frink's bundled Node.js did not provide piped output for custom node "${manifest.name}".`;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let hardKillTimeout: ReturnType<typeof setTimeout> | undefined;
    let terminationResult: Partial<CustomNodeProcessResult> | null = null;
    let fatalResult: Partial<CustomNodeProcessResult> | null = null;
    let exitObserved = false;
    let cancelOutputDrain = () => {};
    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      if (hardKillTimeout) clearTimeout(hardKillTimeout);
      cancelOutputDrain();
      stdout?.removeListener('data', onStdout);
      stderr?.removeListener('data', onStderr);
      child.removeListener('exit', onExit);
      child.removeListener('error', onError);
      signal?.removeEventListener('abort', onAbort);
    };

    const finish = (overrides: Partial<CustomNodeProcessResult>) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        exitCode: null,
        timedOut: false,
        cancelled: false,
        ...overrides,
      });
    };
    const hardKill = () => {
      if (settled || !terminationResult) return;
      const outcome = sendHardKill(child.pid);
      if (outcome === 'gone') {
        // The process is already gone but Electron did not deliver exit before this turn.
        finish(terminationResult);
      } else if (outcome === 'retry') {
        // Do not mark the Flow terminal while the node may still be running.
        hardKillTimeout = setTimeout(hardKill, PROCESS_TERMINATION_GRACE_MS);
      }
    };
    const requestTermination = (overrides: Partial<CustomNodeProcessResult>) => {
      if (settled || terminationResult) return;
      terminationResult = overrides;
      if (timeout) {
        clearTimeout(timeout);
        timeout = undefined;
      }
      if (exitObserved) {
        finish(overrides);
        return;
      }

      let gracefulStopRequested = false;
      try {
        gracefulStopRequested = child.kill();
      } catch {
        gracefulStopRequested = false;
      }

      if (gracefulStopRequested) {
        hardKillTimeout = setTimeout(hardKill, PROCESS_TERMINATION_GRACE_MS);
      } else {
        hardKill();
      }
    };

    function onStdout(chunk: unknown) {
      if (terminationResult) return;
      const data = bufferFromChunk(chunk);
      if (stdoutBytes + data.byteLength > maxBuffer) {
        requestTermination({
          spawnMessage: outputLimitMessage(manifest.name, 'stdout', maxBuffer),
        });
        return;
      }
      stdoutBytes += data.byteLength;
      stdoutChunks.push(data);
    }

    function onStderr(chunk: unknown) {
      if (terminationResult) return;
      const data = bufferFromChunk(chunk);
      if (stderrBytes + data.byteLength > maxBuffer) {
        requestTermination({
          spawnMessage: outputLimitMessage(manifest.name, 'stderr', maxBuffer),
        });
        return;
      }
      stderrBytes += data.byteLength;
      stderrChunks.push(data);
    }

    function onExit(code: number) {
      exitObserved = true;
      if (timeout) clearTimeout(timeout);
      if (hardKillTimeout) clearTimeout(hardKillTimeout);
      if (terminationResult) {
        finish(terminationResult);
        return;
      }
      if (fatalResult) {
        finish(fatalResult);
        return;
      }
      if (!stdout || !stderr) {
        finish({ spawnMessage: missingPipesMessage });
        return;
      }
      const exitCode = Number.isFinite(code) ? code : null;
      cancelOutputDrain = drainManagedOutputAfterExit({
        nodeName: manifest.name,
        stdout,
        stderr,
        onStdout,
        onStderr,
        onComplete: () => finish({ exitCode }),
        onFailure: (spawnMessage) => finish({ spawnMessage }),
      });
    }

    function onError(type: 'FatalError', location: string) {
      if (fatalResult) return;
      fatalResult = {
        spawnMessage: `Frink's bundled Node.js failed for custom node "${manifest.name}" (${type}${location ? ` at ${location}` : ''}).`,
      };
    }

    function onAbort() {
      if (exitObserved) return;
      requestTermination({
        cancelled: true,
        spawnMessage: `Custom node "${manifest.name}" was cancelled.`,
      });
    }

    stdout?.on('data', onStdout);
    stderr?.on('data', onStderr);
    child.on('exit', onExit);
    child.on('error', onError);
    signal?.addEventListener('abort', onAbort, { once: true });
    timeout = setTimeout(() => {
      requestTermination({
        timedOut: true,
        spawnMessage: `Custom node "${manifest.name}" timed out after ${timeoutMs}ms.`,
      });
    }, timeoutMs);

    if (!stdout || !stderr) {
      requestTermination({ spawnMessage: missingPipesMessage });
    }
  });
}

export async function runCustomNodeProcess(
  options: RunCustomNodeProcessOptions,
): Promise<CustomNodeProcessResult> {
  const { manifest, args, cwd, env, timeoutMs, maxBuffer, signal } = options;
  assertExplicitStringEnv(env);
  assertPositiveLimit(timeoutMs, 'timeoutMs');
  assertPositiveLimit(maxBuffer, 'maxBuffer');

  const { entrypoint: relativeEntrypoint } = parseCustomNodeEntrypointSpec(manifest);
  const entrypoint = await resolveCustomNodeEntrypoint(manifest.nodePath, relativeEntrypoint);

  return runManagedProcess({
    manifest,
    entrypoint,
    args,
    cwd,
    env,
    timeoutMs,
    maxBuffer,
    signal,
  });
}
