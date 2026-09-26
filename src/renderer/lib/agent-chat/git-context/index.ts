/** ChatView's "ask the agent about this diff" actions. Kept out of the component because React
 * Compiler cannot lower try/finally; `io` (live-io.ts) is injected so tests need no module mocks. */

import { generatePrMessage, generateReviewMessage } from '../../utils/pr-message';

type PrContext = Parameters<typeof generatePrMessage>[0] | null;

export type GitContextIo = {
  getPrContext: (chatId: string) => Promise<PrContext>;
  notifyError: (message: string) => void;
};

const FAILED_TO_PREPARE_PR = 'Failed to prepare PR request';
const FAILED_TO_PREPARE_REQUEST = 'Failed to prepare the request';
const FAILED_TO_START_REVIEW = 'Failed to start review';

function missingChatId(chatId: string, io: GitContextIo): boolean {
  if (chatId) return false;
  io.notifyError('Chat ID is required');
  return true;
}

/** Null when the chat has no git context; reported to the user here. */
async function getPrContext(chatId: string, io: GitContextIo): Promise<PrContext> {
  const context = await io.getPrContext(chatId);
  if (!context) io.notifyError('Could not get git context');
  return context;
}

type CreatePrInput = {
  chatId: string;
  setPendingPrMessage: (message: string) => void;
  setIsCreatingPr: (creating: boolean) => void;
};

/** The creating flag stays set on success: ChatViewInner clears it once the message is sent. */
export async function createPr(
  { chatId, setPendingPrMessage, setIsCreatingPr }: CreatePrInput,
  io: GitContextIo,
): Promise<void> {
  if (missingChatId(chatId, io)) return;
  setIsCreatingPr(true);
  try {
    const context = await getPrContext(chatId, io);
    if (!context) {
      setIsCreatingPr(false);
      return;
    }
    setPendingPrMessage(generatePrMessage(context));
  } catch (error) {
    io.notifyError(error instanceof Error ? error.message : FAILED_TO_PREPARE_PR);
    setIsCreatingPr(false);
  }
}

type AskAgentInput = {
  chatId: string;
  buildMessage: (context: NonNullable<PrContext>) => string;
  setPendingMessage: (message: string) => void;
  setBusy: (busy: boolean) => void;
};

/** Queues a git request (commit, merge, fix conflicts) for the agent; busy spans the lookup only. */
export async function askAgent(
  { chatId, buildMessage, setPendingMessage, setBusy }: AskAgentInput,
  io: GitContextIo,
): Promise<void> {
  if (missingChatId(chatId, io)) return;
  setBusy(true);
  try {
    const context = await getPrContext(chatId, io);
    if (context) setPendingMessage(buildMessage(context));
  } catch (error) {
    io.notifyError(error instanceof Error ? error.message : FAILED_TO_PREPARE_REQUEST);
  } finally {
    setBusy(false);
  }
}

type StartReviewInput = {
  chatId: string;
  /** Pane-local active sub-chat; the review filters the diff to its files. */
  effectiveActiveSubChatId: string | null | undefined;
  setFilteredSubChatId: (subChatId: string) => void;
  setPendingReviewMessage: (message: string) => void;
  setIsReviewing: (reviewing: boolean) => void;
};

export async function startReview(
  {
    chatId,
    effectiveActiveSubChatId,
    setFilteredSubChatId,
    setPendingReviewMessage,
    setIsReviewing,
  }: StartReviewInput,
  io: GitContextIo,
): Promise<void> {
  if (missingChatId(chatId, io)) return;
  setIsReviewing(true);
  try {
    const context = await getPrContext(chatId, io);
    if (!context) return;
    if (effectiveActiveSubChatId) setFilteredSubChatId(effectiveActiveSubChatId);
    setPendingReviewMessage(generateReviewMessage(context));
  } catch (error) {
    io.notifyError(error instanceof Error ? error.message : FAILED_TO_START_REVIEW);
  } finally {
    setIsReviewing(false);
  }
}
