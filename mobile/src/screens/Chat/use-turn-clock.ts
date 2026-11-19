import { useEffect, useRef, useState } from 'react';
import type { MobileActivity } from '@frink/shared/types/remote/mobile';

/**
 * How long the current turn has run. The computer doesn't send a start time, so the clock only
 * runs when this screen saw the turn start (a send from here, or idle turning into running);
 * a chat opened mid-turn says "Running" without a number rather than a wrong one.
 */
export function useTurnClock(
  activity: MobileActivity | undefined,
  conversation: string,
  /** When the poll that reported `activity` arrived. */
  updatedAt: number | undefined,
) {
  const [since, setSince] = useState<number | null>(null);
  const previous = useRef({ conversation, activity });
  // A send from here, waiting for a poll to report its turn running.
  const pending = useRef<number | null>(null);
  useEffect(() => {
    const before = previous.current;
    previous.current = { conversation, activity };
    if (before.conversation !== conversation) {
      pending.current = null;
      setSince(null);
    } else if (activity === 'running') {
      if (before.activity === 'idle' || pending.current)
        setSince((start) => start ?? pending.current ?? Date.now());
      pending.current = null;
    } else {
      setSince(null);
      // A poll newer than the send that still reads idle means that turn already ended.
      if (activity === 'idle' && pending.current && (updatedAt ?? 0) > pending.current)
        pending.current = null;
    }
  }, [activity, conversation, updatedAt]);
  return {
    /** When the running turn started, or null when there is no number to show. */
    since: activity === 'running' ? since : null,
    /** A send from this phone starts the turn now, before the next poll reports it. */
    started: () => {
      pending.current = Date.now();
    },
  };
}
