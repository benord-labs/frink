// @vitest-environment happy-dom
/**
 * The pending transition intent's arm/ack semantics against the REAL jotai store:
 * fill-the-gap arming (a flow flip never overwrites an explicit toggle) and CAS acking (a
 * stale ack never wipes an intent armed after the acked operation started).
 */
import { describe, expect, it } from 'vitest';
import { appStore } from '../jotai-store';
import {
  ackModeIntent,
  armModeIntentIfEmpty,
  pendingModeIntentAtomFamily,
  takeModeIntentForSend,
} from './mode-intent';

describe('armModeIntentIfEmpty', () => {
  it('arms when nothing is pending and reports success', () => {
    expect(armModeIntentIfEmpty('arm-1', 'agent')).toBe(true);
    expect(appStore.get(pendingModeIntentAtomFamily('arm-1'))).toBe('agent');
  });

  it('never overwrites an explicitly armed toggle', () => {
    appStore.set(pendingModeIntentAtomFamily('arm-2'), 'debug');
    expect(armModeIntentIfEmpty('arm-2', 'agent')).toBe(false);
    expect(appStore.get(pendingModeIntentAtomFamily('arm-2'))).toBe('debug');
  });
});

describe('ackModeIntent', () => {
  it('clears the exact intent the ack refers to', () => {
    appStore.set(pendingModeIntentAtomFamily('ack-1'), 'agent');
    ackModeIntent('ack-1', 'agent');
    expect(appStore.get(pendingModeIntentAtomFamily('ack-1'))).toBeNull();
  });

  it('a stale ack never wipes a newer intent (CAS on the carried value)', () => {
    appStore.set(pendingModeIntentAtomFamily('ack-2'), 'debug');
    ackModeIntent('ack-2', 'agent');
    expect(appStore.get(pendingModeIntentAtomFamily('ack-2'))).toBe('debug');
  });
});

describe('takeModeIntentForSend', () => {
  it('returns the armed intent and undefined when none is pending', () => {
    appStore.set(pendingModeIntentAtomFamily('take-1'), 'plan');
    expect(takeModeIntentForSend('take-1')).toBe('plan');
    expect(takeModeIntentForSend('take-none')).toBeUndefined();
  });
});
