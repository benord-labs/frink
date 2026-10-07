// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useComposerPlaceholder } from './use-composer-placeholder';

let runData: {
  runId: string;
  resumable: boolean;
  resumeMode: 'session' | 'continue' | 'retry' | 'queued';
} | null = null;

vi.mock('../trpc', () => ({
  trpc: {
    flows: {
      interruptedRunForChat: { useQuery: () => ({ data: runData }) },
    },
  },
}));

describe('useComposerPlaceholder', () => {
  beforeEach(() => {
    runData = null;
  });

  it('streaming wins: queue hint even while a run is resumable', () => {
    runData = { runId: 'r1', resumable: true, resumeMode: 'session' };
    const { result } = renderHook(() => useComposerPlaceholder('c1', 'sc1', true));
    expect(result.current).toBe('Add to the queue');
  });

  // The placeholder is the only surface naming the typed-continue affordance — losing it would
  // leave the Continue button looking like the sole recovery path.
  it.each(['session', 'continue'] as const)('%s run → typed-continue hint', (resumeMode) => {
    runData = { runId: 'r1', resumable: true, resumeMode };
    const { result } = renderHook(() => useComposerPlaceholder('c1', 'sc1', false));
    expect(result.current).toBe('Type to continue with new instructions — or press Continue');
  });

  it('queued resume ticket → hint says the step is waiting for a slot', () => {
    runData = { runId: 'r1', resumable: true, resumeMode: 'queued' };
    const { result } = renderHook(() => useComposerPlaceholder('c1', 'sc1', false));
    expect(result.current).toBe('Queued to resume this step — it will pick up where it stopped');
  });

  // Retry: nothing of the step reached a session, so the hint names the button, never typing.
  it('retry run → hint names the Retry button, not typing', () => {
    runData = { runId: 'r1', resumable: true, resumeMode: 'retry' };
    const { result } = renderHook(() => useComposerPlaceholder('c1', 'sc1', false));
    expect(result.current).toBe('Press Retry to run this step again');
  });

  it('user-cancelled (non-resumable) run → normal placeholder', () => {
    runData = { runId: 'r1', resumable: false, resumeMode: 'retry' };
    const { result } = renderHook(() => useComposerPlaceholder('c1', 'sc1', false));
    expect(result.current).toBe('Plan, @ for context, / for commands');
  });

  it('no flow run at all → normal placeholder', () => {
    const { result } = renderHook(() => useComposerPlaceholder('c1', 'sc1', false));
    expect(result.current).toBe('Plan, @ for context, / for commands');
  });
});
