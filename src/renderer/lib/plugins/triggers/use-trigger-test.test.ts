// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useTriggerTest, type SendTriggerTest } from './use-trigger-test';

const EVENT = { id: 'issue_created', label: 'New issue created' };
const INPUT = { integrationId: 'integration-1', endpointId: 'endpoint-1', event: EVENT };

describe('useTriggerTest', () => {
  it('reports the sent sample without claiming a Flow run has already started', async () => {
    const sent: Array<Parameters<SendTriggerTest>[0]> = [];
    const send: SendTriggerTest = async (input) => {
      sent.push(input);
      return { success: true };
    };

    const { result } = renderHook(() => useTriggerTest(send));
    await act(() => result.current.sendTest(INPUT));

    expect(sent).toEqual([
      { integrationId: 'integration-1', endpointId: 'endpoint-1', eventId: 'issue_created' },
    ]);
    expect(result.current.message).toBe(
      'Sample “New issue created” sent. Matching Flows will run.',
    );
    expect(result.current.isSending).toBe(false);
  });

  it('reports the newest test even when an earlier send resolves after it', async () => {
    const resolvers: Array<(result: { success: true }) => void> = [];
    const send: SendTriggerTest = () => new Promise((resolve) => resolvers.push(resolve));

    const { result } = renderHook(() => useTriggerTest(send));
    const calls: Array<Promise<void>> = [];
    act(() => {
      calls.push(
        result.current.sendTest(INPUT),
        result.current.sendTest({ ...INPUT, event: { id: 'issue_closed', label: 'Issue closed' } }),
      );
    });

    await act(async () => {
      resolvers[1]({ success: true });
      resolvers[0]({ success: true });
      await Promise.all(calls);
    });

    expect(result.current.message).toBe('Sample “Issue closed” sent. Matching Flows will run.');
    expect(result.current.isSending).toBe(false);
  });

  it('says the send failed in the same words whether the call refused or threw, adding the reason when there is one', async () => {
    const reasoned = renderHook(() =>
      useTriggerTest(async () => ({ success: false, error: 'Request timed out' })),
    );
    await act(() => reasoned.result.current.sendTest(INPUT));
    expect(reasoned.result.current.message).toBe(
      'Frink could not send a test New issue created event: Request timed out',
    );

    const refused = renderHook(() => useTriggerTest(async () => ({ success: false })));
    await act(() => refused.result.current.sendTest(INPUT));

    const threw = renderHook(() =>
      useTriggerTest(async () => {
        throw new Error('socket hang up');
      }),
    );
    await act(() => threw.result.current.sendTest(INPUT));

    const failed = 'Frink could not send a test New issue created event.';
    expect(refused.result.current.message).toBe(failed);
    expect(threw.result.current.message).toBe(failed);
  });
});
