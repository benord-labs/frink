import type { UIMessage } from 'ai';
import { isFrinkPlanReadyPart, type MessagePartLike } from '../../shared/types/plan';

/**
 * True when a flow-driven plan-ready card is CURRENTLY parked — i.e. it sits in the newest
 * assistant message. Recency is the currency check: a flow-driven card's status is never
 * rewritten after resume, so scanning the whole transcript would keep matching forever and
 * re-fire the send path's approve-flip on every later send (silently stomping a fresh plan/debug
 * toggle back to agent). While genuinely parked nothing streams after the card; once resumed,
 * the implement turn's messages displace it. Shared by the in-chat Approve gate (usePlanApproval)
 * and the send path (websocket-chat-transport) so a flow plan is handled one way: the run panel
 * OR a chat reply resumes it (approve-then-execute), never the in-chat Approve button. See
 * decision `flow-agent-node-mode`.
 */
export function messagesHaveFlowDrivenPlanReady(messages: UIMessage[]): boolean {
  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
  return (
    lastAssistant != null &&
    Array.isArray(lastAssistant.parts) &&
    (lastAssistant.parts as MessagePartLike[]).some(
      (p) => isFrinkPlanReadyPart(p) && p.input?.flowDriven === true,
    )
  );
}
