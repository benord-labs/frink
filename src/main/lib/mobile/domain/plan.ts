import {
  findApprovablePlan,
  PLAN_APPROVAL_EXECUTION_TRIGGER_TEXT,
  type PlanMessageLike,
} from '../../../../shared/types/plan';
import type { MobileRequest } from '../../../../shared/types/remote/mobile';
import { sendMobileMessage, subChatActivity } from './chat';
import { MobileApiError, mobileCallers, requireChat } from './context';

/**
 * Desktop's Approve, made entirely on the computer: the approval message goes out in Agent mode
 * carrying the plan, so the send saves the mode, marks the plan approved, hands its text to the
 * turn and starts a reviewed task, as the desktop Work Queue's Start execution does.
 */
export async function approveMobilePlan(input: Extract<MobileRequest, { type: 'approvePlan' }>) {
  const { subChat } = await requireChat(input.chatId, input.subChatId);
  const { messages } = await mobileCallers.chats.getSubChatMessages({
    subChatId: subChat.id,
    limit: 50,
  });
  const plan = findApprovablePlan(messages as PlanMessageLike[], subChat.mode === 'plan');
  if (!plan || plan.planId !== input.planId || subChatActivity(subChat.id) !== 'idle')
    throw new MobileApiError(409, 'This plan changed. Refresh to see the latest one.');
  return sendMobileMessage(
    { ...input, text: PLAN_APPROVAL_EXECUTION_TRIGGER_TEXT },
    { mode: 'agent', approvedPlanContext: plan },
  );
}
