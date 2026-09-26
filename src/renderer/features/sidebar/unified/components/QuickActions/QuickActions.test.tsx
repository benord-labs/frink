// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createStore, Provider } from 'jotai';
import { describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '../../../../../components/ui/tooltip';
import {
  getDefaultGridRatios,
  getDefaultRatios,
  getLayoutCycleDescription,
  getNextLayout,
  type SplitLayout,
  splitViewAtom,
} from '../../../../agents/atoms';
import { SplitViewControls } from './index';

type StoreOpts = { layout?: SplitLayout; ratios?: number[]; paneZoomFactors?: number[] };

function renderWithStore(panes: string[], ui: React.ReactElement, opts: StoreOpts = {}) {
  const { layout = 'grid', ratios, paneZoomFactors } = opts;
  const store = createStore();
  store.set(splitViewAtom, {
    chatIds: panes,
    ratios: ratios ?? getDefaultRatios(panes.length),
    activePaneIndex: 0,
    layout,
    gridRatios: getDefaultGridRatios(),
    paneZoomFactors,
  });
  return render(
    <Provider store={store}>
      <TooltipProvider delayDuration={0}>{ui}</TooltipProvider>
    </Provider>,
  );
}

describe('SplitViewControls', () => {
  it('renders the layout cycle control with aria-label from getLayoutCycleDescription(next, paneCount)', async () => {
    const user = userEvent.setup();
    const onCycleLayout = vi.fn();
    const paneCount = 4;
    const expectedLabel = getLayoutCycleDescription(getNextLayout('grid', paneCount), paneCount);

    renderWithStore(['a', 'b', 'c', 'd'], <SplitViewControls onCycleLayout={onCycleLayout} />);

    const layoutBtn = screen.getByRole('button', { name: expectedLabel });
    expect(layoutBtn).toBeInTheDocument();
    await user.click(layoutBtn);
    expect(onCycleLayout).toHaveBeenCalledTimes(1);
  });

  it('shows the layout toggle at the two-pane boundary', () => {
    const expectedLabel = getLayoutCycleDescription(getNextLayout('horizontal', 2), 2);
    renderWithStore(['a', 'b'], <SplitViewControls onCycleLayout={vi.fn()} />, {
      layout: 'horizontal',
    });
    expect(screen.getByRole('button', { name: expectedLabel })).toBeInTheDocument();
  });

  it('renders nothing for a single pane (no split to tune)', () => {
    const { container } = renderWithStore(
      ['a'],
      <SplitViewControls onCycleLayout={vi.fn()} onResetPaneSizes={vi.fn()} />,
      { layout: 'horizontal' },
    );
    expect(container.firstChild).toBeNull();
  });

  it('hides reset-sizes while panes are at their default (equal) sizes', () => {
    renderWithStore(
      ['a', 'b', 'c', 'd'],
      <SplitViewControls onCycleLayout={vi.fn()} onResetPaneSizes={vi.fn()} />,
    );
    expect(screen.queryByRole('button', { name: 'Reset pane sizes to equal' })).toBeNull();
  });

  it('shows + fires reset-sizes only when panes are unequal', async () => {
    const user = userEvent.setup();
    const onResetPaneSizes = vi.fn();
    renderWithStore(['a', 'b'], <SplitViewControls onResetPaneSizes={onResetPaneSizes} />, {
      layout: 'horizontal',
      ratios: [0.8, 0.2],
    });
    const btn = screen.getByRole('button', { name: 'Reset pane sizes to equal' });
    expect(btn).toBeInTheDocument();
    await user.click(btn);
    expect(onResetPaneSizes).toHaveBeenCalledTimes(1);
  });

  it('shows + fires reset-zoom only when a pane is zoomed', async () => {
    const user = userEvent.setup();
    const onResetPaneZoom = vi.fn();
    renderWithStore(['a', 'b'], <SplitViewControls onResetPaneZoom={onResetPaneZoom} />, {
      layout: 'horizontal',
      paneZoomFactors: [1.5, 1],
    });
    const btn = screen.getByRole('button', { name: 'Reset all pane zoom to 100%' });
    expect(btn).toBeInTheDocument();
    await user.click(btn);
    expect(onResetPaneZoom).toHaveBeenCalledTimes(1);
  });

  it('hides reset-zoom while panes are at default (100%) zoom', () => {
    renderWithStore(['a', 'b'], <SplitViewControls onResetPaneZoom={vi.fn()} />, {
      layout: 'horizontal',
    });
    expect(screen.queryByRole('button', { name: 'Reset all pane zoom to 100%' })).toBeNull();
  });
});
