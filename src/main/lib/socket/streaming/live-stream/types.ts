import type { TranscriptTerminalDurability } from '../../../../../shared/types/assistant-message';

type LiveStreamStatus = 'active' | 'held' | 'settling' | 'settled' | 'error';

export type LiveStreamRecord = {
  chatId: string;
  subChatId: string;
  assistantMessageId: string;
  streamEpoch: string;
  completionSignal?: AbortSignal;
  generation?: number; // minted at run start, then carried unchanged; absent once pruned
  messageIndex: number;
  parts?: unknown[];
  finalParts?: unknown[];
  textOpen: boolean;
  deliveryOwnerWebContentsId?: number;
  status: LiveStreamStatus;
  terminalDurability?: TranscriptTerminalDurability;
  settledAt?: number;
  error?: string;
  category?: string;
};

export type LiveStreamSeed = {
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

export type LiveStreamTerminal = {
  subChatId: string;
  assistantMessageId: string;
  streamEpoch: string;
  status: 'settled' | 'error';
  error?: string;
  category?: string;
  parts?: unknown[];
} & TranscriptTerminalDurability;
