import type { UIMessage } from 'ai';
import type { AssistantPartsState } from '../../../../../../../shared/lib/assistant-parts';
import type { TranscriptTerminalDurability } from '../../../../../../../shared/types/assistant-message';

export type LocalStreamChunk = {
  chatId: string;
  subChatId: string;
  assistantMessageId: string;
  streamEpoch: string;
  messageIndex: number;
  chunk: { type: string };
};

export type LocalStreamSeed = {
  chatId: string;
  subChatId: string;
  assistantMessageId: string;
  streamEpoch: string;
  messageIndex: number;
  parts: unknown[];
  textOpen: boolean;
  status: 'active' | 'held' | 'settling';
  observerOwned: boolean;
};

export type LocalStreamTerminal = {
  subChatId: string;
  assistantMessageId: string;
  streamEpoch: string;
  status: 'settled' | 'error';
  error?: string;
  category?: string;
  parts?: unknown[];
} & TranscriptTerminalDurability;

export type LocalStreamSeedResult = {
  streams: LocalStreamSeed[];
  terminals: LocalStreamTerminal[];
};

export type StreamState = {
  streamEpoch: string;
  assistantMessageId: string;
  parts: AssistantPartsState;
  highWater: number;
  buffered: Map<number, LocalStreamChunk>;
  reseeding: boolean;
  /** Local IPC is ordered and reliable, so a gap gets one immediate reseed plus one retry — no
   * backoff ladder. True once that one retry has been spent for the gap currently open. */
  gapRetryUsed: boolean;
};

export type CompletionInput = {
  assistantMessageId: string;
  streamEpoch: string;
  finalParts?: unknown[];
  continuesWakeHold: boolean;
  observerOwned: boolean;
};

export type ReconcilerOptions = {
  fetchSeed: () => Promise<LocalStreamSeedResult>;
  onEpochSuperseded?: (streamEpoch: string) => void;
  publish: (
    assistantMessageId: string,
    parts: UIMessage['parts'],
    status: 'streaming' | 'ready',
  ) => void;
  preseedChunkLimit?: number;
  gapBufferLimit?: number;
  initialHydrationRetryDelayMs?: number;
};
