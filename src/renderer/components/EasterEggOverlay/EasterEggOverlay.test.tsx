// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createStore, Provider } from 'jotai';
import { type ReactNode, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  arcadeRunAtom,
  floatingBadgeActiveAtom,
  KONAMI_SEQUENCE,
  mascotCameoActiveAtom,
  mascotChaserActiveAtom,
  mascotWalkOnActiveAtom,
} from '../../hooks/use-easter-eggs';
import { hasOpenDialogLayer } from '@/lib/has-open-dialog-layer';

const FloatingBadgeMock = vi.fn(({ onDismiss }: { onDismiss: () => void }) => (
  <button type="button" data-testid="floating-badge" onClick={onDismiss} />
));
vi.mock('../FloatingBadge', () => ({
  FloatingBadge: (...args: Parameters<typeof FloatingBadgeMock>) => FloatingBadgeMock(...args),
}));

vi.mock('../Mascot', () => ({
  MascotWalkOn: () => null,
}));

// Lightweight test doubles for the cameo + enraged components — we want to
// observe their mounted state and exit lifecycle, not their internal animation.
vi.mock('../Mascot/MascotCameo', () => ({
  MascotCameo: ({ onComplete }: { onComplete: () => void }) => (
    <button
      type="button"
      data-testid="mascot-cameo"
      onClick={onComplete}
      aria-label="cameo onComplete"
    />
  ),
}));

vi.mock('../Mascot/MascotChaser', () => ({
  MascotChaser: ({
    isExiting,
    onExitComplete,
  }: {
    isExiting?: boolean;
    onExitComplete?: () => void;
  }) => (
    <button
      type="button"
      data-testid="mascot-chaser"
      data-exiting={isExiting ? 'true' : 'false'}
      onClick={onExitComplete}
      aria-label="enraged exit"
    />
  ),
}));

const { EasterEggOverlay, EasterEggBoundary } = await import('.');

// Helpers

function storeWrapper(store: ReturnType<typeof createStore>) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <Provider store={store}>{children}</Provider>;
  };
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  // Midday, so no test meets the 3am cameo by running at the host's real hour.
  vi.setSystemTime(new Date(2026, 5, 15, 12, 0));
  FloatingBadgeMock.mockImplementation(({ onDismiss }: { onDismiss: () => void }) => (
    <button type="button" data-testid="floating-badge" onClick={onDismiss} />
  ));
  vi.spyOn(window, 'matchMedia').mockReturnValue({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as MediaQueryList);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Bug Invaders', () => {
  async function renderOverlay(store: ReturnType<typeof createStore>) {
    const Wrapper = storeWrapper(store);
    const view = render(
      <Wrapper>
        <EasterEggOverlay />
      </Wrapper>,
    );
    return view;
  }

  function konami() {
    for (const code of KONAMI_SEQUENCE) {
      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { code, key: code }));
      });
    }
  }

  it('opens the game on the Konami code, and Escape quits back to where focus was', async () => {
    const store = createStore();
    await renderOverlay(store);
    const composer = document.createElement('textarea');
    document.body.append(composer);
    composer.focus();

    konami();
    const game = await screen.findByRole('dialog', { name: /Bug Invaders/ });
    // Flush the lazy dialog's effects, where it takes focus.
    await act(async () => {});
    expect(screen.getByText('Stage 1')).not.toBeNull();
    expect(document.activeElement).toBe(game);

    act(() => {
      fireEvent.keyDown(window, { key: 'Escape', code: 'Escape' });
    });
    expect(store.get(arcadeRunAtom)).toBeNull();
    expect(document.activeElement).toBe(composer);
    composer.remove();
  });

  it('keeps game keys away from the app while it runs', async () => {
    const store = createStore();
    store.set(arcadeRunAtom, 1);
    await renderOverlay(store);
    await screen.findByRole('dialog', { name: /Bug Invaders/ });
    const appListener = vi.fn();
    window.addEventListener('keydown', appListener);

    act(() => {
      fireEvent.keyDown(window, { key: ' ', code: 'Space' });
      fireEvent.keyDown(window, { key: 'ArrowLeft', code: 'ArrowLeft' });
    });
    expect(appListener).not.toHaveBeenCalled();
    window.removeEventListener('keydown', appListener);
    // Capture-phase app handlers that run first honour an open dialog layer.
    expect(hasOpenDialogLayer()).toBe(true);
  });

  it('never starts HELPFRINK over a running game', async () => {
    const store = createStore();
    store.set(arcadeRunAtom, 1);
    await renderOverlay(store);
    await screen.findByRole('dialog', { name: /Bug Invaders/ });
    for (const code of ['KeyH', 'KeyE', 'KeyL', 'KeyP', 'KeyF', 'KeyR', 'KeyI', 'KeyN', 'KeyK']) {
      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { code, key: code }));
      });
    }
    expect(store.get(mascotWalkOnActiveAtom)).toBe(false);
  });

  it('waits for HELPFRINK to finish before starting a game', async () => {
    const store = createStore();
    store.set(mascotWalkOnActiveAtom, true);
    await renderOverlay(store);
    konami();
    expect(store.get(arcadeRunAtom)).toBeNull();
  });
});

// Spam-clicking 15 → 30 inside the cameo's runtime would put two Frinks on screen;
// enraged starting must cancel the cameo.

describe('Cameo + Enraged coordination', () => {
  it('cancels an active cameo when enraged starts', () => {
    const store = createStore();
    store.set(mascotCameoActiveAtom, true);

    const Wrapper = storeWrapper(store);
    render(
      <Wrapper>
        <EasterEggOverlay />
      </Wrapper>,
    );

    expect(screen.queryByTestId('mascot-cameo')).not.toBeNull();

    act(() => {
      store.set(mascotChaserActiveAtom, true);
    });

    expect(screen.queryByTestId('mascot-cameo')).toBeNull();
    expect(store.get(mascotCameoActiveAtom)).toBe(false);
    expect(screen.queryByTestId('mascot-chaser')).not.toBeNull();
  });
});

// When the 15s click decay clears the enraged atom, MascotChaser must stay mounted in
// 'exiting' mode until onExitComplete rather than vanish mid-pursuit.

describe('Enraged Frink walk-off lifecycle', () => {
  it('keeps MascotChaser mounted with isExiting=true after the atom flips false', () => {
    const store = createStore();
    store.set(mascotChaserActiveAtom, true);

    const Wrapper = storeWrapper(store);
    render(
      <Wrapper>
        <EasterEggOverlay />
      </Wrapper>,
    );

    const initial = screen.getByTestId('mascot-chaser');
    expect(initial.dataset.exiting).toBe('false');

    act(() => {
      store.set(mascotChaserActiveAtom, false);
    });

    // Still mounted, but now in exiting mode — Frink is walking off-screen.
    const exiting = screen.queryByTestId('mascot-chaser');
    expect(exiting).not.toBeNull();
    expect(exiting?.dataset.exiting).toBe('true');
  });

  it('unmounts MascotChaser only after onExitComplete fires', () => {
    const store = createStore();
    store.set(mascotChaserActiveAtom, true);

    const Wrapper = storeWrapper(store);
    render(
      <Wrapper>
        <EasterEggOverlay />
      </Wrapper>,
    );

    act(() => {
      store.set(mascotChaserActiveAtom, false);
    });

    const stillMounted = screen.getByTestId('mascot-chaser');
    expect(stillMounted).not.toBeNull();

    // The mock's click fires onExitComplete.
    act(() => {
      stillMounted.click();
    });

    expect(screen.queryByTestId('mascot-chaser')).toBeNull();
  });

  it('cancels exiting state if enraged fires again before walk-off completes', () => {
    const store = createStore();
    store.set(mascotChaserActiveAtom, true);

    const Wrapper = storeWrapper(store);
    render(
      <Wrapper>
        <EasterEggOverlay />
      </Wrapper>,
    );

    act(() => {
      store.set(mascotChaserActiveAtom, false);
    });
    expect(screen.getByTestId('mascot-chaser').dataset.exiting).toBe('true');

    // User starts spamming the logo again before Frink finishes walking off.
    act(() => {
      store.set(mascotChaserActiveAtom, true);
    });

    expect(screen.getByTestId('mascot-chaser').dataset.exiting).toBe('false');
  });
});

// One egg throwing must not kill egg rendering for good: the boundary recovers when
// the active-egg set changes.

describe('EasterEggBoundary recovery', () => {
  it('recovers from error when children change', () => {
    const store = createStore();
    const Wrapper = storeWrapper(store);
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Make FloatingBadge throw on render.
    FloatingBadgeMock.mockImplementation(() => {
      throw new Error('canvas tainting');
    });

    render(
      <Wrapper>
        <EasterEggOverlay />
      </Wrapper>,
    );

    // Activate DVD bounce — it will throw and the boundary catches it.
    act(() => {
      store.set(floatingBadgeActiveAtom, true);
    });

    // Boundary caught the error — everything is hidden.
    expect(screen.queryByTestId('floating-badge')).toBeNull();
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('[easter-eggs]'), expect.any(Error));

    // Restore healthy mock, then change children by deactivating.
    FloatingBadgeMock.mockImplementation(({ onDismiss }: { onDismiss: () => void }) => (
      <button type="button" data-testid="floating-badge" onClick={onDismiss} />
    ));

    act(() => {
      store.set(floatingBadgeActiveAtom, false);
    });

    // Re-activate — boundary has recovered, renders successfully.
    act(() => {
      store.set(floatingBadgeActiveAtom, true);
    });

    expect(screen.queryByTestId('floating-badge')).not.toBeNull();

    spy.mockRestore();
  });

  it('does not recover on re-render when recoveryKey is unchanged (children ref differs)', async () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    function Thrower({ n }: { n: number }): React.ReactElement {
      void n;
      throw new Error('boom');
    }

    function Harness() {
      const [n, setN] = useState(0);
      return (
        <>
          <button type="button" data-testid="bump-rerender" onClick={() => setN((x) => x + 1)}>
            bump
          </button>
          <EasterEggBoundary recoveryKey="stable">
            <Thrower n={n} />
          </EasterEggBoundary>
        </>
      );
    }

    render(<Harness />);
    expect(spy).toHaveBeenCalledTimes(1);

    await act(async () => {
      screen.getByTestId('bump-rerender').click();
    });

    // Old behavior cleared hasError whenever prevProps.children !== this.props.children,
    // which re-threw and logged again on every parent re-render.
    expect(spy).toHaveBeenCalledTimes(1);

    spy.mockRestore();
  });
});

describe('Late-night cameo', () => {
  let jotai: typeof import('jotai');
  let eggs: typeof import('../../hooks/use-easter-eggs');
  let Overlay: typeof EasterEggOverlay;

  // A fresh module graph per test: the cameo remembers it was shown for the whole session.
  beforeEach(async () => {
    localStorage.clear();
    vi.resetModules();
    jotai = await import('jotai');
    eggs = await import('../../hooks/use-easter-eggs');
    ({ EasterEggOverlay: Overlay } = await import('.'));
  });

  // Mid-June has no daylight-saving switch in any zone, so 03:15 exists on every host.
  function atQuarterPastThree(day: number) {
    vi.setSystemTime(new Date(2026, 5, day, 3, 15));
    expect(new Date().getHours()).toBe(3);
  }

  function renderWith(store: ReturnType<typeof jotai.createStore>) {
    return render(
      <jotai.Provider store={store}>
        <Overlay />
      </jotai.Provider>,
    );
  }

  it('sends Frink by at 3am, but not while another Frink is on screen', () => {
    atQuarterPastThree(15);
    const busy = jotai.createStore();
    busy.set(eggs.mascotChaserActiveAtom, true);
    const first = renderWith(busy);
    expect(screen.queryByTestId('mascot-cameo')).toBeNull();
    first.unmount();

    renderWith(jotai.createStore());
    expect(screen.queryByTestId('mascot-cameo')).not.toBeNull();
  });

  it('stays away while the arcade is open, and still shows once it closes', () => {
    atQuarterPastThree(17);
    const arcade = jotai.createStore();
    arcade.set(eggs.arcadeRunAtom, 1);
    const first = renderWith(arcade);
    expect(screen.queryByTestId('mascot-cameo')).toBeNull();
    first.unmount();

    renderWith(jotai.createStore());
    expect(screen.queryByTestId('mascot-cameo')).not.toBeNull();
  });
});
