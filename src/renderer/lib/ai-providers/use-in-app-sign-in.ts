import { useEffect, useRef, useState } from 'react';
import { trpc } from '../trpc';

/**
 * Runs a provider's own browser sign-in, then checks for the new login and connects it. Leaving
 * the wait (Cancel, Back, closing the page) stops the sign-in and connects nothing.
 */
export function useInAppSignIn<T>({
  type,
  recheck,
  connect,
}: {
  /** The agent account type the sign-in is for, such as "claude-code". */
  type: string;
  /** Looks for the new login again; null when none turned up. */
  recheck: () => Promise<T | null>;
  connect: (login: T) => Promise<void>;
}) {
  const signIn = trpc.agentAccounts.signIn.useMutation();
  const [checking, setChecking] = useState(false);
  const [missed, setMissed] = useState(false);
  // Each start is a new attempt; Cancel and leaving the page end the current one.
  const attempt = useRef(0);
  // The connect step runs after a wait, so it uses what the page holds by then (a typed label).
  const latest = useRef({ recheck, connect });
  useEffect(() => {
    latest.current = { recheck, connect };
  });

  const { client } = trpc.useUtils();
  useEffect(() => {
    if (!signIn.isPending) return;
    return () => void client.agentAccounts.cancelSignIn.mutate({ type });
  }, [signIn.isPending, client, type]);
  useEffect(
    () => () => {
      attempt.current += 1;
    },
    [],
  );

  const start = () => {
    const current = ++attempt.current;
    setMissed(false);
    signIn.mutate(
      { type },
      {
        onSuccess: async () => {
          setChecking(true);
          const login = await latest.current.recheck();
          if (attempt.current !== current) return;
          if (login) await latest.current.connect(login);
          else setMissed(true);
          setChecking(false);
        },
      },
    );
  };
  const cancel = () => {
    attempt.current += 1;
    setChecking(false);
    signIn.reset();
  };

  const waiting = signIn.isPending || checking;
  const state = waiting ? 'waiting' : signIn.isError || missed ? 'failed' : 'idle';
  return { state, waiting, start, cancel } as const;
}

export type InAppSignIn = ReturnType<typeof useInAppSignIn>;
