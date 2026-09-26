// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { activeListeners } from '../../../../../lib/stores/active-transport-registry';
import { getEffectiveStatus } from './MessageSyncManager';

const SUB = 'sub-effective-status';

afterEach(() => {
  activeListeners.delete(SUB);
});

describe('getEffectiveStatus', () => {
  it('reports streaming for an observed run even though useChat says ready', () => {
    // The wake-burst case: the arming turn's stream closed, so useChat has long since settled to
    // `ready`. Without the override there is no shimmer and every in-flight tool card renders as
    // interrupted while the agent is visibly still working.
    expect(getEffectiveStatus('ready', SUB, true)).toBe('streaming');
  });

  it('never masks an error with an observed run', () => {
    expect(getEffectiveStatus('error', SUB, true)).toBe('error');
  });

  it('still downgrades a stale streaming status when nothing is live', () => {
    expect(getEffectiveStatus('streaming', SUB, false)).toBe('ready');
    expect(getEffectiveStatus('submitted', SUB, false)).toBe('ready');
  });

  it('leaves a transport-owned run streaming', () => {
    activeListeners.set(SUB, () => {});

    expect(getEffectiveStatus('streaming', SUB, false)).toBe('streaming');
  });

  it('passes ready through untouched when nothing is live', () => {
    expect(getEffectiveStatus('ready', SUB, false)).toBe('ready');
  });
});
