// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { type AutoModeContext, useAutoModeAvailability } from './index';

function availability(overrides: Partial<AutoModeContext> = {}) {
  return renderHook(() =>
    useAutoModeAvailability({
      accountResolved: true,
      account: { type: 'claude-code', isAuthenticated: true },
      selectedModelId: 'sonnet',
      ...overrides,
    }),
  ).result.current;
}

describe('useAutoModeAvailability', () => {
  it('reports available with an empty reason so the toggle has nothing to explain', () => {
    expect(availability()).toEqual({ available: true, unavailableReason: '' });
  });

  // The account may legitimately be absent (never connected) or null (resolved to nothing). Both
  // must reach the connect-an-account reason rather than being read as an unsupported provider.
  it.each([[null], [undefined]])(
    'treats a %s account as not connected, not unsupported',
    (account) => {
      expect(availability({ account })).toEqual({
        available: false,
        unavailableReason: 'Connect an account to use Auto Mode.',
      });
    },
  );

  // Guards the mapping itself: type and isAuthenticated are separate fields on one object, and
  // transposing them would silently make every signed-in chat look eligible.
  it('maps the account type through, so an unsupported model is refused as one', () => {
    expect(
      availability({
        account: { type: 'claude-code', isAuthenticated: true },
        selectedModelId: 'haiku',
      }),
    ).toEqual({
      available: false,
      unavailableReason: 'The selected provider or model does not support Auto Mode.',
    });
  });

  it('holds off while the account is still resolving', () => {
    expect(availability({ accountResolved: false }).unavailableReason).toBe(
      'Checking whether Auto Mode is available.',
    );
  });
});
