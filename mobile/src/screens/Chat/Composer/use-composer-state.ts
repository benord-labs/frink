import { useCallback, useEffect, useRef, useState } from 'react';
import type { MobileChatMode, MobileComposer } from '../../../../../src/shared/types/remote/mobile';
import { useConnection, useResource } from '../../../lib/connection';
import type { ComposerPatch } from './controls';

export type ComposerChange =
  | { type: 'updateComposer'; patch: ComposerPatch }
  | { type: 'setMode'; mode: MobileChatMode }
  | { type: 'setAccount'; accountId: string };

function applyChange(composer: MobileComposer, change: ComposerChange): MobileComposer {
  if (change.type === 'updateComposer')
    return { ...composer, settings: { ...composer.settings, ...change.patch } };
  if (change.type === 'setMode') return { ...composer, mode: change.mode };
  return composer; // An account switch changes the catalog; wait for the computer's answer.
}

/** The computer's composer settings with the phone's changes shown at once. Changes go out in
 *  order (overlapping taps are never dropped); while any is in flight, polls don't override. */
export function useComposerState(chatId: string, subChatId: string | undefined) {
  const { request } = useConnection();
  const resource = useResource(
    { type: 'composer', chatId, subChatId: subChatId ?? '' },
    // The account lookup behind this read can probe the keychain, so it polls gently.
    { enabled: !!subChatId, interval: 10_000 },
  );
  const [optimistic, setOptimistic] = useState<MobileComposer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const inFlight = useRef(0);
  const refresh = resource.refresh;

  // A fresh read replaces the phone's view only when none of its changes are still on the way.
  useEffect(() => {
    if (inFlight.current === 0) setOptimistic(null);
  }, [resource.updatedAt]);
  useEffect(() => {
    inFlight.current = 0;
    setOptimistic(null);
    setError(null);
  }, [chatId, subChatId]);

  const base = resource.data;
  const change = useCallback(
    (next: ComposerChange) => {
      if (!subChatId || !base) return;
      setError(null);
      setOptimistic((current) => applyChange(current ?? base, next));
      inFlight.current += 1;
      // Reason: The ordered send, its settle rule and failure recovery are one change's lifecycle.
      // fallow-ignore-next-line complexity
      queue.current = queue.current.then(async () => {
        try {
          const saved = await request({ ...next, chatId, subChatId });
          // Only the last answer may settle the view; an earlier one would hide later taps.
          if (inFlight.current === 1) setOptimistic(saved);
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : 'Could not save the change.');
          setOptimistic(null);
        } finally {
          inFlight.current = Math.max(inFlight.current - 1, 0);
          if (inFlight.current === 0) refresh();
        }
      });
    },
    [base, chatId, subChatId, request, refresh],
  );

  return { composer: optimistic ?? base, change, error };
}
