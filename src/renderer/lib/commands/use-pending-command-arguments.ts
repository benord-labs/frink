import { useCallback, useEffect, useRef, useState } from 'react';
import type { SlashCommandOption } from './types';

type PendingCommandArguments = {
  /** The command whose arguments are being collected, or null when none is. */
  pending: SlashCommandOption | null;
  /** Claims the picker for this pick. Take the token before fetching the body. */
  beginPick: () => number;
  /** True when the pick was consumed here; false when the caller should insert it as-is. */
  holdForArguments: (
    command: SlashCommandOption,
    pickedIn: number,
    collectArguments: boolean,
  ) => boolean;
  resolve: () => void;
};

/** Owns the "picked, still needs arguments" step; a spent session token drops a stale pick. */
export function usePendingCommandArguments(isOpen: boolean): PendingCommandArguments {
  const [pending, setPending] = useState<SlashCommandOption | null>(null);
  const session = useRef(0);

  useEffect(() => {
    session.current += 1;
    setPending(null);
  }, [isOpen]);

  const holdForArguments = useCallback(
    (command: SlashCommandOption, pickedIn: number, collectArguments: boolean) => {
      // Superseded by a later pick or by the picker closing: drop it rather than insert it late.
      if (pickedIn !== session.current) return true;
      // Flow instructions are a per-run template, so they keep $ARGUMENTS unfilled.
      if (!collectArguments) return false;
      // The body just fetched decides, not the list flag it may have drifted from while cached.
      if (!command.prompt?.includes('$ARGUMENTS')) return false;
      setPending(command);
      return true;
    },
    [],
  );

  return {
    pending,
    beginPick: useCallback(() => (session.current += 1), []),
    holdForArguments,
    resolve: useCallback(() => setPending(null), []),
  };
}
