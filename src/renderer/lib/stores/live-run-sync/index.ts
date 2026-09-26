import * as Sentry from '@sentry/electron/renderer';
import type { TranscriptTerminalDurability } from '../../../../shared/types/assistant-message';
import { rememberBounded } from '../../utils/bounded-set';
import {
  type ApplyQuestionChunk,
  type PendingQuestionProjection,
  projectLiveQuestionChunk,
  restoreSeededPendingQuestions,
} from './pending-question-recovery';

type LiveStreamHeader = { subChatId: string; assistantMessageId?: string; streamEpoch: string };

type RecoverySeedProjection = {
  streams: Array<{
    streamEpoch: string;
    status?: 'active' | 'held' | 'settling';
  }>;
  terminals: Array<{ streamEpoch: string } & TranscriptTerminalDurability>;
  pendingQuestions: PendingQuestionProjection[];
};

export type LiveRunSocketClient = {
  listLiveStreamHeaders?: { query: () => Promise<LiveStreamHeader[]> };
  listPendingQuestionSubChatIds?: { query: () => Promise<string[]> };
  getLiveStreamSeed?: {
    query: (input: { subChatId: string }) => Promise<RecoverySeedProjection>;
  };
};

type EpochEvent = {
  chatId?: string;
  subChatId: string;
  assistantMessageId?: string;
  streamEpoch?: string;
};

type GenericDesktopListener = (
  channel: string,
  callback: (payload?: unknown) => void,
) => (() => void) | undefined;

type DesktopApi = NonNullable<(typeof window)['desktopApi']>;

export type LiveRunSyncDependencies = {
  desktopApi: DesktopApi;
  socket: LiveRunSocketClient | undefined;
  publish: (subChatId: string, live: boolean, settling: boolean) => void;
  applyQuestionChunk: ApplyQuestionChunk;
  completeHydration: () => void;
};

type LiveRunSyncState = {
  dependencies: LiveRunSyncDependencies;
  epochsBySubChat: Map<string, Set<string>>;
  terminalEpochs: Set<string>;
  /** Epochs parked between wake bursts: not terminal (a tagged burst may resume them), but a
   * header snapshot pulled before the park must not mark them live again. */
  heldEpochs: Set<string>;
  liveEpochByPresentation: Map<string, { subChatId: string; streamEpoch: string }>;
  provisionalSubChatByPresentation: Map<string, string>;
  knownQuestionKeys: Set<string>;
  retiredQuestionIds: Set<string>;
  seedRetryTimers: Map<string, ReturnType<typeof setTimeout>>;
  reportedRecoveryFailures: Set<'header-hydration' | 'seed-validation'>;
  disposed: boolean;
  headerRetryTimer: ReturnType<typeof setTimeout> | null;
};

const RETRY_DELAY_MS = 500;
const EPOCH_FENCE_LIMIT = 64;

function presentationKey(event: EpochEvent): string | null {
  return event.assistantMessageId
    ? JSON.stringify([event.subChatId, event.assistantMessageId])
    : null;
}

/** Every sub-chat that needs its live-run state reconstructed on boot: one with a live header,
 * or one with a pending question awaiting an answer. */
function collectSeedSubChatIds(
  headers: LiveStreamHeader[],
  pendingQuestionSubChatIds: string[],
): Set<string> {
  const ids = new Set<string>();
  for (const header of headers) ids.add(header.subChatId);
  for (const subChatId of pendingQuestionSubChatIds) {
    if (typeof subChatId === 'string') ids.add(subChatId);
  }
  return ids;
}

function createLiveRunSyncState(dependencies: LiveRunSyncDependencies): LiveRunSyncState {
  return {
    dependencies,
    epochsBySubChat: new Map(),
    terminalEpochs: new Set(),
    heldEpochs: new Set(),
    liveEpochByPresentation: new Map(),
    provisionalSubChatByPresentation: new Map(),
    knownQuestionKeys: new Set(),
    retiredQuestionIds: new Set(),
    seedRetryTimers: new Map(),
    reportedRecoveryFailures: new Set(),
    disposed: false,
    headerRetryTimer: null,
  };
}

function reportRecoveryFailureOnce(
  state: LiveRunSyncState,
  error: unknown,
  phase: 'header-hydration' | 'seed-validation',
): void {
  if (state.reportedRecoveryFailures.has(phase)) return;
  state.reportedRecoveryFailures.add(phase);
  Sentry.captureException(error, { tags: { surface: 'live-run-rehydrate', phase } });
}

function publishLiveRunState(state: LiveRunSyncState, subChatId: string): void {
  const epochs = [...(state.epochsBySubChat.get(subChatId) ?? [])];
  const starting = [...state.provisionalSubChatByPresentation.values()].includes(subChatId);
  // A live epoch already fenced as terminal is one beginSettlingLiveRun keeps live until it settles.
  const settling =
    !starting && epochs.length > 0 && epochs.every((epoch) => state.terminalEpochs.has(epoch));
  state.dependencies.publish(subChatId, starting || epochs.length > 0, settling);
}

function removeLiveEpoch(state: LiveRunSyncState, subChatId: string, streamEpoch: string): void {
  const epochs = state.epochsBySubChat.get(subChatId);
  epochs?.delete(streamEpoch);
  if (epochs?.size === 0) state.epochsBySubChat.delete(subChatId);
}

function clearProvisionalRun(state: LiveRunSyncState, event: EpochEvent): void {
  const key = presentationKey(event);
  if (key) state.provisionalSubChatByPresentation.delete(key);
}

function addProvisionalRun(state: LiveRunSyncState, event: EpochEvent): void {
  const key = presentationKey(event);
  if (!key) return;
  state.provisionalSubChatByPresentation.set(key, event.subChatId);
  publishLiveRunState(state, event.subChatId);
}

function activatePresentationEpoch(state: LiveRunSyncState, event: EpochEvent): void {
  if (typeof event.streamEpoch !== 'string') return;
  const key = presentationKey(event);
  if (!key) return;
  const previous = state.liveEpochByPresentation.get(key);
  if (previous && previous.streamEpoch !== event.streamEpoch) {
    // Reusing a presentation id is an epoch replacement — retire the old epoch's live tracking.
    rememberTerminal(state, previous.streamEpoch);
    removeLiveEpoch(state, previous.subChatId, previous.streamEpoch);
    publishLiveRunState(state, previous.subChatId);
  }
  state.liveEpochByPresentation.set(key, {
    subChatId: event.subChatId,
    streamEpoch: event.streamEpoch,
  });
}

function clearPresentationEpoch(state: LiveRunSyncState, event: EpochEvent): void {
  if (typeof event.streamEpoch !== 'string') return;
  const key = presentationKey(event);
  if (!key || state.liveEpochByPresentation.get(key)?.streamEpoch !== event.streamEpoch) return;
  state.liveEpochByPresentation.delete(key);
}

function addLiveEpoch(state: LiveRunSyncState, event: EpochEvent): boolean {
  if (typeof event.streamEpoch !== 'string' || state.terminalEpochs.has(event.streamEpoch)) {
    return false;
  }
  clearProvisionalRun(state, event);
  activatePresentationEpoch(state, event);
  const epochs = state.epochsBySubChat.get(event.subChatId) ?? new Set<string>();
  epochs.add(event.streamEpoch);
  state.epochsBySubChat.set(event.subChatId, epochs);
  publishLiveRunState(state, event.subChatId);
  return true;
}

function rememberTerminal(state: LiveRunSyncState, streamEpoch: string): void {
  rememberBounded(state.terminalEpochs, streamEpoch, EPOCH_FENCE_LIMIT);
}

function removeLiveRun(state: LiveRunSyncState, event: EpochEvent): void {
  clearProvisionalRun(state, event);
  if (typeof event.streamEpoch === 'string') {
    rememberTerminal(state, event.streamEpoch);
    removeLiveEpoch(state, event.subChatId, event.streamEpoch);
    clearPresentationEpoch(state, event);
  }
  publishLiveRunState(state, event.subChatId);
}

function deactivateLiveRun(state: LiveRunSyncState, event: EpochEvent): void {
  clearProvisionalRun(state, event);
  if (typeof event.streamEpoch === 'string') {
    rememberBounded(state.heldEpochs, event.streamEpoch, EPOCH_FENCE_LIMIT);
    removeLiveEpoch(state, event.subChatId, event.streamEpoch);
    clearPresentationEpoch(state, event);
  }
  publishLiveRunState(state, event.subChatId);
}

function beginSettlingLiveRun(state: LiveRunSyncState, event: EpochEvent): void {
  if (typeof event.streamEpoch !== 'string') {
    deactivateLiveRun(state, event);
    return;
  }
  clearProvisionalRun(state, event);
  rememberTerminal(state, event.streamEpoch);
  const key = presentationKey(event);
  const current = key ? state.liveEpochByPresentation.get(key) : undefined;
  if (current && current.streamEpoch !== event.streamEpoch) return;
  activatePresentationEpoch(state, event);
  const epochs = state.epochsBySubChat.get(event.subChatId) ?? new Set<string>();
  epochs.add(event.streamEpoch);
  state.epochsBySubChat.set(event.subChatId, epochs);
  publishLiveRunState(state, event.subChatId);
}

function attachLiveRunListeners(state: LiveRunSyncState): Array<(() => void) | undefined> {
  const { desktopApi } = state.dependencies;
  const cleanupExecuteStart = desktopApi.onSocketExecuteStart?.((event) =>
    addProvisionalRun(state, event),
  );
  const cleanupChunk = desktopApi.onSocketStreamChunk?.((payload) => {
    projectLiveQuestionChunk(
      payload,
      state.retiredQuestionIds,
      state.knownQuestionKeys,
      state.dependencies.applyQuestionChunk,
    );
    // A live chunk for a parked epoch is the tagged wake burst resuming it.
    if (typeof payload.streamEpoch === 'string') state.heldEpochs.delete(payload.streamEpoch);
    addLiveEpoch(state, payload);
  });
  const cleanupComplete = desktopApi.onSocketExecuteComplete?.((payload) => {
    const event = payload as EpochEvent & { continuesWakeHold?: boolean };
    if (typeof event.streamEpoch === 'string') {
      const key = presentationKey(event);
      const current = key ? state.liveEpochByPresentation.get(key) : undefined;
      if (
        state.terminalEpochs.has(event.streamEpoch) ||
        (current && current.streamEpoch !== event.streamEpoch)
      ) {
        rememberTerminal(state, event.streamEpoch);
        return;
      }
    }
    if (event.continuesWakeHold === true) deactivateLiveRun(state, event);
    else beginSettlingLiveRun(state, event);
  });
  const cleanupError = desktopApi.onSocketError?.((payload) => {
    removeLiveRun(state, payload);
  });
  const onGeneric = desktopApi.on as unknown as GenericDesktopListener;
  const cleanupSettled = onGeneric('socket:stream-settled', (payload) => {
    const event = payload as EpochEvent;
    if (typeof event.streamEpoch === 'string') rememberTerminal(state, event.streamEpoch);
    deactivateLiveRun(state, event);
  });
  return [cleanupExecuteStart, cleanupChunk, cleanupComplete, cleanupError, cleanupSettled];
}

function applyRecoverySeedLifecycle(
  state: LiveRunSyncState,
  subChatId: string,
  result: RecoverySeedProjection,
): void {
  let retiredLiveEpoch = false;
  for (const terminal of result.terminals) {
    if (typeof terminal.streamEpoch !== 'string') continue;
    rememberTerminal(state, terminal.streamEpoch);
    removeLiveEpoch(state, subChatId, terminal.streamEpoch);
    retiredLiveEpoch = true;
  }
  if (retiredLiveEpoch) publishLiveRunState(state, subChatId);
}

async function pullRecoverySeed(
  state: LiveRunSyncState,
  subChatId: string,
): Promise<RecoverySeedProjection | null> {
  if (!state.dependencies.socket?.getLiveStreamSeed) return null;
  try {
    return await state.dependencies.socket.getLiveStreamSeed.query({ subChatId });
  } catch (error) {
    reportRecoveryFailureOnce(state, error, 'seed-validation');
    return null;
  }
}

function waitOnce(state: LiveRunSyncState, subChatId: string): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      state.seedRetryTimers.delete(subChatId);
      resolve();
    }, RETRY_DELAY_MS);
    state.seedRetryTimers.set(subChatId, timer);
  });
}

/**
 * Pull the recovery seed once; on rejection, wait and retry exactly once more; then give up.
 * Local IPC never partitions, so a seed either arrives on one of these two tries or the
 * sub-chat's own delta stream — already flowing via `attachLiveRunListeners` — carries the rest.
 */
async function validateRecoverySeed(state: LiveRunSyncState, subChatId: string): Promise<void> {
  let result = await pullRecoverySeed(state, subChatId);
  if (!result && !state.disposed) {
    await waitOnce(state, subChatId);
    if (!state.disposed) result = await pullRecoverySeed(state, subChatId);
  }
  if (state.disposed) return;
  if (result) {
    applyRecoverySeedLifecycle(state, subChatId, result);
    restoreSeededPendingQuestions(
      result.pendingQuestions,
      subChatId,
      state.retiredQuestionIds,
      state.knownQuestionKeys,
      state.dependencies.applyQuestionChunk,
    );
  }
}

async function pullLiveRunHeaders(
  state: LiveRunSyncState,
): Promise<{ headers: LiveStreamHeader[]; pendingQuestionSubChatIds: string[] } | null> {
  const { socket } = state.dependencies;
  if (!socket?.listLiveStreamHeaders || !socket.listPendingQuestionSubChatIds) return null;
  try {
    const [headers, pendingQuestionSubChatIds] = await Promise.all([
      socket.listLiveStreamHeaders.query(),
      socket.listPendingQuestionSubChatIds.query(),
    ]);
    return { headers, pendingQuestionSubChatIds };
  } catch (error) {
    reportRecoveryFailureOnce(state, error, 'header-hydration');
    return null;
  }
}

function waitForHeaderRetry(state: LiveRunSyncState): Promise<void> {
  return new Promise((resolve) => {
    state.headerRetryTimer = setTimeout(() => {
      state.headerRetryTimer = null;
      resolve();
    }, RETRY_DELAY_MS);
  });
}

function applyLiveRunHeaders(state: LiveRunSyncState, headers: LiveStreamHeader[]): void {
  for (const header of headers) {
    if (state.heldEpochs.has(header.streamEpoch)) continue;
    // A push observed while the pull was in flight already rotated this presentation: it wins.
    const key = presentationKey(header);
    const current = key ? state.liveEpochByPresentation.get(key) : undefined;
    if (current && current.streamEpoch !== header.streamEpoch) continue;
    addLiveEpoch(state, header);
  }
}

/**
 * Queue admission waits on this pull, so a failed attempt is retried at a fixed interval until it
 * succeeds: opening admission on an unknown set of live runs could dispatch a queued turn over a
 * surviving execution. Sentry hears about the failure once.
 */
async function pullLiveRunHeadersUntilSuccess(
  state: LiveRunSyncState,
): Promise<Awaited<ReturnType<typeof pullLiveRunHeaders>>> {
  let pulled = await pullLiveRunHeaders(state);
  while (!pulled && !state.disposed) {
    await waitForHeaderRetry(state);
    if (!state.disposed) pulled = await pullLiveRunHeaders(state);
  }
  return pulled;
}

async function hydrateLiveRunHeaders(state: LiveRunSyncState): Promise<void> {
  if (
    !state.dependencies.socket?.listLiveStreamHeaders ||
    !state.dependencies.socket.listPendingQuestionSubChatIds
  ) {
    state.dependencies.completeHydration();
    return;
  }
  const pulled = await pullLiveRunHeadersUntilSuccess(state);
  if (state.disposed || !pulled) return;
  applyLiveRunHeaders(state, pulled.headers);
  const subChatIds = collectSeedSubChatIds(pulled.headers, pulled.pendingQuestionSubChatIds);
  state.dependencies.completeHydration();
  for (const subChatId of subChatIds) {
    void validateRecoverySeed(state, subChatId);
  }
}

function disposeLiveRunSync(
  state: LiveRunSyncState,
  listenerCleanups: Array<(() => void) | undefined>,
): void {
  state.disposed = true;
  if (state.headerRetryTimer) clearTimeout(state.headerRetryTimer);
  for (const timer of state.seedRetryTimers.values()) clearTimeout(timer);
  state.seedRetryTimers.clear();
  for (const cleanup of listenerCleanups) cleanup?.();
}

export function startLiveRunSync(dependencies: LiveRunSyncDependencies): () => void {
  const state = createLiveRunSyncState(dependencies);
  const listenerCleanups = attachLiveRunListeners(state);
  void hydrateLiveRunHeaders(state);
  return () => disposeLiveRunSync(state, listenerCleanups);
}
