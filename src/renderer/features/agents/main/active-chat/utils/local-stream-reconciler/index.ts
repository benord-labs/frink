import * as Sentry from '@sentry/electron/renderer';
import type { UIMessage } from 'ai';
import {
  type AssistantPartShape,
  applyAssistantChunkToParts,
  assistantPartsSnapshot,
  assistantPartsStateFromSnapshot,
  createAssistantPartsState,
} from '../../../../../../../shared/lib/assistant-parts';
import { rememberBounded } from '../../../../../../lib/utils/bounded-set';
import type {
  CompletionInput,
  LocalStreamChunk,
  LocalStreamSeed,
  LocalStreamSeedResult,
  LocalStreamTerminal,
  ReconcilerOptions,
  StreamState,
} from './types';

export type {
  LocalStreamChunk,
  LocalStreamSeed,
  LocalStreamSeedResult,
  LocalStreamTerminal,
} from './types';

const DEFAULT_PRESEED_CHUNK_LIMIT = 256;
const DEFAULT_GAP_BUFFER_LIMIT = 128;
const DEFAULT_INITIAL_HYDRATION_RETRY_DELAY_MS = 250;

const toReducerParts = (parts: unknown[]): AssistantPartShape[] => parts as AssistantPartShape[];

const toUiParts = (parts: AssistantPartShape[]): UIMessage['parts'] =>
  parts as unknown as UIMessage['parts'];

export class LocalStreamReconciler {
  private readonly states = new Map<string, StreamState>();
  private readonly currentEpochByMessage = new Map<string, string>();
  private readonly eventEpochByMessage = new Map<string, string>();
  private readonly terminalEpochs = new Set<string>();
  private readonly supersededEpochs = new Set<string>();
  private readonly heldCompletionFences = new Map<string, { finalParts?: unknown[] }>();
  private readonly pendingInitialCompletions = new Map<string, CompletionInput>();
  private readonly reportedRecoveryFailures = new Set<'gap-repair' | 'initial-hydration'>();
  private readonly preseedChunks: LocalStreamChunk[] = [];
  private preseedOverflowed = false; // set when the preseed buffer overflowed and was cleared
  private readonly preseedChunkLimit: number;
  private readonly gapBufferLimit: number;
  private readonly initialHydrationRetryDelayMs: number;
  private initialHydration = true;
  private initialHydrationRetried = false;
  private initialHydrationRetryResolve: (() => void) | null = null;
  private initialHydrationRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(private readonly options: ReconcilerOptions) {
    this.preseedChunkLimit = this.positiveInteger(
      options.preseedChunkLimit,
      DEFAULT_PRESEED_CHUNK_LIMIT,
    );
    this.gapBufferLimit = this.positiveInteger(options.gapBufferLimit, DEFAULT_GAP_BUFFER_LIMIT);
    this.initialHydrationRetryDelayMs =
      options.initialHydrationRetryDelayMs ?? DEFAULT_INITIAL_HYDRATION_RETRY_DELAY_MS;
  }

  // One retry, then proceed without a seed: the durable transcript plus live deltas cover the rest.
  async hydrate(): Promise<void> {
    let result: LocalStreamSeedResult | null = null;
    try {
      result = await this.options.fetchSeed();
    } catch (error) {
      this.reportRecoveryFailureOnce(error, 'initial-hydration');
    }
    if (this.disposed) return;
    if (
      !this.initialHydrationRetried &&
      (result === null || this.hasUnresolvedInitialCompletion(result))
    ) {
      this.initialHydrationRetried = true;
      await this.retryInitialHydration();
      return;
    }

    if (result !== null) this.applySeedResult(result, true);
    this.initialHydration = false;
    this.flushInitialCompletions();
    const buffered = this.preseedChunks.splice(0);
    for (const payload of buffered) this.acceptChunk(payload);
    if (this.preseedOverflowed) await this.reseedAfterPreseedOverflow();
  }

  observeChunk(payload: LocalStreamChunk): void {
    if (this.disposed || !this.claimEpoch(payload.assistantMessageId, payload.streamEpoch)) return;
    this.eventEpochByMessage.set(payload.assistantMessageId, payload.streamEpoch);
    if (this.initialHydration) {
      this.preseedChunks.push(payload); // overflow clears below rather than dropping the oldest
      if (this.preseedChunks.length > this.preseedChunkLimit) {
        this.preseedChunks.length = 0;
        this.preseedOverflowed = true;
      }
      return;
    }
    this.heldCompletionFences.delete(payload.streamEpoch);
    this.acceptChunk(payload);
  }

  complete(input: CompletionInput): boolean {
    if (this.disposed || !this.claimEpoch(input.assistantMessageId, input.streamEpoch)) {
      return false;
    }
    this.eventEpochByMessage.set(input.assistantMessageId, input.streamEpoch);

    const state = this.states.get(input.streamEpoch);
    if (
      this.initialHydration &&
      !input.observerOwned &&
      state === undefined &&
      Array.isArray(input.finalParts)
    ) {
      this.pendingInitialCompletions.set(input.streamEpoch, input);
      return false;
    }
    const shouldPublish = input.observerOwned || state !== undefined;
    this.publishCompletion(input, state, shouldPublish);
    this.finishCompletion(input);
    return shouldPublish;
  }

  settle(assistantMessageId: string, streamEpoch: string): void {
    if (this.disposed || !this.claimEpoch(assistantMessageId, streamEpoch)) return;
    this.eventEpochByMessage.set(assistantMessageId, streamEpoch);
    if (this.applyPendingTerminal(assistantMessageId, streamEpoch, true)) return;
    const state = this.states.get(streamEpoch);
    if (state) this.publishStateParts(state, 'ready');
    this.markTerminal(assistantMessageId, streamEpoch);
  }

  // fallow-ignore-next-line unused-class-member -- Called by useRealtimeSync's IPC event bridge.
  error(assistantMessageId: string, streamEpoch: string): void {
    if (this.disposed || !this.claimEpoch(assistantMessageId, streamEpoch)) return;
    this.eventEpochByMessage.set(assistantMessageId, streamEpoch);
    this.markTerminal(assistantMessageId, streamEpoch);
  }

  dispose(): void {
    this.disposed = true;
    if (this.initialHydrationRetryTimer !== null) clearTimeout(this.initialHydrationRetryTimer);
    this.initialHydrationRetryTimer = null;
    this.initialHydrationRetryResolve?.();
    this.initialHydrationRetryResolve = null;
    this.states.clear();
    this.pendingInitialCompletions.clear();
    this.preseedChunks.length = 0;
  }

  private acceptChunk(payload: LocalStreamChunk): void {
    if (!this.claimEpoch(payload.assistantMessageId, payload.streamEpoch)) return;
    if (!this.initialHydration) this.heldCompletionFences.delete(payload.streamEpoch);

    const state = this.getOrCreateState(payload);
    if (payload.messageIndex <= state.highWater || state.buffered.has(payload.messageIndex)) return;
    if (payload.messageIndex !== state.highWater + 1) {
      this.bufferGapChunk(state, payload);
      this.requestGapSeed(state);
      return;
    }

    this.applyChunk(state, payload);
    this.drainContiguous(state);
    this.reconcileGapRepair(state);
  }

  private getOrCreateState(payload: LocalStreamChunk): StreamState {
    const existing = this.states.get(payload.streamEpoch);
    if (existing) return existing;
    const state = this.createStreamState(payload.streamEpoch, payload.assistantMessageId);
    this.states.set(payload.streamEpoch, state);
    return state;
  }

  private applyChunk(state: StreamState, payload: LocalStreamChunk): void {
    applyAssistantChunkToParts(state.parts, payload.chunk);
    state.highWater = payload.messageIndex;
    this.publishStateParts(state, 'streaming');
  }

  private drainContiguous(state: StreamState): void {
    let next = state.buffered.get(state.highWater + 1);
    while (next) {
      state.buffered.delete(next.messageIndex);
      this.applyChunk(state, next);
      next = state.buffered.get(state.highWater + 1);
    }
  }

  private requestGapSeed(state: StreamState): void {
    if (!this.isCurrentState(state) || state.reseeding) return;
    state.reseeding = true;
    void this.options
      .fetchSeed()
      .then(
        (result) => {
          if (this.isCurrentState(state)) this.applySeedResult(result, false, state);
        },
        (error: unknown) => this.reportRecoveryFailureOnce(error, 'gap-repair'),
      )
      .finally(() => {
        state.reseeding = false;
        if (!this.isCurrentState(state)) return;
        this.drainContiguous(state);
        this.reconcileGapRepair(state);
      });
  }

  // Local IPC is ordered and reliable: one immediate reseed, then one retry, then give up.
  private reconcileGapRepair(state: StreamState): void {
    if (!this.isCurrentState(state)) return;
    if (!this.hasUnresolvedGap(state)) {
      state.gapRetryUsed = false;
      return;
    }
    if (state.reseeding) return;
    if (state.gapRetryUsed) {
      this.reportRecoveryFailureOnce(
        new Error('local stream gap unresolved after retry'),
        'gap-repair',
      );
      return;
    }
    state.gapRetryUsed = true;
    this.requestGapSeed(state);
  }

  private hasUnresolvedGap(state: StreamState): boolean {
    return state.buffered.size > 0 && !state.buffered.has(state.highWater + 1);
  }

  private reportRecoveryFailureOnce(
    error: unknown,
    phase: 'gap-repair' | 'initial-hydration',
  ): void {
    if (this.reportedRecoveryFailures.has(phase)) return;
    this.reportedRecoveryFailures.add(phase);
    Sentry.captureException(error, { tags: { surface: 'local-stream-reconcile', phase } });
  }

  private bufferGapChunk(state: StreamState, payload: LocalStreamChunk): void {
    state.buffered.set(payload.messageIndex, payload);
    // Indices insert in ascending order, so evicting the first-inserted key is the minimum.
    while (state.buffered.size > this.gapBufferLimit) {
      const oldest = state.buffered.keys().next().value;
      if (oldest === undefined) return;
      state.buffered.delete(oldest);
    }
  }

  private async retryInitialHydration(): Promise<void> {
    if (this.disposed) return;
    await new Promise<void>((resolve) => {
      this.initialHydrationRetryResolve = resolve;
      this.initialHydrationRetryTimer = setTimeout(() => {
        this.initialHydrationRetryTimer = null;
        this.initialHydrationRetryResolve = null;
        resolve();
      }, this.initialHydrationRetryDelayMs);
    });
    if (!this.disposed) await this.hydrate();
  }

  private async reseedAfterPreseedOverflow(): Promise<void> {
    this.preseedOverflowed = false; // buffer was cleared, not replayed — reseed every known stream
    try {
      const result = await this.options.fetchSeed();
      if (!this.disposed) this.applySeedResult(result, false);
    } catch (error) {
      this.reportRecoveryFailureOnce(error, 'gap-repair');
    }
  }

  private hasUnresolvedInitialCompletion(result: LocalStreamSeedResult): boolean {
    const records = [...result.streams, ...result.terminals];
    return [...this.pendingInitialCompletions.values()].some(
      (input) =>
        !this.isRetiredEpoch(input.streamEpoch) &&
        !records.some((record) => record.assistantMessageId === input.assistantMessageId),
    );
  }

  private flushInitialCompletions(): void {
    for (const input of this.pendingInitialCompletions.values()) {
      if (this.currentEpochByMessage.get(input.assistantMessageId) !== input.streamEpoch) continue;
      const state = this.states.get(input.streamEpoch);
      this.publishCompletion(input, state, true);
      this.finishCompletion(input);
    }
    this.pendingInitialCompletions.clear();
  }

  private applySeedResult(
    result: LocalStreamSeedResult,
    initial: boolean,
    affinity?: Pick<StreamState, 'assistantMessageId' | 'streamEpoch'>,
  ): void {
    const matchesAffinity = (record: Pick<StreamState, 'assistantMessageId' | 'streamEpoch'>) =>
      !affinity ||
      (record.assistantMessageId === affinity.assistantMessageId &&
        record.streamEpoch === affinity.streamEpoch);
    for (const terminal of result.terminals) {
      if (matchesAffinity(terminal)) this.applyTerminalSeed(terminal, initial);
    }
    for (const seed of result.streams) {
      if (matchesAffinity(seed)) this.applySeed(seed, initial);
    }
  }

  private applyTerminalSeed(terminal: LocalStreamTerminal, initial: boolean): void {
    if (this.isRetiredEpoch(terminal.streamEpoch)) return;
    const eventEpoch = this.eventEpochByMessage.get(terminal.assistantMessageId);
    if (initial && eventEpoch && eventEpoch !== terminal.streamEpoch) {
      this.rememberSuperseded(terminal.streamEpoch);
      return;
    }
    if (!this.claimEpoch(terminal.assistantMessageId, terminal.streamEpoch)) return;
    if (terminal.durability === 'non-durable' && Array.isArray(terminal.parts)) {
      this.options.publish(
        terminal.assistantMessageId,
        terminal.parts as UIMessage['parts'],
        'ready',
      );
    }
    if (
      this.applyPendingTerminal(
        terminal.assistantMessageId,
        terminal.streamEpoch,
        terminal.status === 'settled',
      )
    ) {
      return;
    }
    this.markTerminal(terminal.assistantMessageId, terminal.streamEpoch);
  }

  private applyPendingTerminal(
    assistantMessageId: string,
    streamEpoch: string,
    shouldPublish: boolean,
  ): boolean {
    const pendingCompletion = this.pendingInitialCompletions.get(streamEpoch);
    if (!pendingCompletion) return false;
    this.pendingInitialCompletions.delete(streamEpoch);
    this.publishCompletion(pendingCompletion, this.states.get(streamEpoch), shouldPublish);
    this.markTerminal(assistantMessageId, streamEpoch);
    return true;
  }

  private applySeed(seed: LocalStreamSeed, initial: boolean): void {
    if (!this.canApplySeed(seed, initial)) return;
    if (!this.claimEpoch(seed.assistantMessageId, seed.streamEpoch)) return;
    const state = this.getSeedState(seed);
    if (!state) return;

    const heldFence = this.heldCompletionFences.get(seed.streamEpoch);
    state.parts = assistantPartsStateFromSnapshot(
      toReducerParts(heldFence?.finalParts ?? seed.parts),
      heldFence ? false : seed.textOpen,
    );
    state.highWater = seed.messageIndex;
    this.states.set(seed.streamEpoch, state);
    this.currentEpochByMessage.set(seed.assistantMessageId, seed.streamEpoch);
    this.pruneBufferedThroughHighWater(state);
    this.publishStateParts(state, seed.status === 'held' || heldFence ? 'ready' : 'streaming');
    this.drainContiguous(state);
    this.reconcileGapRepair(state);
  }

  private canApplySeed(seed: LocalStreamSeed, initial: boolean): boolean {
    if (this.isRetiredEpoch(seed.streamEpoch)) return false;
    // A push from a different epoch observed while the pull was in flight wins over the seed.
    const eventEpoch = this.eventEpochByMessage.get(seed.assistantMessageId);
    if (initial && eventEpoch && eventEpoch !== seed.streamEpoch) {
      this.rememberSuperseded(seed.streamEpoch);
      return false;
    }
    return true;
  }

  private getSeedState(seed: LocalStreamSeed): StreamState | null {
    const previous = this.states.get(seed.streamEpoch);
    if (previous && seed.messageIndex < previous.highWater) return null;
    return previous ?? this.createStreamState(seed.streamEpoch, seed.assistantMessageId);
  }

  private createStreamState(streamEpoch: string, assistantMessageId: string): StreamState {
    return {
      streamEpoch,
      assistantMessageId,
      parts: createAssistantPartsState(),
      highWater: -1,
      buffered: new Map(),
      reseeding: false,
      gapRetryUsed: false,
    };
  }

  private pruneBufferedThroughHighWater(state: StreamState): void {
    for (const index of state.buffered.keys()) {
      if (index <= state.highWater) state.buffered.delete(index);
    }
  }

  private publishCompletion(
    input: CompletionInput,
    state: StreamState | undefined,
    shouldPublish: boolean,
  ): void {
    if (!shouldPublish) return;
    if (!Array.isArray(input.finalParts)) {
      if (state) this.publishStateParts(state, 'ready');
      return;
    }
    if (state && input.continuesWakeHold) {
      state.parts = assistantPartsStateFromSnapshot(toReducerParts(input.finalParts), false);
    }
    this.options.publish(input.assistantMessageId, input.finalParts as UIMessage['parts'], 'ready');
  }

  private finishCompletion(input: CompletionInput): void {
    if (!input.continuesWakeHold) {
      this.markTerminal(input.assistantMessageId, input.streamEpoch);
      return;
    }
    this.heldCompletionFences.set(input.streamEpoch, { finalParts: input.finalParts });
    this.currentEpochByMessage.set(input.assistantMessageId, input.streamEpoch);
  }

  private publishStateParts(state: StreamState, status: 'streaming' | 'ready'): void {
    this.options.publish(
      state.assistantMessageId,
      toUiParts([...assistantPartsSnapshot(state.parts)]),
      status,
    );
  }

  private markTerminal(assistantMessageId: string, streamEpoch: string): void {
    rememberBounded(this.terminalEpochs, streamEpoch, 64);
    this.pendingInitialCompletions.delete(streamEpoch);
    this.states.delete(streamEpoch);
    this.heldCompletionFences.delete(streamEpoch);
    if (this.currentEpochByMessage.get(assistantMessageId) === streamEpoch) {
      this.currentEpochByMessage.delete(assistantMessageId);
    }
  }

  private isCurrentState(state: StreamState): boolean {
    return (
      !this.disposed &&
      !this.isRetiredEpoch(state.streamEpoch) &&
      this.states.get(state.streamEpoch) === state
    );
  }

  private claimEpoch(assistantMessageId: string, streamEpoch: string): boolean {
    if (this.isRetiredEpoch(streamEpoch)) return false;
    const currentEpoch = this.currentEpochByMessage.get(assistantMessageId);
    if (currentEpoch === streamEpoch) return true;
    if (currentEpoch) this.supersedeEpoch(currentEpoch);
    this.currentEpochByMessage.set(assistantMessageId, streamEpoch);
    return true;
  }

  private supersedeEpoch(streamEpoch: string): void {
    this.rememberSuperseded(streamEpoch);
    this.states.delete(streamEpoch);
    this.heldCompletionFences.delete(streamEpoch);
  }

  private rememberSuperseded(streamEpoch: string): void {
    const wasSuperseded = this.supersededEpochs.has(streamEpoch);
    rememberBounded(this.supersededEpochs, streamEpoch, 64);
    if (!wasSuperseded) this.options.onEpochSuperseded?.(streamEpoch);
  }

  private isRetiredEpoch(streamEpoch: string): boolean {
    return this.terminalEpochs.has(streamEpoch) || this.supersededEpochs.has(streamEpoch);
  }

  private positiveInteger(value: number | undefined, fallback: number): number {
    if (value === undefined || !Number.isFinite(value) || value < 1) return fallback;
    return Math.floor(value);
  }
}
