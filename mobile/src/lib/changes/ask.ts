import type { MobileChatChanges } from '@frink/shared/types/remote/mobile';

/** One answer, tagged with the computer and chat it was asked about. */
export type ChangesAnswer = { key: string; data?: MobileChatChanges; error?: string };

/** Asks once; after the returned cancel runs, neither an answer nor a failure is reported. */
export function askChanges(
  ask: (signal: AbortSignal) => Promise<MobileChatChanges>,
  onAnswer: (answer: Omit<ChangesAnswer, 'key'>) => void,
): () => void {
  const controller = new AbortController();
  ask(controller.signal).then(
    (data) => {
      if (!controller.signal.aborted) onAnswer({ data });
    },
    (error) => {
      if (controller.signal.aborted) return;
      onAnswer({ error: error instanceof Error ? error.message : 'Could not read the changes.' });
    },
  );
  return () => controller.abort();
}

/** A failed ask keeps the last answer for the same key on screen, under its error. */
export function nextAnswer(
  old: ChangesAnswer | undefined,
  key: string,
  next: Omit<ChangesAnswer, 'key'>,
): ChangesAnswer {
  if (next.data) return { key, data: next.data };
  return { key, data: old?.key === key ? old.data : undefined, error: next.error };
}

/** The answer only when it was asked about `key`, so another computer's or chat's never shows. */
export function ownAnswer(
  answer: ChangesAnswer | undefined,
  key: string,
): Omit<ChangesAnswer, 'key'> {
  if (answer?.key !== key) return {};
  return { data: answer.data, error: answer.error };
}
