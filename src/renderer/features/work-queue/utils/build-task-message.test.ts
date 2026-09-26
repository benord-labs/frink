import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TriggerContext } from '../../../../shared/types/trigger-context';
import { buildTaskMessage } from './build-task-message';

const buildTriggerSummaryMock = vi.fn();
const buildTriggerBubbleMessageMock = vi.fn();

vi.mock('../../../../shared/lib/trigger-summary', () => ({
  buildTriggerSummary: (...args: unknown[]) => buildTriggerSummaryMock(...args),
}));

vi.mock('../../../../shared/lib/trigger-bubble-marker', () => ({
  buildTriggerBubbleMessage: (...args: unknown[]) => buildTriggerBubbleMessageMock(...args),
}));

function minimalTriggerContext(): TriggerContext {
  return {
    source: 'gmail',
    sourceAccountId: 'a',
    eventType: 'email_received',
    triggeredBy: {},
    timestamp: '2026-01-01T00:00:00.000Z',
    fullContent: { subject: 's' },
    autoStart: false,
  } as TriggerContext;
}

describe('buildTaskMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    buildTriggerSummaryMock.mockReturnValue({ source: 'gmail', provider: 'Gmail', fields: [] });
    buildTriggerBubbleMessageMock.mockReturnValue('[bubble]');
  });

  it('returns description only when there is no trigger context', () => {
    expect(buildTaskMessage({ description: 'Manual task', triggerContext: null })).toBe(
      'Manual task',
    );
    expect(buildTriggerBubbleMessageMock).not.toHaveBeenCalled();
  });

  it('prefixes the bubble marker, then appends the description', () => {
    const result = buildTaskMessage({
      description: 'User-authored task body',
      triggerContext: minimalTriggerContext(),
    });
    expect(result).toBe('[bubble]User-authored task body');
  });

  it('emits just the marker when there is no description', () => {
    const result = buildTaskMessage({ description: null, triggerContext: minimalTriggerContext() });
    expect(result).toBe('[bubble]');
  });
});
