import { describe, expect, it } from 'vitest';
import type { MessagePart } from '../stores/message-store';
import { toAgentPlanToolPartFromFrinkPlan } from './assistant-message-item-plan-part';

describe('toAgentPlanToolPartFromFrinkPlan', () => {
  it('maps the persisted plan onto the card props, keeping the plan text verbatim', () => {
    const part: MessagePart = {
      type: 'tool-frink-plan',
      toolCallId: 'p1',
      input: {
        planId: 'plan-1',
        summary: 'Short preview',
        planText: '## Context\n- Not a todo',
        status: 'awaiting_approval',
        flowDriven: true,
      },
    };

    expect(toAgentPlanToolPartFromFrinkPlan(part)?.input?.plan).toEqual({
      id: 'plan-1',
      title: 'Short preview',
      summary: 'Short preview',
      planText: '## Context\n- Not a todo',
      status: 'awaiting_approval',
      flowDriven: true,
    });
  });

  it('ignores parts that are not Frink plans', () => {
    const part: MessagePart = { type: 'tool-PlanWrite', toolCallId: 'p1', input: {} };
    expect(toAgentPlanToolPartFromFrinkPlan(part)).toBeNull();
  });
});
