// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useComposerPlaceholder } from './use-composer-placeholder';

let runData: {
  runId: string;
  resumable: boolean;
  resumeMode: 'session' | 'redispatch' | 'queued';
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

  // The placeholder is the only surface naming the typed-resume affordance — losing it would
  // leave Resume looking like the sole recovery path.
  it('restart-interrupted resumable run → typed-resume hint', () => {
    runData = { runId: 'r1', resumable: true, resumeMode: 'session' };
    const { result } = renderHook(() => useComposerPlaceholder('c1', 'sc1', false));
    expect(result.current).toBe(
      'Type to resume with new instructions — or press Resume to continue as-is',
    );
  });

  // The button renames itself to "Re-run step" when nothing can be woken; the placeholder must
  // point at the control the user can actually see and must not promise a typed resume the
  // executor will decline (no session or admission slot to wake into).
  it('queued resume ticket → hint says the step is waiting for a slot', () => {
    runData = { runId: 'r1', resumable: true, resumeMode: 'queued' };
    const { result } = renderHook(() => useComposerPlaceholder('c1', 'sc1', false));
    expect(result.current).toBe('Queued to resume this step — it will pick up where it stopped');
  });

  it('non-resumable mechanism → hint names the re-run button, not typing', () => {
    runData = { runId: 'r1', resumable: true, resumeMode: 'redispatch' };
    const { result } = renderHook(() => useComposerPlaceholder('c1', 'sc1', false));
    expect(result.current).toBe(
      'Press Re-run step to restart this step — typing will not resume it',
    );
  });

  it('user-cancelled (non-resumable) run → normal placeholder', () => {
    runData = { runId: 'r1', resumable: false, resumeMode: 'redispatch' };
    const { result } = renderHook(() => useComposerPlaceholder('c1', 'sc1', false));
    expect(result.current).toBe('Plan, @ for context, / for commands');
  });

  it('no flow run at all → normal placeholder', () => {
    const { result } = renderHook(() => useComposerPlaceholder('c1', 'sc1', false));
    expect(result.current).toBe('Plan, @ for context, / for commands');
  });
});
