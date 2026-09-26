// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createStore, Provider } from 'jotai';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { floatingBadgeActiveAtom } from '@/hooks/use-easter-eggs';

import { SidebarHeader } from './index';

// The outer shell pulls in tooltip/input/kbd plumbing that's irrelevant to the
// long-press × dodge wiring. Render the titleIcon plus a bare input carrying the
// placeholder, which is the only other prop this suite asserts on.
vi.mock('../../../components/SidebarHeaderWithSearch', () => ({
  SidebarHeaderWithSearch: ({
    titleIcon,
    searchPlaceholder,
  }: {
    titleIcon: ReactNode;
    searchPlaceholder: string;
  }) => (
    <>
      {titleIcon}
      <input placeholder={searchPlaceholder} />
    </>
  ),
}));

// happy-dom doesn't ship ResizeObserver. The layout measurement in
// SidebarHeader isn't under test — a no-op stub is enough.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function storeWrapper(store: ReturnType<typeof createStore>) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <Provider store={store}>{children}</Provider>;
  };
}

function renderHeader(store: ReturnType<typeof createStore>, showArchived = false) {
  const Wrapper = storeWrapper(store);
  const searchInputRef = { current: null };
  return render(
    <Wrapper>
      <SidebarHeader
        searchQuery=""
        onSearchChange={() => {}}
        searchInputRef={searchInputRef}
        showArchived={showArchived}
      />
    </Wrapper>,
  );
}

/**
 * FrinkLogo renders as <svg role="img" aria-label="Frink">. The pointerdown /
 * pointerup handlers live on the wrapper div one level up; that's the hitbox
 * the user actually presses.
 */
function getLogoHitbox(): HTMLElement {
  const logo = screen.getByRole('img', { name: 'Frink' });
  const wrapper = logo.parentElement;
  if (!wrapper) throw new Error('Logo wrapper not found');
  return wrapper;
}

function press(hitbox: HTMLElement) {
  fireEvent.pointerDown(hitbox, { pointerId: 1 });
}

function release(hitbox: HTMLElement) {
  fireEvent.pointerUp(hitbox, { pointerId: 1 });
}

function tap(hitbox: HTMLElement) {
  act(() => {
    press(hitbox);
    release(hitbox);
  });
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('SidebarHeader — search placeholder scope', () => {
  it('announces the archive scope only while archived mode is on', () => {
    renderHeader(createStore(), true);
    expect(screen.getByPlaceholderText('Search archived...')).toBeTruthy();
    cleanup();

    renderHeader(createStore(), false);
    expect(screen.getByPlaceholderText('Search...')).toBeTruthy();
  });
});

describe('SidebarHeader — floating badge long-press × logo dodge wiring', () => {
  // Regression: the `[phase]` effect used to clear the long-press timer on
  // EVERY phase change, including the idle→tease transition that fires on
  // the very first pointerdown. That killed the 3.5s DVD trigger outright
  // — the primary symptom the user reported.
  it('fires DVD after a 3.5s hold from fresh idle state', async () => {
    const store = createStore();
    renderHeader(store);
    const hitbox = getLogoHitbox();

    act(() => {
      press(hitbox);
    });
    expect(store.get(floatingBadgeActiveAtom)).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(store.get(floatingBadgeActiveAtom)).toBe(true);
  });

  // Prior taps that stay below the dodge threshold (DODGE_AFTER_CLICKS = 3)
  // leave the phase 'idle', so a genuine hold must still arm and fire DVD.
  // Only crossing into 'active' (≥3 clicks) cancels the long-press.
  it('fires DVD after a 3.5s hold following sub-threshold taps', async () => {
    const store = createStore();
    renderHeader(store);
    const hitbox = getLogoHitbox();

    // 1 tap — count = 1, still below the 3-click dodge threshold → phase idle.
    tap(hitbox);

    // 2nd press is the held one — count = 2, still idle, so the hold arms.
    act(() => {
      press(hitbox);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(store.get(floatingBadgeActiveAtom)).toBe(true);
  });

  it('does not fire DVD when the press is released before 3.5s', () => {
    const store = createStore();
    renderHeader(store);
    const hitbox = getLogoHitbox();

    act(() => {
      press(hitbox);
    });
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    act(() => {
      release(hitbox);
    });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(store.get(floatingBadgeActiveAtom)).toBe(false);
  });

  // Once the user has crossed into dodge, holding should NOT trigger DVD —
  // they're clearly spamming the logo, not doing a long-press. The handler's
  // armLongPress guard enforces this.
  it('does not arm DVD when already in dodge phase', () => {
    const store = createStore();
    renderHeader(store);
    const hitbox = getLogoHitbox();

    // 8 taps → dodge phase.
    for (let i = 0; i < 8; i++) tap(hitbox);

    // 9th press, held. phaseRef is 'dodge' so armLongPress is false.
    act(() => {
      press(hitbox);
    });
    act(() => {
      vi.advanceTimersByTime(3500);
    });
    expect(store.get(floatingBadgeActiveAtom)).toBe(false);
  });

  // The escalation-clearing path still matters after the fix: if a single
  // press crosses tease→dodge (i.e. it's click #8), armLongPress reads
  // 'tease' and arms the timer, THEN the dodge hook flips phase to 'dodge',
  // and the effect must invalidate the now-illegitimate pending timer.
  it('cancels the long-press timer when the same press escalates into dodge', () => {
    const store = createStore();
    renderHeader(store);
    const hitbox = getLogoHitbox();

    // 7 taps — count = 7, phase stays tease.
    for (let i = 0; i < 7; i++) tap(hitbox);

    // 8th press: phaseRef is still 'tease' at armLongPress time, so the
    // timer is armed. registerDodgePointerDown then flips phase to 'dodge',
    // which must wipe the timer.
    act(() => {
      press(hitbox);
    });
    act(() => {
      vi.advanceTimersByTime(3500);
    });
    expect(store.get(floatingBadgeActiveAtom)).toBe(false);
  });
});
