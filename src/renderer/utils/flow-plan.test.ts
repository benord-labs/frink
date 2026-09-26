import type { UIMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import { messagesHaveFlowDrivenPlanReady } from './flow-plan';

function assistantWithPlan(input: Record<string, unknown>): UIMessage {
  return {
    id: 'm1',
    role: 'assistant',
    parts: [{ type: 'tool-frink-plan', input } as never],
  } as UIMessage;
}

describe('messagesHaveFlowDrivenPlanReady', () => {
  it('is true for a flow-driven plan-ready card', () => {
    const messages = [assistantWithPlan({ status: 'awaiting_approval', flowDriven: true })];
    expect(messagesHaveFlowDrivenPlanReady(messages)).toBe(true);
  });

  it('is false when the plan-ready card is not flow-driven', () => {
    const messages = [assistantWithPlan({ status: 'awaiting_approval', flowDriven: false })];
    expect(messagesHaveFlowDrivenPlanReady(messages)).toBe(false);
  });

  it('is false when the plan is not awaiting approval (already approved/draft)', () => {
    const messages = [assistantWithPlan({ status: 'approved', flowDriven: true })];
    expect(messagesHaveFlowDrivenPlanReady(messages)).toBe(false);
  });

  it('is false for an empty transcript', () => {
    expect(messagesHaveFlowDrivenPlanReady([])).toBe(false);
  });

  it('is false once a later assistant message displaces the card (resumed flow)', () => {
    // A flow-driven card's status is never rewritten, so recency is the only currency signal:
    // a historical card must not re-trigger the send path's approve-flip forever.
    const messages = [
      assistantWithPlan({ status: 'awaiting_approval', flowDriven: true }),
      { id: 'm2', role: 'assistant', parts: [{ type: 'text', text: 'implementing…' }] } as never,
    ];
    expect(messagesHaveFlowDrivenPlanReady(messages as UIMessage[])).toBe(false);
  });

  it('remains true when only user replies follow the parked card', () => {
    const messages = [
      assistantWithPlan({ status: 'awaiting_approval', flowDriven: true }),
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'carry on' }] } as never,
    ];
    expect(messagesHaveFlowDrivenPlanReady(messages as UIMessage[])).toBe(true);
  });
});
