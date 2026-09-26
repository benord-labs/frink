/**
 * The busy-chat lock behind the workspace context bar's read-only cues (decision
 * flow-run-chat-surface).
 */
import { useEffect, useState } from 'react';
import { trpc } from '@/lib/trpc';

/** Matches the sidebar's cadence on the same query key, so the two share one poll. */
const ACTIVE_RUN_POLL_MS = 5_000;

/**
 * Held past the gap between two queued messages: the queue processor only dispatches at status
 * 'ready' and waits QUEUE_PROCESS_DELAY_MS (1s) first, so streaming genuinely falls to false between
 * every message and the controls would flicker back once per message without this.
 */
const RELEASE_HOLD_MS = 1_500;

/** Shown wherever the lock is surfaced, so every explanation of it reads identically. */
export const WORKSPACE_LOCK_REASON = 'Locked while this chat has a run in progress.';

/**
 * Whether this chat's git controls should be read-only cues: ANY of its sub-chats is streaming
 * (the caller supplies that, since the loading map belongs to the agents feature), or the chat has
 * a non-terminal flow run. Chat-wide rather than per sub-chat because the resource being protected
 * is the chat's WORKTREE — every sub-chat tab shares one, so a per-tab signal would leave an idle
 * sibling tab offering a checkout into the busy tree.
 *
 * A CUE, not an enforced guard: changes.switchBranch and chats.switchWorktree have no in-flight
 * check of their own. Two known over-reports, both deliberate — which is why the caller must always
 * be able to EXPLAIN the locked state rather than only removing the affordance:
 * - A fan-out (multi-start_task) run links ONE run to several branch chats, so an idle branch chat
 *   reads as busy for the whole run.
 * - A run parked on awaiting_input stays non-terminal with no timeout, so a plan-approval park holds
 *   the lock until a human acts — while the chat shows an ordinary composer.
 */
export function useWorkspaceContextLock(
  chatId: string | undefined,
  isChatStreaming: boolean,
): boolean {
  const { data: activeRunChatIds } = trpc.flows.activeRunChatIds.useQuery(undefined, {
    enabled: Boolean(chatId),
    refetchInterval: ACTIVE_RUN_POLL_MS,
    structuralSharing: true,
  });

  const isBusy = isChatStreaming || Boolean(chatId && activeRunChatIds?.includes(chatId));

  const [locked, setLocked] = useState(isBusy);
  useEffect(() => {
    if (isBusy) {
      setLocked(true);
      return;
    }
    const timer = setTimeout(() => setLocked(false), RELEASE_HOLD_MS);
    return () => clearTimeout(timer);
  }, [isBusy]);

  return locked;
}
