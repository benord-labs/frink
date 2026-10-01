/**
 * The query behind the flow-chat bottom surface (decision flow-run-chat-surface), kept with the
 * derivation it feeds: one place owns what the surface reads, how often it re-reads it, and what
 * happens when that read fails.
 */
import * as Sentry from '@sentry/electron/renderer';
import { useEffect, useRef } from 'react';
import { trpc } from '@/lib/trpc';
import { getFlowSurfaceRefetchInterval } from './flow-chat-surface-state';

/** Identity is useless for dedupe — react-query mints a NEW Error per failed fetch. */
const errorSignature = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);

/**
 * The driving `{ run, task }` pair for a sub-chat, polled on the liveness-keyed cadence.
 *
 * A failed read is CAPTURED, not swallowed: this query IS the surface's state, so an error leaves
 * nothing to derive from and the chat quietly falls back to the free composer mid-run — the exact
 * silent strand this surface exists to prevent, wearing a normal chat's face (it also re-arms the
 * raw stop shortcuts). Nothing else would report it: react-query swallows the error, and
 * `refetchOnWindowFocus` is off (TRPCProvider), so a cold-start failure never self-heals on focus.
 */
export function useFlowSurfaceQuery(subChatId: string, fallbackTaskId: string | null) {
  const query = trpc.tasks.getDrivingTaskForSubChat.useQuery(
    { subChatId, fallbackTaskId },
    {
      enabled: Boolean(subChatId),
      refetchInterval: (q) => getFlowSurfaceRefetchInterval(q.state.data),
    },
  );

  // The poll is a floor: every in-place resume emits run_started/node_started, so refetch on that
  // announcement instead of waiting a full interval or guessing an optimistic `{run, task}` shape.
  const { refetch } = query;
  const runId = query.data?.run?.id ?? null;
  useEffect(() => {
    // Mirror the query's own `enabled` gate: without this, an engine event would refetch a DISABLED
    // query and fire a read for `subChatId: ''`.
    if (!subChatId) return;
    const subscribe = window.desktopApi?.onSocketFlowExecutionEvent;
    if (!subscribe) return;
    return subscribe((event) => {
      if (
        event.eventType === 'run_started' ||
        (event.eventType === 'node_started' && event.flowRunId === runId) // not other runs' nodes
      ) {
        void refetch();
      }
    });
  }, [refetch, subChatId, runId]);

  // The readout's mode changes WITHIN a node — an auto-approved plan node flips to agent the moment
  // its plan card is emitted — and that flip announces itself on its own channel, not through a
  // run/node event. Without this the pill stays wrong for up to a full poll interval while the agent
  // is already implementing.
  useEffect(() => {
    if (!subChatId) return;
    const subscribe = window.desktopApi?.onSubChatModeChanged;
    if (!subscribe) return;
    return subscribe((event) => {
      if (event.subChatId === subChatId) void refetch();
    });
  }, [refetch, subChatId]);

  // Report each DISTINCT failure once. Polling deliberately continues while errored (the last good
  // data keeps the surface honest, and a retry is how it recovers), so an outage re-errors every
  // tick — and each tick carries a fresh Error object, so deduping on identity would report on a
  // 3.5s loop. Reset on recovery: the next failure is news again.
  const { error } = query;
  const reported = useRef<string | null>(null);
  useEffect(() => {
    if (!error) {
      reported.current = null;
      return;
    }
    const signature = errorSignature(error);
    if (reported.current === signature) return;
    reported.current = signature;
    Sentry.captureException(error, {
      tags: { source: 'useFlowSurfaceQuery', area: 'flow-run-chat-surface' },
      extra: { subChatId, fallbackTaskId },
    });
  }, [error, subChatId, fallbackTaskId]);

  return query;
}
