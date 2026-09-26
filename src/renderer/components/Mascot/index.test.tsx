// @vitest-environment happy-dom
import { act, fireEvent, render } from '@testing-library/react';
import { createStore, Provider } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { selectedProjectAtom } from '@/features/agents/atoms';
import {
  BUBBLE_SHOW_MS,
  MAX_SUMMONING_MS,
  POKE_LAST_STRAW,
  POKE_QUIP_MS,
  POKE_QUIPS,
  REACTION_QUIPS,
  SPEECH_QUIPS,
  WARP_IN_MS,
  WARP_OUT_MS,
} from './constants';

vi.mock('./sprite', () => {
  const fakeCanvas = {
    toDataURL: () => 'data:image/png;base64,fake',
    width: 12,
    height: 18,
  } as unknown as HTMLCanvasElement;
  return {
    createSpriteFrames: () => ({
      right: [fakeCanvas, fakeCanvas, fakeCanvas],
      width: 72,
      height: 108,
    }),
    SCALE: 6,
    W: 12,
    H: 18,
  };
});

const { MascotWalkOn } = await import('./index');

beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(window, 'innerWidth', { value: 1000, writable: true });
});

afterEach(() => {
  vi.useRealTimers();
});

function renderMascot() {
  const onComplete = vi.fn();
  const view = render(<MascotWalkOn onComplete={onComplete} />);
  return { ...view, onComplete };
}

function bubbleText(container: HTMLElement) {
  return container.querySelector('.ee-tip p')?.textContent ?? null;
}

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

/** Past the warp-in and the opening quip, so Frink is at the board. */
function toBoard() {
  advance(WARP_IN_MS);
  advance(BUBBLE_SHOW_MS);
}

function finishLeaving() {
  advance(WARP_OUT_MS);
  advance(1000);
}

describe('MascotWalkOn', () => {
  it('opens with a quip, goes quiet at the board, then reacts once the proof is done', async () => {
    const { container, onComplete } = renderMascot();

    advance(WARP_IN_MS);
    expect(SPEECH_QUIPS).toContain(bubbleText(container));

    advance(BUBBLE_SHOW_MS);
    expect(bubbleText(container)).toBeNull();

    // The proof finishes on its own clock, before the backstop would move Frink on.
    let atBoardMs = 0;
    while (!REACTION_QUIPS.includes(bubbleText(container) ?? '') && atBoardMs < MAX_SUMMONING_MS) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(250);
      });
      atBoardMs += 250;
    }
    expect(atBoardMs).toBeGreaterThan(8000);
    expect(atBoardMs).toBeLessThan(MAX_SUMMONING_MS);

    advance(6000);
    finishLeaving();
    expect(onComplete).toHaveBeenCalledOnce();
  });

  it('leaves when the curtain is clicked', () => {
    const { container, onComplete } = renderMascot();
    toBoard();

    const curtain = container.querySelector('.ee-curtain');
    expect(curtain).not.toBeNull();
    act(() => {
      if (curtain) fireEvent.click(curtain);
    });
    finishLeaving();

    expect(onComplete).toHaveBeenCalledOnce();
    expect(container.querySelector('.ee-curtain')).toBeNull();
  });

  it('leaves on Escape at the board', () => {
    const { onComplete } = renderMascot();
    toBoard();

    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    finishLeaving();

    expect(onComplete).toHaveBeenCalledOnce();
  });

  // happy-dom has no WebGL, so these exercise the pixel-sprite fallback.
  it('shows the pixel sprite when WebGL is unavailable', () => {
    const { container } = renderMascot();
    expect(container.querySelector('[data-mascot-body] img')).not.toBeNull();
  });

  it('warps straight out when Escape is pressed mid-warp, never reaching the speech bubble', () => {
    const { onComplete, container } = renderMascot();

    advance(WARP_IN_MS / 2);
    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    expect(container.querySelector('[data-mascot-body] img')).toBeNull();

    advance(WARP_IN_MS);
    expect(bubbleText(container)).toBeNull();

    finishLeaving();
    expect(onComplete).toHaveBeenCalledOnce();
  });
});

describe('MascotWalkOn chalkboard stats', () => {
  const STATS = { commits: 10, insertions: 412, deletions: 97 };
  const PROJECT = { id: 'proj-1', name: 'Frink', path: '/frink' };

  function renderWithProject(fetchStats: (path: string) => Promise<typeof STATS>) {
    const store = createStore();
    store.set(selectedProjectAtom, PROJECT);
    return render(
      <Provider store={store}>
        <MascotWalkOn onComplete={vi.fn()} fetchStats={fetchStats} />
      </Provider>,
    );
  }

  it("writes the selected project's diffstat when it arrives before Frink turns to the board", async () => {
    const fetchStats = vi.fn(async () => STATS);
    const { container } = renderWithProject(fetchStats);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(WARP_IN_MS);
    });
    advance(BUBBLE_SHOW_MS);

    expect(fetchStats).toHaveBeenCalledWith(PROJECT.path);
    expect(container.textContent).toContain('+412 − 97');
  });

  it('keeps the generic maths when the stats land after he starts writing', async () => {
    let resolveStats: (stats: typeof STATS) => void = () => {};
    const { container } = renderWithProject(
      () => new Promise((resolve) => (resolveStats = resolve)),
    );
    toBoard();
    await act(async () => {
      resolveStats(STATS);
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(container.textContent).not.toContain('+412');
    expect(container.textContent).toContain('∂code/∂t > 0');
  });

  it("drops the previous project's stats when the selection changes before the board", async () => {
    const store = createStore();
    store.set(selectedProjectAtom, PROJECT);
    const fetchStats = vi.fn((path: string) =>
      path === PROJECT.path ? Promise.resolve(STATS) : new Promise<typeof STATS>(() => {}),
    );
    const { container } = render(
      <Provider store={store}>
        <MascotWalkOn onComplete={vi.fn()} fetchStats={fetchStats} />
      </Provider>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(WARP_IN_MS);
    });
    act(() => {
      store.set(selectedProjectAtom, { ...PROJECT, id: 'proj-2', path: '/other' });
    });
    advance(BUBBLE_SHOW_MS);

    expect(fetchStats).toHaveBeenCalledWith('/other');
    expect(container.textContent).not.toContain('+412');
  });

  it('takes the numbers off the board when the project changes mid-proof', async () => {
    const store = createStore();
    store.set(selectedProjectAtom, PROJECT);
    const fetchStats = vi.fn((path: string) =>
      path === PROJECT.path ? Promise.resolve(STATS) : new Promise<typeof STATS>(() => {}),
    );
    const { container } = render(
      <Provider store={store}>
        <MascotWalkOn onComplete={vi.fn()} fetchStats={fetchStats} />
      </Provider>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(WARP_IN_MS);
    });
    advance(BUBBLE_SHOW_MS);
    expect(container.textContent).toContain('+412 − 97');

    act(() => {
      store.set(selectedProjectAtom, { ...PROJECT, id: 'proj-2', path: '/other' });
    });
    expect(container.textContent).not.toContain('+412');
  });
});

describe('Poking Frink', () => {
  function poke(container: HTMLElement) {
    const target = container.querySelector('[aria-label="Poke Professor Frink"]');
    act(() => {
      if (target) fireEvent.click(target);
    });
  }

  it('makes him complain without sending him away', () => {
    const { container, onComplete } = renderMascot();
    toBoard();

    poke(container);
    expect(POKE_QUIPS).toContain(bubbleText(container));
    advance(POKE_QUIP_MS);
    expect(bubbleText(container)).toBeNull();

    finishLeaving();
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('sends him off on the third poke, keeping the last word up as he goes', () => {
    const { container, onComplete } = renderMascot();
    toBoard();

    poke(container);
    poke(container);
    poke(container);
    expect(bubbleText(container)).toBe(POKE_LAST_STRAW);

    advance(WARP_OUT_MS / 2);
    expect(bubbleText(container)).toBe(POKE_LAST_STRAW);
    finishLeaving();
    expect(onComplete).toHaveBeenCalledOnce();
  });

  it('ignores pokes while he is still warping in', () => {
    const { container } = renderMascot();
    poke(container);
    poke(container);
    poke(container);
    advance(WARP_IN_MS);
    expect(SPEECH_QUIPS).toContain(bubbleText(container));
  });
});
