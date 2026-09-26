import * as Sentry from '@sentry/electron/renderer';
import { useStore } from 'jotai';
import { useEffect } from 'react';
import type { WakeHoldState } from '../../../shared/types/wake-hold';
import { trpcClient } from '../trpc';
import { isDesktopApp } from '../utils/platform';
import { wakeHeldAtomFamily } from './active-transport-registry';

const RETRY_DELAY_MS = 500;

/**
 * A hold is announced with its detail or not at all; only a retraction travels bare. Modelling that
 * as a union rather than an optional field is what lets the atom hold "held" and "what it's waiting
 * on" as one value, with no branch for a held state that has nothing to show.
 */
type WakeHoldPayload =
  | { subChatId: string; held: false }
  | { subChatId: string; held: true; pending: WakeHoldState };

/**
 * Validated to the depth the row renders. A hold is only ever armed with at least one pending item,
 * so an EMPTY list is a malformed payload rather than an idle wait — rejecting it leaves the previous
 * state standing instead of showing a wait with nothing to name.
 */
export function isWakeHoldState(value: unknown): value is WakeHoldState {
  const waitingOn = (value as Record<string, unknown> | null | undefined)?.waitingOn;
  return (
    Array.isArray(waitingOn) &&
    waitingOn.length > 0 &&
    waitingOn.every((label) => typeof label === 'string')
  );
}

export function isWakeHoldPayload(data: unknown): data is WakeHoldPayload {
  if (typeof data !== 'object' || data === null) return false;
  const d = data as Record<string, unknown>;
  if (typeof d.subChatId !== 'string' || typeof d.held !== 'boolean') return false;
  return d.held ? isWakeHoldState(d.pending) : true;
}

/**
 * Mirrors the main process's wake-hold state into {@link wakeHeldAtomFamily}, so a chat can
 * withhold its end-of-turn treatment until the agent has actually stood down rather than merely
 * paused between wake bursts.
 *
 * Mounted once at the app root, not per chat: a hold is armed AFTER the turn ends, and the chat
 * that armed it need not be the one on screen.
 *
 * Boot also SEEDS from main's live registry, because the push event is the only announcement a hold
 * ever makes: a window that reloads mid-wait would otherwise render the chat as finished and lose
 * the held row's Stop, the only stop affordance between bursts, while main keeps pumping into it.
 */
export function useWakeHoldSync(): void {
  const store = useStore();

  useEffect(() => {
    if (!isDesktopApp()) return;
    if (!window.desktopApi?.on) return;

    // Subscribe BEFORE seeding, and let a live frame win: one landing while the snapshot is in
    // flight is fresher than it, so seeding over it could re-raise a wait that was just retracted.
    const spokenFor = new Set<string>();
    // This effect instance is torn down. A snapshot answered afterwards knows only what ITS OWN
    // `spokenFor` saw, so a remount's listener could retract a hold and the late reply re-raise it
    // — with no second retraction coming to undo that. Its whole reply is void, errors included.
    let disposed = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let retried = false;
    const unsubscribe = window.desktopApi.on('socket:wake-hold-changed', (data) => {
      if (!isWakeHoldPayload(data)) return;
      spokenFor.add(data.subChatId);
      store.set(wakeHeldAtomFamily(data.subChatId), data.held ? data.pending : null);
    });

    // Pull once; on rejection, wait and retry exactly once more; then give up. Local IPC never
    // partitions, so the live listener subscribed above already carries any hold armed afterward.
    const seed = async (): Promise<void> => {
      try {
        const holds = await trpcClient.socket.listWakeHolds.query();
        if (disposed) return;
        for (const { subChatId, pending } of holds) {
          if (!spokenFor.has(subChatId)) store.set(wakeHeldAtomFamily(subChatId), pending);
        }
      } catch (error) {
        if (disposed) return;
        // Failing quietly here reproduces the bug this seam exists to fix — a held chat with no
        // Stop and no clue why. Report once, retry once, then give up.
        if (!retried) {
          retried = true;
          Sentry.captureException(error, { tags: { surface: 'wake-hold-rehydrate' } });
          retryTimer = setTimeout(() => {
            retryTimer = null;
            void seed();
          }, RETRY_DELAY_MS);
        }
      }
    };

    void seed();
    return () => {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      unsubscribe();
    };
  }, [store]);
}
