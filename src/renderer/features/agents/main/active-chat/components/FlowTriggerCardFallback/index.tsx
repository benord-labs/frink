/**
 * The trigger card, rendered from the TASK when a flow sub-chat has no persisted message yet.
 *
 * A flow's `start_task` creates the chat EMPTY; the trigger text becomes a real user message only
 * once the renderer sends the prompt (on `task:chat-ready`). A task that fails BEFORE that send
 * (e.g. an auth precondition) never sends, leaving the chat a blank pane beneath the "Task failed"
 * strip. This projects the same trigger card the persisted message would show — straight from the
 * task's `triggerContext` — so a failed first run is never empty.
 *
 * It hides the instant a real user message exists (`userMsgIds` non-empty), so it can never
 * double-render: Retry / Continue re-delivers the prompt, the message persists, this yields to it.
 *
 * The task read shares TaskControls' `getActionableTaskForSubChat` query (same key, always mounted
 * via RunStatusRows) — no extra poll; TaskControls owns the cadence, this is a passive reader.
 * The `showTriggerCard !== false` gate mirrors `buildTaskPrompt` exactly, so the card appears in
 * precisely the cases the persisted message would (a flow agent that opted out shows nothing).
 */
import { useAtomValue } from 'jotai';
import { memo, useMemo } from 'react';
import { buildTriggerSummary } from '../../../../../../../shared/lib/trigger-summary';
import {
  isValidTriggerContext,
  withTriggerContextDefaults,
} from '../../../../../../../shared/types/trigger-context';
import { taskResultSchema } from '../../../../../../../shared/types/task-result';
import { trpc } from '../../../../../../lib/trpc';
import { userMessageIdsForSubChatAtomFamily } from '../../../../stores/message-store';
import { TriggerBubble } from '../../../../ui/trigger-bubble';

type FlowTriggerCardFallbackProps = {
  subChatId: string;
  /** The chat's pinned task — the SAME value TaskControls passes, so the query key (cache) matches. */
  pinnedTaskId: string | null;
};

export const FlowTriggerCardFallback = memo(function FlowTriggerCardFallback({
  subChatId,
  pinnedTaskId,
}: FlowTriggerCardFallbackProps) {
  const userMsgIds = useAtomValue(userMessageIdsForSubChatAtomFamily(subChatId));
  // Same key TaskControls polls (via RunStatusRows, always mounted) → shared cache, no extra poll.
  const { data: task } = trpc.tasks.getActionableTaskForSubChat.useQuery(
    { subChatId, fallbackTaskId: pinnedTaskId },
    { enabled: subChatId.length > 0 },
  );

  const raw = task?.triggerContext;
  const card = useMemo(() => {
    // tRPC returns triggerContext as an object (Drizzle json mode); validate + default it through
    // the same shared primitives the rest of the app parses trigger contexts with.
    const context = taskResultSchema.safeParse(raw);
    if (!context.success || !isValidTriggerContext(context.data)) return null;
    // showTriggerCard === false: the flow agent opted out (instructions don't reference
    // {{trigger.*}}), so the persisted message omits the bubble — the fallback must match.
    const config = taskResultSchema.safeParse(context.data.Config);
    if (config.success && config.data.showTriggerCard === false) return null;
    const tc = withTriggerContextDefaults(context.data);
    return { tc, summary: buildTriggerSummary(tc) };
  }, [raw]);

  // A persisted user message (the real trigger card) exists → the list renders it; never double up.
  if (userMsgIds.length > 0 || !card) return null;

  return (
    <div className="flex justify-start" data-user-bubble>
      <div className="space-y-2 w-full">
        <TriggerBubble
          data={card.summary}
          triggerContext={card.tc}
          fullPrompt={task?.description ?? undefined}
        />
      </div>
    </div>
  );
});
