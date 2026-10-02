// Plan-approval recovery items own their plan context and mode intent: armed just before the send,
// disarmed when that send fails so a dead approval cannot leak into the next turn.
import { appStore } from '../../../../lib/jotai-store';
import { approvedPlanContextAtomFamily, pendingModeIntentAtomFamily } from '../../atoms';
import type { AgentQueueItem } from '../../lib/queue-utils';
import { armApprovedPlanState } from '../../stores/sub-chat-store';

export function armPlanApproval(subChatId: string, item: AgentQueueItem): void {
  const context = item.approvedPlanContext;
  if (!context) return;
  armApprovedPlanState(subChatId, context);
  appStore.set(pendingModeIntentAtomFamily(subChatId), 'agent');
}

export function disarmFailedPlanApproval(subChatId: string, item: AgentQueueItem): void {
  const context = item.approvedPlanContext;
  if (!context) return;
  const contextAtom = approvedPlanContextAtomFamily(subChatId);
  if (appStore.get(contextAtom) === context) appStore.set(contextAtom, null);
  const intentAtom = pendingModeIntentAtomFamily(subChatId);
  if (appStore.get(intentAtom) === 'agent') appStore.set(intentAtom, null);
}
