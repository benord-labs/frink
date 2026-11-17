import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearFlowRunEndedAnnouncementsForTests,
  isFlowRunEndedNoticeDue,
  markFlowRunEndAnnounced,
} from './flow-run-ended';

const due = (overrides: Partial<Parameters<typeof isFlowRunEndedNoticeDue>[0]> = {}) =>
  isFlowRunEndedNoticeDue({
    subChatId: 'chat',
    endedFlowRunId: 'run-a',
    hasResumeSession: true,
    agentSawPriorTurns: true,
    hasBriefing: true,
    ...overrides,
  });

describe('isFlowRunEndedNoticeDue', () => {
  beforeEach(() => clearFlowRunEndedAnnouncementsForTests());

  it('is due on the first turn after a run ends, and not before one has', () => {
    expect(due()).toBe(true);
    expect(due({ endedFlowRunId: null })).toBe(false);
  });

  it('is not due again on the same session once announced', () => {
    markFlowRunEndAnnounced('chat', 'run-a');
    expect(due()).toBe(false);
    expect(due({ subChatId: 'other-chat' })).toBe(true);
  });

  it('is due again on a new session, which still carries the briefing', () => {
    markFlowRunEndAnnounced('chat', 'run-a');
    expect(due({ hasResumeSession: false })).toBe(true);
  });

  it('is due for a later run that ends on the same chat', () => {
    markFlowRunEndAnnounced('chat', 'run-a');
    expect(due({ endedFlowRunId: 'run-b' })).toBe(true);
  });

  it('is not due when the agent has neither prior turns nor a briefing to correct', () => {
    expect(due({ agentSawPriorTurns: false, hasBriefing: false })).toBe(false);
    expect(due({ agentSawPriorTurns: false, hasBriefing: true })).toBe(true);
  });
});
