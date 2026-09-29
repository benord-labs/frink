// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { atom, Provider, useAtomValue } from 'jotai';
import type { CSSProperties } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ResizableSidebar } from '../index';

const widthAtom = atom(200);

describe('ResizableSidebar', () => {
  it('keeps children mounted when preserveChildrenWhenClosed and closed', () => {
    render(
      <Provider>
        <ResizableSidebar
          isOpen={false}
          onClose={vi.fn()}
          widthAtom={widthAtom}
          side="left"
          preserveChildrenWhenClosed
        >
          <span data-testid="preserved-child">inside</span>
        </ResizableSidebar>
      </Provider>,
    );

    expect(screen.getByTestId('preserved-child')).toBeInTheDocument();
    const shell = screen.getByTestId('preserved-child-shell');
    expect(shell).toHaveAttribute('inert');
    expect(shell).toHaveAttribute('aria-hidden', 'true');
  });

  it('unmounts children when closed and preserveChildrenWhenClosed is false', () => {
    render(
      <Provider>
        <ResizableSidebar
          isOpen={false}
          onClose={vi.fn()}
          widthAtom={widthAtom}
          side="left"
          preserveChildrenWhenClosed={false}
        >
          <span data-testid="unmounted-child">inside</span>
        </ResizableSidebar>
      </Provider>,
    );

    expect(screen.queryByTestId('unmounted-child')).not.toBeInTheDocument();
  });

  it('allows onClose to be omitted (no-op from resize UI)', () => {
    render(
      <Provider>
        <ResizableSidebar isOpen widthAtom={widthAtom} side="left">
          <span data-testid="no-close-child">inside</span>
        </ResizableSidebar>
      </Provider>,
    );

    expect(screen.getByTestId('no-close-child')).toBeInTheDocument();
  });
});

// happy-dom evaluates no container queries, so an inline `position: absolute` stands in for the
// Compact size class that PANE_PANEL_CLASS applies in a narrow split pane.
const COMPACT: CSSProperties = { position: 'absolute' };

function PanePanels({
  files,
  terminal,
  onCloseFiles,
  onCloseTerminal,
  style,
}: {
  files: boolean;
  terminal: boolean;
  onCloseFiles: () => void;
  onCloseTerminal: () => void;
  style?: CSSProperties;
}) {
  return (
    <div data-pane-body>
      <textarea aria-label="composer" />
      <ResizableSidebar
        isOpen={files}
        onClose={onCloseFiles}
        widthAtom={atom(240)}
        side="left"
        style={style}
      >
        <span>files</span>
      </ResizableSidebar>
      <ResizableSidebar
        isOpen={terminal}
        onClose={onCloseTerminal}
        widthAtom={atom(400)}
        side="right"
        style={style}
      >
        <button type="button">terminal tabs</button>
      </ResizableSidebar>
    </div>
  );
}

describe('ResizableSidebar in a split pane', () => {
  it('marks only open panels, so SplitPane can hide the chat behind them', () => {
    const props = { onCloseFiles: vi.fn(), onCloseTerminal: vi.fn() };
    render(<PanePanels files terminal={false} {...props} />);

    const panel = screen.getByText('files').parentElement;
    expect(panel).toHaveAttribute('data-pane-panel');
    expect(document.querySelectorAll('[data-pane-panel]')).toHaveLength(1);
  });

  it('marks the pane body while a panel is open, and the newest panel owns the mark', () => {
    const props = { onCloseFiles: vi.fn(), onCloseTerminal: vi.fn() };
    const { container, rerender } = render(<PanePanels files terminal={false} {...props} />);
    const paneBody = container.querySelector('[data-pane-body]');
    expect(paneBody).toHaveAttribute('data-pane-panel-open', 'wide');

    // The terminal opens before the file tree's cleanup runs; that cleanup must not clear its mark.
    rerender(<PanePanels files terminal {...props} />);
    rerender(<PanePanels files={false} terminal {...props} />);
    expect(paneBody).toHaveAttribute('data-pane-panel-open', 'wide');

    rerender(<PanePanels files={false} terminal={false} {...props} />);
    expect(paneBody).not.toHaveAttribute('data-pane-panel-open');
  });

  it.each([
    [160, 'narrow', '@max-[22.5rem]/pane:absolute'],
    [350, 'wide', '@max-[34.5rem]/pane:absolute'],
  ])('a %ipx-minimum panel fills the pane below its own tier (%s)', (minWidth, tier, compact) => {
    render(
      <ResizableSidebar isOpen widthAtom={atom(240)} side="left" minWidth={minWidth}>
        <span data-testid="tier-child" />
      </ResizableSidebar>,
    );

    const panel = screen.getByTestId('tier-child').parentElement;
    expect(panel).toHaveAttribute('data-pane-panel', tier);
    expect(panel).toHaveClass(compact);
  });

  it.each([
    ['Regular', undefined],
    ['Compact', COMPACT],
  ])('shows one panel per pane: opening one closes the other (%s)', (_sizeClass, style) => {
    const props = { onCloseFiles: vi.fn(), onCloseTerminal: vi.fn(), style };
    const { rerender } = render(<PanePanels files terminal={false} {...props} />);

    rerender(<PanePanels files terminal {...props} />);

    expect(props.onCloseFiles).toHaveBeenCalledOnce();
    expect(props.onCloseTerminal).not.toHaveBeenCalled();
  });

  it('never closes a panel in another pane', () => {
    const paneA = { onCloseFiles: vi.fn(), onCloseTerminal: vi.fn(), style: COMPACT };
    const paneB = { onCloseFiles: vi.fn(), onCloseTerminal: vi.fn(), style: COMPACT };
    render(
      <>
        <PanePanels files terminal={false} {...paneA} />
        <PanePanels files={false} terminal {...paneB} />
      </>,
    );

    expect(paneA.onCloseFiles).not.toHaveBeenCalled();
  });
});

describe('ResizableSidebar focus in a Compact pane', () => {
  // happy-dom has no checkVisibility or container queries: emulate Compact, where the resize
  // chrome is display:none and everything else in the panel shows.
  const original = Element.prototype.checkVisibility;
  beforeEach(() => {
    Element.prototype.checkVisibility = function (this: Element) {
      return !this.hasAttribute('data-resize-chrome');
    };
  });
  afterEach(() => {
    Element.prototype.checkVisibility = original;
  });

  it('moves focus into the panel that replaces the chat, and back when it closes', async () => {
    const props = { onCloseFiles: vi.fn(), onCloseTerminal: vi.fn(), style: COMPACT };
    const { rerender } = render(<PanePanels files={false} terminal={false} {...props} />);
    screen.getByRole('textbox', { name: 'composer' }).focus();

    rerender(<PanePanels files={false} terminal {...props} />);
    expect(screen.getByRole('button', { name: 'terminal tabs' })).toHaveFocus();

    rerender(<PanePanels files={false} terminal={false} {...props} />);
    await act(() => new Promise(requestAnimationFrame));
    expect(screen.getByRole('textbox', { name: 'composer' })).toHaveFocus();
  });

  it('restores focus on close even when the pane turned Compact after the panel opened', async () => {
    const props = { onCloseFiles: vi.fn(), onCloseTerminal: vi.fn() };
    const { rerender } = render(<PanePanels files={false} terminal={false} {...props} />);
    const composer = screen.getByRole('textbox', { name: 'composer' });
    composer.focus();
    rerender(<PanePanels files={false} terminal {...props} />);

    // A resize makes the pane Compact: the chat hides and the browser drops focus to <body>.
    rerender(<PanePanels files={false} terminal {...props} style={COMPACT} />);
    composer.blur();
    rerender(<PanePanels files={false} terminal={false} {...props} style={COMPACT} />);
    await act(() => new Promise(requestAnimationFrame));

    expect(composer).toHaveFocus();
  });

  it('follows focus into the panel when a resize hides the focused chat', async () => {
    const props = { onCloseFiles: vi.fn(), onCloseTerminal: vi.fn() };
    const { rerender } = render(<PanePanels files={false} terminal {...props} />);
    const composer = screen.getByRole('textbox', { name: 'composer' });
    composer.focus();

    rerender(<PanePanels files={false} terminal {...props} style={COMPACT} />);
    composer.setAttribute('data-resize-chrome', ''); // stands in for the now-hidden chat
    composer.blur();
    // The browser's blur of a hidden element: a bubbling focusout with nowhere to go.
    composer.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null }));
    await act(() => new Promise(requestAnimationFrame));

    expect(screen.getByRole('button', { name: 'terminal tabs' })).toHaveFocus();
  });

  it('leaves focus in the chat when the panel docks beside it', () => {
    const props = { onCloseFiles: vi.fn(), onCloseTerminal: vi.fn() };
    const { rerender } = render(<PanePanels files={false} terminal={false} {...props} />);
    screen.getByRole('textbox', { name: 'composer' }).focus();

    rerender(<PanePanels files={false} terminal {...props} />);

    expect(screen.getByRole('textbox', { name: 'composer' })).toHaveFocus();
  });
});

function StoredWidth({ widthAtom }: { widthAtom: ReturnType<typeof atom<number>> }) {
  return <output>{useAtomValue(widthAtom)}</output>;
}

/** Drags the left sidebar's edge `dx` px while it renders `renderedWidth` px wide. */
function dragSidebarEdge(storedWidth: number, renderedWidth: number, dx: number): string | null {
  const widthAtom = atom(storedWidth);
  render(
    <Provider>
      <ResizableSidebar isOpen widthAtom={widthAtom} side="left" minWidth={160} maxWidth={600}>
        <span data-testid="edge-child" />
      </ResizableSidebar>
      <StoredWidth widthAtom={widthAtom} />
    </Provider>,
  );
  const panel = screen.getByTestId('edge-child').parentElement;
  if (!(panel instanceof HTMLElement)) throw new Error('sidebar panel not rendered');
  Object.defineProperty(panel, 'offsetWidth', { value: renderedWidth });

  fireEvent.pointerDown(screen.getByRole('button', { name: /resize sidebar/i }), {
    button: 0,
    clientX: 300,
  });
  fireEvent.pointerMove(document, { clientX: 300 + dx });
  fireEvent.pointerUp(document, { clientX: 300 + dx });
  return screen.getByRole('status').textContent;
}

describe('ResizableSidebar drag', () => {
  it('resizes from the stored width when nothing clamps the sidebar', () => {
    expect(dragSidebarEdge(280, 280, 40)).toBe('320');
  });

  it('starts from the on-screen width when a pane clamps the sidebar', () => {
    expect(dragSidebarEdge(280, 200, -20)).toBe('180');
  });

  it('never saves a width wider than the clamped one on screen', () => {
    expect(dragSidebarEdge(280, 200, 60)).toBe('200');
  });
});
