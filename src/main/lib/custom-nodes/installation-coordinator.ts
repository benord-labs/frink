type InstallState = {
  finished: Promise<void>;
  finish: () => void;
};

type ReaderState = {
  count: number;
  drained: Promise<void>;
  drain: () => void;
};

const installsInFlight = new Map<string, InstallState>();
const readersInFlight = new Map<string, ReaderState>();

export const CUSTOM_NODE_READER_DRAIN_TIMEOUT_MS = 5_000;

/**
 * Reserve the custom-node filesystem for one installation.
 *
 * Discovery exposes one coherent default-directory snapshot during the two-rename swap, so swaps
 * are globally serialized even when they target different node names.
 */
export function beginCustomNodeInstall(nodeName: string): (() => void) | null {
  if (installsInFlight.size > 0) return null;

  let finishPromise: (() => void) | undefined;
  const state: InstallState = {
    finished: new Promise<void>((resolve) => {
      finishPromise = resolve;
    }),
    finish: () => finishPromise?.(),
  };
  installsInFlight.set(nodeName, state);

  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (installsInFlight.get(nodeName) === state) {
      installsInFlight.delete(nodeName);
    }
    state.finish();
  };
}

export function isAnyCustomNodeInstallInFlight(): boolean {
  return installsInFlight.size > 0;
}

function waitForState(state: InstallState, signal?: AbortSignal): Promise<boolean> {
  if (!signal) return state.finished.then(() => true);
  if (signal.aborted) return Promise.resolve(false);

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (ready: boolean) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      resolve(ready);
    };
    const onAbort = () => finish(false);

    signal.addEventListener('abort', onAbort, { once: true });
    void state.finished.then(() => finish(true));
  });
}

/** Wait until all current installations for a node name finish. False means the wait was aborted. */
export async function waitForCustomNodeInstall(
  nodeName: string,
  signal?: AbortSignal,
): Promise<boolean> {
  while (true) {
    if (signal?.aborted) return false;
    const state = installsInFlight.get(nodeName);
    if (!state) return true;
    if (!(await waitForState(state, signal))) return false;
  }
}

function createReaderState(): ReaderState {
  let drainPromise: (() => void) | undefined;
  return {
    count: 0,
    drained: new Promise<void>((resolve) => {
      drainPromise = resolve;
    }),
    drain: () => drainPromise?.(),
  };
}

/**
 * Acquire a read lease for one installed node. A registration that starts first blocks the lease;
 * once acquired, the corresponding live directory cannot be swapped until the caller releases it.
 */
export async function acquireCustomNodeReadLease(
  nodeName: string,
  signal?: AbortSignal,
): Promise<(() => void) | null> {
  while (true) {
    if (!(await waitForCustomNodeInstall(nodeName, signal))) return null;
    if (signal?.aborted) return null;

    // The writer check and reader increment are synchronous, so a writer cannot interleave them.
    // If a back-to-back writer reserved the name while the awaited promise resumed, retry.
    if (installsInFlight.has(nodeName)) continue;

    const state = readersInFlight.get(nodeName) ?? createReaderState();
    state.count += 1;
    readersInFlight.set(nodeName, state);

    let released = false;
    return () => {
      if (released) return;
      released = true;
      state.count -= 1;
      if (state.count === 0) {
        if (readersInFlight.get(nodeName) === state) readersInFlight.delete(nodeName);
        state.drain();
      }
    };
  }
}

function assertPositiveReaderWaitTimeout(timeoutMs: number): void {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('[custom-node-install] reader wait timeout must be a positive finite number');
  }
}

/**
 * Wait up to `timeoutMs` for readers that acquired before this node's writer reservation to finish.
 * Returns false at the deadline without changing either the reader or writer reservation.
 */
export async function waitForCustomNodeReaders(
  nodeName: string,
  timeoutMs: number,
): Promise<boolean> {
  assertPositiveReaderWaitTimeout(timeoutMs);
  const state = readersInFlight.get(nodeName);
  if (!state) return true;

  return new Promise<boolean>((resolve) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const finish = (drained: boolean) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolve(drained);
    };

    timeout = setTimeout(() => finish(false), timeoutMs);
    void state.drained.then(() => finish(true));
  });
}
