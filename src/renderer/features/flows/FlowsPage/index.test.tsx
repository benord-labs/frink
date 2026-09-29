// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Provider } from 'jotai';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '../../../components/ui/tooltip';
import { flowsSelectedFlowIdAtom } from '../../../lib/atoms';
import { appStore } from '../../../lib/jotai-store';

const platform = vi.hoisted(() => ({ isMac: false }));

vi.mock('../../../lib/utils/platform', () => ({
  isMacOS: () => platform.isMac,
  isDesktopApp: () => true,
}));

vi.mock('../../../lib/trpc', () => ({
  trpc: { flows: { list: { useQuery: () => ({ data: [] }) } } },
}));

vi.mock('../FlowsList', () => ({ FlowsList: () => <div data-testid="flows-list" /> }));
vi.mock('../FlowEditor', () => ({ FlowEditor: () => <div data-testid="flow-editor" /> }));
vi.mock('../CreateFlowDialog', () => ({ CreateFlowDialog: () => null }));

const { FlowsPage } = await import('./index');

afterEach(() => {
  cleanup();
  platform.isMac = false;
  appStore.set(flowsSelectedFlowIdAtom, null);
});

function renderPage(
  options: { selectedFlowId?: string | null; trigger?: ReactElement; onClose?: () => void } = {},
) {
  // FlowsPage's Escape guard reads appStore directly, so the test must drive the same store.
  appStore.set(flowsSelectedFlowIdAtom, options.selectedFlowId ?? null);
  const onClose = options.onClose ?? vi.fn();
  const { container } = render(
    <TooltipProvider>
      <Provider store={appStore}>
        <FlowsPage onClose={onClose} sidebarTrigger={options.trigger} />
      </Provider>
    </TooltipProvider>,
  );
  return { onClose, container };
}

const pressEscape = (target: EventTarget = document) =>
  act(() => {
    fireEvent.keyDown(target as Element | Document, { key: 'Escape' });
  });

const header = () => screen.getByRole('banner');
const TRIGGER = <button type="button">Open sidebar</button>;

describe('FlowsPage header chrome', () => {
  /**
   * The dashboard shares Work Queue's page chrome, so the traffic-light clearance follows the same
   * rule: the trigger's presence, not the platform alone, decides which padding applies.
   */
  it('reserves the compact clearance on macOS while it owns the corner', () => {
    platform.isMac = true;
    renderPage({ trigger: TRIGGER });

    expect(header()).toHaveClass('pt-3');
  });

  it('falls back to the narrow-window clearance once the sidebar covers the corner', () => {
    platform.isMac = true;
    renderPage();

    expect(header()).not.toHaveClass('pt-3');
    expect(header()).toHaveClass('max-[599px]:pt-7');
  });

  it('never reserves traffic-light clearance off macOS', () => {
    platform.isMac = false;
    renderPage({ trigger: TRIGGER });

    expect(header()).not.toHaveClass('pt-3');
    expect(header()).not.toHaveClass('max-[599px]:pt-7');
  });

  /**
   * The dashboard is a centred column with an empty top-left corner, so the trigger is positioned
   * out of flow and must not leave a reserved gap before the title.
   */
  it('positions the trigger out of flow, ahead of the title', () => {
    renderPage({ trigger: TRIGGER });

    expect(header()).toHaveClass('[--open-sidebar-button-position:fixed]');
    const row = screen.getByRole('button', { name: 'Open sidebar' }).parentElement;
    expect(row).toContainElement(screen.getByRole('heading', { name: 'Flows' }));
    expect(row?.firstElementChild).toHaveAccessibleName('Open sidebar');
  });

  // Electron's -webkit-app-region: drag can't be modeled in happy-dom, so a missing opt-out
  // here silently ships header controls that only drag the window instead of activating.
  it('opts its controls out of the header drag region', () => {
    renderPage();

    expect(header()).toHaveClass('drag-region');
    expect(screen.getByRole('button', { name: 'Close flows' }).parentElement).toHaveClass(
      'no-drag',
    );
  });
});

/**
 * `unified-sidebar-glass` is panel chrome. The dashboard sits directly on the shared page surface;
 * only the editor, which takes over the full width, still supplies its own frame.
 */
describe('FlowsPage surface', () => {
  it('renders the dashboard on the shared page column with no glass panel', () => {
    const { container } = renderPage();

    expect(container.querySelector('.unified-sidebar-glass')).toBeNull();
    expect(container.querySelector('.chat-canvas-atmosphere')).toBeNull();
    expect(screen.getByRole('main')).toHaveClass('max-w-[56rem]');
  });

  it('keeps the editor inside its own glass frame', () => {
    const { container } = renderPage({ selectedFlowId: 'flow-1' });

    expect(container.querySelector('.unified-sidebar-glass')).not.toBeNull();
  });
});

describe('FlowsPage sub-view selection', () => {
  it('shows the dashboard when no flow is selected', () => {
    renderPage();

    expect(screen.getByTestId('flows-list')).toBeInTheDocument();
    expect(screen.queryByTestId('flow-editor')).toBeNull();
  });

  it('shows the editor and drops the header once a flow is selected', () => {
    renderPage({ selectedFlowId: 'flow-1', trigger: TRIGGER });

    expect(screen.getByTestId('flow-editor')).toBeInTheDocument();
    expect(screen.queryByRole('banner')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Open sidebar' })).toBeNull();
  });

  /**
   * An empty id is not a flow. The layout policy derives the same answer by truthiness, so both
   * agree the dashboard is showing and the sidebar stays.
   */
  it('treats an empty flow id as no selection', () => {
    renderPage({ selectedFlowId: '' });

    expect(screen.getByTestId('flows-list')).toBeInTheDocument();
    expect(screen.queryByTestId('flow-editor')).toBeNull();
  });
});

/**
 * Two Escape owners now share the Flows destination: the sidebar's own handler and this page's
 * close. The page must only claim Escape when it is the dashboard and nothing else owns the key.
 */
describe('FlowsPage Escape ownership', () => {
  it('closes Flows from the dashboard', () => {
    const { onClose } = renderPage();

    pressEscape();

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(appStore.get(flowsSelectedFlowIdAtom)).toBeNull();
  });

  it('leaves Escape to the editor while a flow is open', () => {
    const { onClose } = renderPage({ selectedFlowId: 'flow-1' });

    pressEscape();

    expect(onClose).not.toHaveBeenCalled();
    expect(appStore.get(flowsSelectedFlowIdAtom)).toBe('flow-1');
  });

  /** Typing Escape to dismiss an autocomplete in the flow-search box must not close the page. */
  it('ignores Escape raised from an editable target', () => {
    const { onClose } = renderPage();
    const search = document.createElement('input');
    document.body.append(search);

    pressEscape(search);

    expect(onClose).not.toHaveBeenCalled();
    search.remove();
  });

  it('ignores an Escape another handler already claimed', () => {
    const { onClose } = renderPage();

    act(() => {
      const event = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
      event.preventDefault();
      window.dispatchEvent(event);
    });

    expect(onClose).not.toHaveBeenCalled();
  });

  it('stops listening once unmounted', () => {
    const { onClose } = renderPage();
    cleanup();

    pressEscape();

    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('FlowsPage close affordance', () => {
  it('clears the selection and closes when the header close button is used', () => {
    const { onClose } = renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Close flows' }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(appStore.get(flowsSelectedFlowIdAtom)).toBeNull();
  });
});
