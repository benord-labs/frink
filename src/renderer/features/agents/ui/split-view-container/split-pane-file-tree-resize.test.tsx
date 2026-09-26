// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Provider, useAtomValue, useSetAtom } from 'jotai';
import { useEffect, useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { filesSidebarWidthAtom, splitPaneFileTreeWidthAtom } from '../../../files-sidebar/atoms';
import {
  SPLIT_FILE_TREE_MAX_WIDTH,
  SPLIT_FILE_TREE_MIN_WIDTH,
} from '../../../files-sidebar/constants';
import { SplitPane } from './SplitPane';
import type { SplitPaneData } from './types';

// Module-level capture for ResizableSidebar mock (vi.mock is hoisted)
type CapturedResizableProps = {
  widthAtom: unknown;
  minWidth: number;
  maxWidth: number;
  disableClickToClose: boolean;
  className?: string;
};
const capturedResizableProps: { current: CapturedResizableProps | null } = { current: null };

vi.mock('@/components/ui/resizable-sidebar', () => ({
  ResizableSidebar: (props: Record<string, unknown>) => {
    capturedResizableProps.current = props as unknown as CapturedResizableProps;
    return <div data-testid="resizable-sidebar-mock">{props.children as React.ReactNode}</div>;
  },
}));

vi.mock('../../../files-sidebar/PaneFileTree', () => ({
  PaneFileTree: () => <div data-testid="pane-file-tree-mock">PaneFileTree</div>,
}));

// Minimal pane data for rendering
const mockPane: SplitPaneData = {
  id: 'pane-1',
  label: 'Pane 1',
  projectPath: '/tmp/proj',
  content: <div>Chat content</div>,
};

afterEach(() => {
  cleanup();
});

describe('split-pane file tree resize', () => {
  describe('atom independence (400px single-pane does not affect split width)', () => {
    it('filesSidebarWidthAtom and splitPaneFileTreeWidthAtom are independent', () => {
      expect(splitPaneFileTreeWidthAtom).toBeDefined();
      expect(filesSidebarWidthAtom).toBeDefined();
      expect(splitPaneFileTreeWidthAtom).not.toBe(filesSidebarWidthAtom);
    });

    it('setting filesSidebarWidthAtom does not change splitPaneFileTreeWidthAtom', () => {
      const splitValues: number[] = [];
      function Harness() {
        const setFiles = useSetAtom(filesSidebarWidthAtom);
        const splitWidth = useAtomValue(splitPaneFileTreeWidthAtom);
        const setSplit = useSetAtom(splitPaneFileTreeWidthAtom);
        const mounted = useRef(false);

        useEffect(() => {
          setFiles(400);
        }, [setFiles]);

        useEffect(() => {
          if (!mounted.current) {
            splitValues.push(splitWidth);
            setSplit(260);
            mounted.current = true;
          }
        }, [splitWidth, setSplit]);

        return <span data-testid="split-value">{splitWidth}</span>;
      }

      render(
        <Provider>
          <Harness />
        </Provider>,
      );

      const el = screen.getByTestId('split-value');
      expect(el).toBeInTheDocument();
      // Split width is its own atom: after setSplit(260) it shows 260, not 400
      expect(Number(el.textContent)).toBe(260);
      // Setting files to 400 did not overwrite split width (would be 400 if shared)
      expect(splitValues[0]).not.toBe(400);
    });
  });

  describe('grid SplitPane uses split width atom and disableClickToClose', () => {
    it('passes splitPaneFileTreeWidthAtom, split min/max, and disableClickToClose to ResizableSidebar', () => {
      capturedResizableProps.current = null;

      render(
        <Provider>
          <TooltipProvider delayDuration={0}>
            <SplitPane
              variant="grid"
              pane={mockPane}
              index={0}
              isActive={true}
              onSetActive={() => {}}
              onClose={() => {}}
              fileTreeOpen={true}
              onFileTreeRef={() => {}}
              totalPanes={1}
              layout="grid"
            >
              <div>Child</div>
            </SplitPane>
          </TooltipProvider>
        </Provider>,
      );

      expect(screen.getByTestId('resizable-sidebar-mock')).toBeInTheDocument();
      const p = capturedResizableProps.current as CapturedResizableProps | null;
      expect(p).not.toBeNull();
      if (!p) return;
      expect(p.widthAtom).toBe(splitPaneFileTreeWidthAtom);
      expect(p.minWidth).toBe(SPLIT_FILE_TREE_MIN_WIDTH);
      expect(p.maxWidth).toBe(SPLIT_FILE_TREE_MAX_WIDTH);
      expect(p.disableClickToClose).toBe(true);
    });

    it('applies worktree visual styling to split file tree sidebar when pane is worktree-backed', () => {
      capturedResizableProps.current = null;
      const worktreePane: SplitPaneData = {
        ...mockPane,
        isWorktree: true,
      };

      render(
        <Provider>
          <TooltipProvider delayDuration={0}>
            <SplitPane
              variant="grid"
              pane={worktreePane}
              index={0}
              isActive={true}
              onSetActive={() => {}}
              onClose={() => {}}
              fileTreeOpen={true}
              onFileTreeRef={() => {}}
              totalPanes={1}
              layout="grid"
            >
              <div>Child</div>
            </SplitPane>
          </TooltipProvider>
        </Provider>,
      );

      const p = capturedResizableProps.current as CapturedResizableProps | null;
      expect(p).not.toBeNull();
      if (!p) return;
      expect(p.className).toContain('color-mix');
    });
  });

  describe('linear SplitPane uses split width atom and disableClickToClose', () => {
    it('passes splitPaneFileTreeWidthAtom, split min/max, and disableClickToClose to ResizableSidebar', () => {
      capturedResizableProps.current = null;

      render(
        <Provider>
          <TooltipProvider delayDuration={0}>
            <SplitPane
              variant="linear"
              pane={mockPane}
              index={0}
              isActive={true}
              isVertical={false}
              sizeStyle={{ width: '50%' }}
              onSetActive={() => {}}
              onClose={() => {}}
              showFileTree={true}
              onFileTreeRef={() => {}}
              totalPanes={1}
            >
              <div>Child</div>
            </SplitPane>
          </TooltipProvider>
        </Provider>,
      );

      expect(screen.getByTestId('resizable-sidebar-mock')).toBeInTheDocument();
      const p = capturedResizableProps.current as CapturedResizableProps | null;
      expect(p).not.toBeNull();
      if (!p) return;
      expect(p.widthAtom).toBe(splitPaneFileTreeWidthAtom);
      expect(p.minWidth).toBe(SPLIT_FILE_TREE_MIN_WIDTH);
      expect(p.maxWidth).toBe(SPLIT_FILE_TREE_MAX_WIDTH);
      expect(p.disableClickToClose).toBe(true);
    });
  });
});
