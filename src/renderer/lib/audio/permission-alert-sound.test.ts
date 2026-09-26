import { describe, expect, it } from 'vitest';
import { type PermissionAlertArgs, shouldAlertOnPermissionRequest } from './permission-alert-sound';

const args = (overrides: Partial<PermissionAlertArgs> = {}): PermissionAlertArgs => ({
  soundEnabled: true,
  isWindowFocused: false,
  isNew: true,
  ...overrides,
});

describe('shouldAlertOnPermissionRequest', () => {
  it('new request while away with sound on: alerts', () => {
    expect(shouldAlertOnPermissionRequest(args())).toBe(true);
  });

  it('window focused: silent (user can see the card)', () => {
    expect(shouldAlertOnPermissionRequest(args({ isWindowFocused: true }))).toBe(false);
  });

  it('sound disabled: silent even when away', () => {
    expect(shouldAlertOnPermissionRequest(args({ soundEnabled: false }))).toBe(false);
  });

  it('already-seen request (cycling the queue): silent', () => {
    expect(shouldAlertOnPermissionRequest(args({ isNew: false }))).toBe(false);
  });
});
