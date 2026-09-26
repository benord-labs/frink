// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Provider } from 'jotai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PANE_CHAT_BEHIND_PANEL_CLASS } from '@/components/ui/resizable-sidebar/constants';
import { TooltipProvider } from '@/components/ui/tooltip';
import { SplitPane } from './SplitPane';
import type { SplitPaneData } from './types';

// The file-tree subtree reaches trpc at module load; stub it out so these tests stay scoped to
// pane activation. dnd-kit is deliberately NOT mocked: PaneDropSection's useDroppable works
// without a DndContext ancestor, and mocking it would stub the very element under test.
vi.mock('@/components/ui/resizable-sidebar', () => ({
  ResizableSidebar: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('../../../files-sidebar/PaneFileTree', () => ({
  PaneFileTree: () => <div data-testid="pane-file-tree-mock" />,
}));

const mockPane: SplitPaneData = {
  id: 'pane-1',
  label: 'Pane 1',
  projectPath: '/tmp/proj',
  content: <div>Chat content</div>,
};

const PANE_SECTION = /Split pane 1/;
const FOCUS_PANE_1 = /focus pane 1/i;

/** `onSwapPanes` is omitted throughout: passing it renders PaneReorderHandleButton, which needs a
 *  real DndContext for useDraggable. Reordering is not what these tests cover. */
function renderPane(
  variant: 'linear' | 'grid',
  isActive: boolean,
  onSetActive: () => void,
  zoomFactor = 1,
  showFileTree = false,
) {
  const shared = {
    pane: mockPane,
    index: 0,
    isActive,
    onSetActive,
    onClose: () => {},
    onFileTreeRef: () => {},
    totalPanes: 2,
    zoomFactor,
  };

  return render(
    <Provider>
      <TooltipProvider delayDuration={0}>
        {variant === 'linear' ? (
          <SplitPane
            variant="linear"
            {...shared}
            isVertical={false}
            sizeStyle={{ width: '50%' }}
            showFileTree={showFileTree}
          >
            <div>Child</div>
          </SplitPane>
        ) : (
          <SplitPane variant="grid" {...shared} layout="grid" fileTreeOpen={false}>
            <div>Child</div>
          </SplitPane>
        )}
      </TooltipProvider>
    </Provider>,
  );
}

afterEach(cleanup);

describe('SplitPane pane activation', () => {
  describe.each(['linear', 'grid'] as const)('%s variant', (variant) => {
    it('activates the pane when its section is clicked while inactive', async () => {
      const onSetActive = vi.fn();
      renderPane(variant, false, onSetActive);

      await userEvent.click(screen.getByRole('region', { name: PANE_SECTION }));

      expect(onSetActive).toHaveBeenCalledOnce();
    });

    it('does not re-activate when the section of an already-active pane is clicked', async () => {
      const onSetActive = vi.fn();
      renderPane(variant, true, onSetActive);

      await userEvent.click(screen.getByRole('region', { name: PANE_SECTION }));

      expect(onSetActive).not.toHaveBeenCalled();
    });
  });

  // The header's activate button fires onActivate; the click must NOT also bubble to the section
  // handler and activate a second time. handlePaneClick ignores clicks from interactive descendants.
  it('activates once when the header activate button is clicked on an inactive pane', async () => {
    const onSetActive = vi.fn();
    renderPane('linear', false, onSetActive);

    await userEvent.click(screen.getByRole('button', { name: FOCUS_PANE_1 }));

    expect(onSetActive).toHaveBeenCalledOnce();
  });

  it('compensates the shared sidebar seam for containment, border, inset, and pane zoom', () => {
    renderPane('linear', true, vi.fn(), 2);

    expect(screen.getByRole('region', { name: PANE_SECTION })).toHaveClass(
      '[--open-sidebar-button-position:absolute]',
    );
    expect(screen.getByText('Child').parentElement).toHaveStyle({
      '--pane-zoom-factor': '2',
      zoom: '2',
    });
  });

  it('places the sidebar trigger immediately after an open pane file tree', () => {
    renderPane('linear', true, vi.fn(), 1, true);

    expect(screen.getByRole('region', { name: PANE_SECTION })).toHaveClass(
      '[--open-sidebar-button-position:absolute]',
      '[--open-sidebar-button-left:1px]',
    );
    expect(screen.getByTestId('pane-file-tree-mock')).toBeInTheDocument();
  });

  it('sizes its side panels on its own width and hides the chat behind a Compact panel', () => {
    renderPane('linear', true, vi.fn(), 1, true);

    const pane = screen.getByRole('region', { name: PANE_SECTION });
    expect(pane).toHaveClass('@container/pane');
    expect(pane.querySelector('[data-pane-body]')).toHaveClass('group/pane-body', 'relative');
    expect(screen.getByText('Child').parentElement?.parentElement).toHaveClass(
      PANE_CHAT_BEHIND_PANEL_CLASS,
    );
  });
});
