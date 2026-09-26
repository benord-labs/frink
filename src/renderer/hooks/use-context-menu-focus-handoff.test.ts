// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useContextMenuFocusHandoff } from './use-context-menu-focus-handoff';

describe('useContextMenuFocusHandoff', () => {
  it('does not prevent close auto-focus by default', () => {
    const { result } = renderHook(() => useContextMenuFocusHandoff());
    const event = new Event('focus');
    const preventSpy = vi.spyOn(event, 'preventDefault');

    act(() => {
      result.current.handleCloseAutoFocus(event);
    });

    expect(preventSpy).not.toHaveBeenCalled();
  });

  it('prevents close auto-focus once after markNextCloseForInputFocus', () => {
    const { result } = renderHook(() => useContextMenuFocusHandoff());
    const event1 = new Event('focus');
    const prevent1 = vi.spyOn(event1, 'preventDefault');

    act(() => {
      result.current.markNextCloseForInputFocus();
    });

    act(() => {
      result.current.handleCloseAutoFocus(event1);
    });

    expect(prevent1).toHaveBeenCalledTimes(1);

    // Second call should NOT prevent (one-shot behaviour)
    const event2 = new Event('focus');
    const prevent2 = vi.spyOn(event2, 'preventDefault');

    act(() => {
      result.current.handleCloseAutoFocus(event2);
    });

    expect(prevent2).not.toHaveBeenCalled();
  });
});
