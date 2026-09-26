import { describe, expect, it } from 'vitest';
import { type FlowEventSoundArgs, flowEventSound } from './flow-completion-chime';

const away = (over: Partial<FlowEventSoundArgs> = {}): FlowEventSoundArgs => ({
  eventType: 'run_completed',
  soundEnabled: true,
  isViewingThisFlow: false,
  isWindowFocused: false,
  ...over,
});

describe('flowEventSound — event mapping', () => {
  it.each([
    ['run_completed', 'flowComplete'],
    ['run_failed', 'failed'],
    ['run_paused', 'parked'],
  ] as const)('%s → %s while away', (eventType, sound) => {
    expect(flowEventSound(away({ eventType }))).toBe(sound);
  });

  it('batch_completed → batchDone (its own batchId does not suppress it)', () => {
    expect(flowEventSound(away({ eventType: 'batch_completed', batchId: 'b1' }))).toBe('batchDone');
  });

  it('run_cancelled is deliberately silent — cancel is the user’s own action', () => {
    expect(flowEventSound(away({ eventType: 'run_cancelled' }))).toBeNull();
  });

  it('run_started is unwired — the away rule would make a start cue near-permanently silent', () => {
    expect(flowEventSound(away({ eventType: 'run_started' }))).toBeNull();
  });

  it('node-level events never sound', () => {
    expect(flowEventSound(away({ eventType: 'node_completed' }))).toBeNull();
  });

  it('run_paused sounds only for a wait that needs the user', () => {
    // Every kind BUT "waiting on you" is silent. The user's own Pause reaches run_paused via
    // park → watcher → advance; the engine's agent hand-off reaches it on EVERY node advance,
    // which is what made a running flow chime its way down the graph.
    expect(flowEventSound(away({ eventType: 'run_paused', pauseKind: 'user' }))).toBeNull();
    expect(
      flowEventSound(away({ eventType: 'run_paused', pauseKind: 'agent-handoff' })),
    ).toBeNull();
    expect(flowEventSound(away({ eventType: 'run_paused', pauseKind: undefined }))).toBe('parked');
  });
});

describe('flowEventSound — batch-member suppression', () => {
  it.each(['run_completed', 'run_failed', 'run_paused'] as const)(
    'a batch member’s %s is silent (only the batch landing sounds)',
    (eventType) => {
      expect(flowEventSound(away({ eventType, batchId: 'b1' }))).toBeNull();
    },
  );

  it('a standalone run (no batchId) still sounds', () => {
    expect(flowEventSound(away({ eventType: 'run_completed', batchId: null }))).toBe(
      'flowComplete',
    );
  });
});

describe('flowEventSound — gating', () => {
  it('is silent when sound notifications are disabled', () => {
    expect(flowEventSound(away({ soundEnabled: false }))).toBeNull();
  });

  it('is silent when viewing this flow with the window focused', () => {
    expect(flowEventSound(away({ isViewingThisFlow: true, isWindowFocused: true }))).toBeNull();
  });

  it('sounds when viewing this flow in a backgrounded window', () => {
    expect(flowEventSound(away({ isViewingThisFlow: true, isWindowFocused: false }))).toBe(
      'flowComplete',
    );
  });

  it('sounds when focused elsewhere in the app', () => {
    expect(flowEventSound(away({ isViewingThisFlow: false, isWindowFocused: true }))).toBe(
      'flowComplete',
    );
  });
});
