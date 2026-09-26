// @vitest-environment happy-dom
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CAMEO_PAUSE_MS } from './constants';

// Guard: even if a test accidentally imports something that pulls trpc, we want
// to know that the cameo itself never invokes chats.create.
const createMutateMock = vi.fn();

vi.mock('@/lib/trpc', () => ({
  trpcClient: {
    chats: {
      create: { mutate: (...args: unknown[]) => createMutateMock(...args) },
      get: { query: vi.fn() },
    },
  },
}));

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

let rafCallbacks: Array<(ts: number) => void> = [];
let rafId = 0;

const { MascotCameo } = await import('./MascotCameo');

function flushRaf(timestamp: number) {
  const cbs = [...rafCallbacks];
  rafCallbacks = [];
  for (const cb of cbs) cb(timestamp);
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  createMutateMock.mockClear();
  rafCallbacks = [];
  rafId = 0;
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
    rafCallbacks.push(cb);
    return ++rafId;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
  Object.defineProperty(window, 'innerWidth', { value: 1000, writable: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('MascotCameo', () => {
  it('mounts with no fullscreen blocking overlay', () => {
    render(<MascotCameo onComplete={vi.fn()} />);
    expect(document.querySelector('.ee-curtain')).toBeNull();
    expect(screen.getByTestId('ee-c8b4')).not.toBeNull();
  });

  it('walks in, shows the silent ... bubble during pause, then walks off and calls onComplete', () => {
    const onComplete = vi.fn();
    render(<MascotCameo onComplete={onComplete} />);

    // Walk-in: flush enough rAF frames to reach pauseX.
    act(() => {
      for (let i = 0; i < 200; i++) flushRaf(i * 17);
    });

    // Bubble appears once we hit pause.
    expect(screen.getByText('...')).not.toBeNull();

    // Pause expires → walk-out begins.
    act(() => {
      vi.advanceTimersByTime(CAMEO_PAUSE_MS + 50);
    });

    // Walk-out: flush more rAF frames so position exceeds innerWidth + 120.
    act(() => {
      for (let i = 0; i < 400; i++) flushRaf(20_000 + i * 17);
    });

    // Done → onComplete fires after EXIT_COMPLETE_DELAY_MS.
    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(onComplete).toHaveBeenCalled();
  });

  it('never calls chats.create.mutate', () => {
    render(<MascotCameo onComplete={vi.fn()} />);
    act(() => {
      for (let i = 0; i < 200; i++) flushRaf(i * 17);
    });
    act(() => {
      vi.advanceTimersByTime(CAMEO_PAUSE_MS + 50);
    });
    act(() => {
      for (let i = 0; i < 400; i++) flushRaf(20_000 + i * 17);
    });
    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(createMutateMock).not.toHaveBeenCalled();
  });
});
