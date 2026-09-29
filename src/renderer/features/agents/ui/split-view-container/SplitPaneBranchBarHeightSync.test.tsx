// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SplitPaneBranchBarHeightProvider,
  useSplitPaneBranchBarSync,
} from './SplitPaneBranchBarHeightSync';

function MeasuringPane({
  paneIndex,
  enabled,
  innerPx,
}: {
  paneIndex: number;
  enabled: boolean;
  innerPx: number;
}) {
  const { measureRef, outerStyle } = useSplitPaneBranchBarSync(paneIndex, enabled);
  return (
    <div data-testid={`sync-outer-${paneIndex}`} style={outerStyle}>
      <div ref={measureRef} style={{ height: innerPx, width: 1 }}>
        x
      </div>
    </div>
  );
}

describe('SplitPaneBranchBarHeightProvider + useSplitPaneBranchBarSync', () => {
  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });

    class ResizeObserverMock {
      private callback: ResizeObserverCallback;

      constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
      }

      observe() {
        this.callback([], this as unknown as ResizeObserver);
      }

      disconnect() {}

      unobserve() {}
    }

    vi.stubGlobal('ResizeObserver', ResizeObserverMock);

    // happy-dom layout may not populate getBoundingClientRect; hook uses it for natural height.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      const raw = this.style.height;
      const h = raw ? Number.parseFloat(raw) : 0;
      return {
        height: h,
        width: 100,
        top: 0,
        left: 0,
        bottom: h,
        right: 100,
        x: 0,
        y: 0,
        toJSON: () => {},
      } as DOMRect;
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('applies shared minHeight equal to the largest measured inner pane (EC2)', () => {
    render(
      <SplitPaneBranchBarHeightProvider layout="horizontal" paneCount={2}>
        <MeasuringPane paneIndex={0} enabled innerPx={40} />
        <MeasuringPane paneIndex={1} enabled innerPx={48} />
      </SplitPaneBranchBarHeightProvider>,
    );

    const outer0 = screen.getByTestId('sync-outer-0');
    const outer1 = screen.getByTestId('sync-outer-1');

    expect(outer0.style.minHeight).toBe('48px');
    expect(outer1.style.minHeight).toBe('48px');
  });

  it('does not use a disabled pane height in the max (inactive sub-chat / EC1)', () => {
    render(
      <SplitPaneBranchBarHeightProvider layout="horizontal" paneCount={2}>
        <MeasuringPane paneIndex={0} enabled innerPx={40} />
        <MeasuringPane paneIndex={1} enabled={false} innerPx={200} />
      </SplitPaneBranchBarHeightProvider>,
    );

    expect(screen.getByTestId('sync-outer-0').style.minHeight).toBe('40px');
    expect(screen.getByTestId('sync-outer-1').style.minHeight).toBe('');
  });

  it('recomputes max when the tallest pane unmounts', () => {
    const { rerender } = render(
      <SplitPaneBranchBarHeightProvider layout="horizontal" paneCount={2}>
        <MeasuringPane paneIndex={0} enabled innerPx={40} />
        <MeasuringPane paneIndex={1} enabled innerPx={48} />
      </SplitPaneBranchBarHeightProvider>,
    );

    expect(screen.getByTestId('sync-outer-0').style.minHeight).toBe('48px');

    rerender(
      <SplitPaneBranchBarHeightProvider layout="horizontal" paneCount={2}>
        <MeasuringPane paneIndex={0} enabled innerPx={40} />
      </SplitPaneBranchBarHeightProvider>,
    );

    expect(screen.getByTestId('sync-outer-0').style.minHeight).toBe('40px');
  });

  it('aligns reporting panes with non-adjacent indices to the same max (EC9 sparse map)', () => {
    render(
      <SplitPaneBranchBarHeightProvider layout="horizontal" paneCount={3}>
        <MeasuringPane paneIndex={0} enabled innerPx={30} />
        <MeasuringPane paneIndex={2} enabled innerPx={50} />
      </SplitPaneBranchBarHeightProvider>,
    );

    expect(screen.getByTestId('sync-outer-0').style.minHeight).toBe('50px');
    expect(screen.getByTestId('sync-outer-2').style.minHeight).toBe('50px');
  });

  it('2×2 grid: top row syncs separately from bottom row', () => {
    render(
      <SplitPaneBranchBarHeightProvider layout="grid" paneCount={4}>
        <MeasuringPane paneIndex={0} enabled innerPx={40} />
        <MeasuringPane paneIndex={1} enabled innerPx={48} />
        <MeasuringPane paneIndex={2} enabled innerPx={20} />
      </SplitPaneBranchBarHeightProvider>,
    );

    expect(screen.getByTestId('sync-outer-0').style.minHeight).toBe('48px');
    expect(screen.getByTestId('sync-outer-1').style.minHeight).toBe('48px');
    expect(screen.getByTestId('sync-outer-2').style.minHeight).toBe('20px');
  });

  it('2×2 grid with sparse panes: corners only do not bleed max across rows (EC9 grid)', () => {
    render(
      <SplitPaneBranchBarHeightProvider layout="grid" paneCount={4}>
        <MeasuringPane paneIndex={0} enabled innerPx={32} />
        <MeasuringPane paneIndex={3} enabled innerPx={64} />
      </SplitPaneBranchBarHeightProvider>,
    );

    expect(screen.getByTestId('sync-outer-0').style.minHeight).toBe('32px');
    expect(screen.getByTestId('sync-outer-3').style.minHeight).toBe('64px');
  });
});
