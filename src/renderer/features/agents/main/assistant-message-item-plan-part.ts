import { type FrinkPlanStatus, isFrinkPlanMessagePartType } from '../../../../shared/types/plan';
import type { MessagePart } from '../stores/message-store';

/** Matches `AgentPlanTool` `part` prop shape (see agent-plan-tool.tsx). */
type AgentPlanToolPartValue = {
  type: string;
  toolCallId: string;
  state?: string;
  input?: {
    action?: 'create' | 'update' | 'approve' | 'complete';
    plan?: {
      id: string;
      title: string;
      summary?: string;
      planText?: string;
      status: FrinkPlanStatus;
      /** Flow-driven plan: chat card suppresses Approve (flow run panel owns approval). */
      flowDriven?: boolean;
    };
  };
  output?: {
    success?: boolean;
    message?: string;
  };
};

export function toAgentPlanToolPartFromFrinkPlan(part: MessagePart): AgentPlanToolPartValue | null {
  if (!isFrinkPlanMessagePartType(part.type)) return null;
  if (!part.toolCallId) return null;
  const inp = part.input ?? {};
  return {
    type: 'tool-PlanWrite',
    toolCallId: part.toolCallId,
    state: 'output-available',
    input: {
      action: 'create',
      plan: {
        id: typeof inp.planId === 'string' ? inp.planId : part.toolCallId,
        title: typeof inp.summary === 'string' ? inp.summary : 'Plan ready for review',
        summary: typeof inp.summary === 'string' ? inp.summary : undefined,
        planText: typeof inp.planText === 'string' ? inp.planText : undefined,
        status: (typeof inp.status === 'string'
          ? inp.status
          : 'awaiting_approval') as FrinkPlanStatus,
        ...(inp.flowDriven === true ? { flowDriven: true } : {}),
      },
    },
    output: { success: true },
  };
}
