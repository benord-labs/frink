// @vitest-environment happy-dom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  };
});

let rafCallbacks: Array<(ts: number) => void> = [];
let rafId = 0;

const { MascotChaser } = await import('./MascotChaser');

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
  Object.defineProperty(window, 'innerHeight', { value: 800, writable: true });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('MascotChaser', () => {
  it('mounts with no fullscreen blocking overlay and pointer-events disabled', () => {
    render(<MascotChaser />);
    const root = screen.getByTestId('ee-e5d2');
    expect(root).not.toBeNull();
    expect(root.className).toMatch(/pointer-events-none/);
  });

  it('walks toward the cursor at a constant speed (not lerp)', () => {
    render(<MascotChaser />);

    const dispatchMove = (x: number, y: number) => {
      window.dispatchEvent(
        new PointerEvent('pointermove', { clientX: x, clientY: y, pointerType: 'mouse' }),
      );
    };

    act(() => {
      dispatchMove(500, 400);
    });

    // Frink starts off-screen left and walks right toward the cursor at
    // a constant speed irrespective of cursor velocity.
    act(() => {
      for (let i = 0; i < 60; i++) flushRaf(i * 17);
    });

    const wrapper = screen.getByTestId('ee-e5d2').firstChild as HTMLElement;
    const transform = wrapper.style.transform;
    expect(transform).toMatch(/translate3d\(/);
    const match = transform.match(/translate3d\(([-\d.]+)px,\s*([-\d.]+)px/);
    expect(match).not.toBeNull();
    if (match) {
      const x = Number.parseFloat(match[1]);
      // Has moved meaningfully from the initial x = -160.
      expect(x).toBeGreaterThan(0);
    }
  });

  it('does not collapse onto the cursor (keeps a personal-space buffer)', () => {
    render(<MascotChaser />);

    const dispatchMove = (x: number, y: number) => {
      window.dispatchEvent(
        new PointerEvent('pointermove', { clientX: x, clientY: y, pointerType: 'mouse' }),
      );
    };

    act(() => {
      dispatchMove(500, 400);
    });

    // Run for a long time so Frink has every chance to reach the cursor.
    act(() => {
      for (let i = 0; i < 600; i++) flushRaf(i * 17);
    });

    const wrapper = screen.getByTestId('ee-e5d2').firstChild as HTMLElement;
    const match = wrapper.style.transform.match(/translate3d\(([-\d.]+)px,\s*([-\d.]+)px/);
    expect(match).not.toBeNull();
    if (match) {
      const x = Number.parseFloat(match[1]);
      const y = Number.parseFloat(match[2]);
      // Sprite anchors above the cursor (sprite.height + 40 px above), so the
      // pure cursor-to-sprite distance still includes the offset. We assert
      // the sprite never matches the cursor (x,y) exactly.
      const distFromCursor = Math.hypot(500 - x, 400 - y);
      expect(distFromCursor).toBeGreaterThan(40);
    }
  });

  it('never calls chats.create.mutate', () => {
    render(<MascotChaser />);
    act(() => {
      for (let i = 0; i < 60; i++) flushRaf(i * 17);
    });
    expect(createMutateMock).not.toHaveBeenCalled();
  });

  it('renders the smoke puffs and red-tint sprite', () => {
    const { container } = render(<MascotChaser />);
    expect(container.querySelectorAll('.ee-fury-puff').length).toBeGreaterThanOrEqual(3);
    expect(container.querySelector('.ee-fury-tint')).not.toBeNull();
  });

  it('walks off-screen left when isExiting becomes true', () => {
    const dispatchMove = (x: number, y: number) => {
      window.dispatchEvent(
        new PointerEvent('pointermove', { clientX: x, clientY: y, pointerType: 'mouse' }),
      );
    };

    const { rerender } = render(<MascotChaser isExiting={false} />);
    act(() => {
      dispatchMove(800, 400);
    });
    // Walk in toward cursor.
    act(() => {
      for (let i = 0; i < 200; i++) flushRaf(i * 17);
    });

    const wrapper = screen.getByTestId('ee-e5d2').firstChild as HTMLElement;
    const matchIn = wrapper.style.transform.match(/translate3d\(([-\d.]+)px,/);
    const xWalkedIn = matchIn ? Number.parseFloat(matchIn[1]) : Number.NaN;
    expect(xWalkedIn).toBeGreaterThan(0);

    // Begin exiting — Frink should now be moving leftward off-screen.
    rerender(<MascotChaser isExiting={true} />);
    act(() => {
      for (let i = 200; i < 500; i++) flushRaf(i * 17);
    });

    const wrapper2 = screen.getByTestId('ee-e5d2').firstChild as HTMLElement;
    const matchOut = wrapper2.style.transform.match(/translate3d\(([-\d.]+)px,/);
    const xExiting = matchOut ? Number.parseFloat(matchOut[1]) : Number.NaN;
    expect(xExiting).toBeLessThan(xWalkedIn);
  });

  it('calls onExitComplete after walking fully off-screen', () => {
    const onExitComplete = vi.fn();
    const { rerender } = render(<MascotChaser isExiting={false} onExitComplete={onExitComplete} />);

    rerender(<MascotChaser isExiting={true} onExitComplete={onExitComplete} />);
    // Plenty of frames so position passes off-screen left.
    act(() => {
      for (let i = 0; i < 800; i++) flushRaf(i * 17);
    });

    expect(onExitComplete).toHaveBeenCalled();
  });

  it('does not call onExitComplete while isExiting is false', () => {
    const onExitComplete = vi.fn();
    render(<MascotChaser isExiting={false} onExitComplete={onExitComplete} />);
    act(() => {
      for (let i = 0; i < 800; i++) flushRaf(i * 17);
    });
    expect(onExitComplete).not.toHaveBeenCalled();
  });
});
