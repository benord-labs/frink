// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { type StickToBottomInstance, useStickToBottom } from 'use-stick-to-bottom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageGroup } from './MessageGroup';
import { MessagesScrollContainer } from './MessagesScrollContainer';

// Stub the fallback (its own trpc/atom wiring is tested in FlowTriggerCardFallback.test) — here we
// only assert the container renders it at the top of the message column, above its children.
vi.mock('./FlowTriggerCardFallback', () => ({
  FlowTriggerCardFallback: () => <div data-testid="trigger-fallback" />,
}));

/**
 * happy-dom performs no layout: scrollHeight/clientHeight are 0 and its ResizeObserver is a
 * documented no-op, so an unaided render of this component exercises nothing. These two shims
 * supply the missing pieces — geometry that CLAMPS (the clamp is the failure this component
 * guards against) and observers whose callbacks the test drives by hand.
 */
const layout = { scrollHeight: 0, clientHeight: 0 };

/** Element under observation → its recorded callback, so a test can flush a resize on demand. */
let observed: Array<{
  element: Element;
  callback: ResizeObserverCallback;
  observer: ResizeObserver;
}> = [];

function flushResize(element: Element, height: number): void {
  for (const entry of observed) {
    if (entry.element !== element) continue;
    entry.callback(
      [{ target: element, contentRect: { height } } as unknown as ResizeObserverEntry],
      {} as ResizeObserver,
    );
  }
}

/** A delivery for the message column, whose bottom padding is ChatDock's reserve. */
function flushColumn(column: Element, contentHeight: number, reserve: number): void {
  const box = (blockSize: number) => [{ blockSize, inlineSize: 0 }];
  const entry: ResizeObserverEntry = {
    target: column,
    contentRect: new DOMRect(0, 0, 0, contentHeight),
    borderBoxSize: box(contentHeight + reserve),
    contentBoxSize: box(contentHeight),
    devicePixelContentBoxSize: box(contentHeight),
  };
  for (const { element, callback, observer } of observed) {
    if (element === column) callback([entry], observer);
  }
}

function getColumn(): HTMLElement {
  const column = screen.getByTestId('trigger-fallback').parentElement;
  if (!column) throw new Error('MessagesScrollContainer rendered no message column');
  return column;
}

function installLayoutShims(): void {
  Object.defineProperties(HTMLElement.prototype, {
    scrollHeight: { get: () => layout.scrollHeight, configurable: true },
    clientHeight: { get: () => layout.clientHeight, configurable: true },
    scrollTop: {
      get(this: HTMLElement & { _scrollTop?: number }) {
        return this._scrollTop ?? 0;
      },
      set(this: HTMLElement & { _scrollTop?: number }, value: number) {
        const max = Math.max(0, layout.scrollHeight - layout.clientHeight);
        this._scrollTop = Math.max(0, Math.min(value, max));
      },
      configurable: true,
    },
  });

  globalThis.ResizeObserver = class {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe(element: Element) {
      observed.push({ element, callback: this.callback, observer: this });
    }
    unobserve(element: Element) {
      observed = observed.filter((e) => e.element !== element);
    }
    disconnect() {
      observed = observed.filter((e) => e.callback !== this.callback);
    }
  } as unknown as typeof ResizeObserver;
}

/** Stands in for the read-only consumers (search jump, pagination, Cmd+Down). */
const consumerRef: { current: HTMLElement | null } = { current: null };

/** Exposes the real hook instance so tests assert against it rather than a hand-made stub. */
function Harness({
  isActive = true,
  subChatId = 'sub-1',
  onInstance,
  children,
}: {
  isActive?: boolean;
  subChatId?: string;
  onInstance: (instance: StickToBottomInstance) => void;
  children?: ReactNode;
}) {
  const instance = useStickToBottom({ initial: 'instant', resize: 'instant' });
  onInstance(instance);
  return (
    <MessagesScrollContainer
      instance={instance}
      isActive={isActive}
      containerRef={consumerRef}
      subChatId={subChatId}
      pinnedTaskId={null}
    >
      {children ?? <div data-testid="child" />}
    </MessagesScrollContainer>
  );
}

function renderContainer(props: { isActive?: boolean; subChatId?: string } = {}) {
  let instance!: StickToBottomInstance;
  const result = render(<Harness {...props} onInstance={(i) => (instance = i)} />);
  const scrollEl = document.querySelector('[data-chat-container]') as HTMLElement;
  return {
    ...result,
    get instance() {
      return instance;
    },
    scrollEl,
  };
}

const targetFor = () => Math.max(0, layout.scrollHeight - 1 - layout.clientHeight);

beforeEach(() => {
  observed = [];
  consumerRef.current = null;
  layout.scrollHeight = 3000;
  layout.clientHeight = 400;
  installLayoutShims();
});

afterEach(cleanup);

describe('MessagesScrollContainer', () => {
  it('renders the trigger-card fallback above its children', () => {
    renderContainer();
    expect(screen.getByTestId('trigger-fallback')).toBeInTheDocument();
    expect(screen.getByTestId('child')).toBeInTheDocument();
  });

  // The scroll owner was previously mounted as an earlier SIBLING of this component, so its layout
  // effect ran before this element's ref attached and it silently gave up. Owning both refs here is
  // what makes that unrepresentable — assert the wiring, never pre-seed a ref to fake it.
  //
  // It also pins the consumer ref: search jump-to-match, older-message pagination, the load-older
  // IntersectionObserver root and Cmd+Down all read the element off `containerRef`, and they read it
  // through a plain RefObject rather than the hook's callback-ref-that-also-has-`.current`. If this
  // stopped being populated on attach, all four would silently no-op.
  it('attaches the viewport, the content column, and the consumer ref', () => {
    const { instance, scrollEl } = renderContainer();
    expect(instance.scrollRef.current).toBe(scrollEl);
    expect(instance.contentRef.current).toBe(scrollEl.querySelector('.px-2'));
    expect(consumerRef.current).toBe(scrollEl);
  });

  it('lands at the bottom during the initial commit, before any observer fires', () => {
    const { scrollEl } = renderContainer();
    // No flushResize() call above: the hook's own initial pass awaits a frame, so this asserts the
    // synchronous pre-paint pin. Without it the first painted frame shows the top of the thread.
    expect(scrollEl.scrollTop).toBe(targetFor());
  });

  // ChatDock writes its reserve in a layout effect that runs after this component's pin, so the
  // observer's first delivery, before the first paint, is what lands the last message above the stack.
  it('pins on the first observer delivery, after the dock reserve has lengthened the content', () => {
    const { scrollEl } = renderContainer();
    layout.scrollHeight = 3200;
    flushResize(scrollEl, layout.clientHeight);
    expect(scrollEl.scrollTop).toBe(targetFor());
  });

  it('does not pin on the first delivery once the user has left the bottom', () => {
    const { instance, scrollEl } = renderContainer();
    instance.state.isAtBottom = false;
    scrollEl.scrollTop = 100;
    layout.scrollHeight = 3200;
    flushResize(scrollEl, layout.clientHeight);
    expect(scrollEl.scrollTop).toBe(100);
  });

  it('re-pins when the viewport itself resizes (split-divider drag)', () => {
    const { instance, scrollEl } = renderContainer();
    expect(instance.state.isAtBottom).toBe(true);
    // The browser delivers one callback on observe(); nothing has changed yet at that point.
    flushResize(scrollEl, layout.clientHeight);

    // The hook observes only the content element, so a viewport-height change with unchanged
    // content records no resize and the resulting clamp reads as a deliberate scroll up.
    layout.clientHeight = 900;
    scrollEl.scrollTop = 100;
    flushResize(scrollEl, 900);

    expect(scrollEl.scrollTop).toBe(targetFor());
  });

  it('leaves the viewport alone on resize once the user has scrolled away', () => {
    const { instance, scrollEl } = renderContainer();
    flushResize(scrollEl, layout.clientHeight);
    instance.state.isAtBottom = false;

    layout.clientHeight = 900;
    scrollEl.scrollTop = 100;
    flushResize(scrollEl, 900);

    expect(scrollEl.scrollTop).toBe(100);
  });

  it('re-pins when a background sub-chat becomes the visible one again', () => {
    let instance!: StickToBottomInstance;
    const { rerender } = render(<Harness isActive={false} onInstance={(i) => (instance = i)} />);
    const scrollEl = document.querySelector('[data-chat-container]') as HTMLElement;
    scrollEl.scrollTop = 0;

    rerender(<Harness isActive onInstance={(i) => (instance = i)} />);

    expect(instance.state.isAtBottom).toBe(true);
    expect(scrollEl.scrollTop).toBe(targetFor());
  });

  it('does not yank a reactivated sub-chat the user had scrolled up in', () => {
    let instance!: StickToBottomInstance;
    const { rerender } = render(<Harness isActive={false} onInstance={(i) => (instance = i)} />);
    const scrollEl = document.querySelector('[data-chat-container]') as HTMLElement;
    instance.state.isAtBottom = false;
    scrollEl.scrollTop = 500;

    rerender(<Harness isActive onInstance={(i) => (instance = i)} />);

    expect(scrollEl.scrollTop).toBe(500);
  });

  // No sub-chat-switch test: ChatTabsRenderer keys each ChatViewInner by subChatId, so a switch
  // REMOUNTS this component rather than handing an existing one a new id. Driving a rerender with a
  // changed subChatId would assert a path the app cannot take — the mount test above is the real
  // coverage for "a newly opened sub-chat lands at the bottom".

  // The hook follows a content resize from the next frame, so a stack that grows while following
  // would cover the last message until then. The pin must land in the reserve's own delivery.
  describe('when the dock reserve changes', () => {
    it('pins in the same observer delivery as the reserve growth', () => {
      const { scrollEl } = renderContainer();
      const column = getColumn();
      flushColumn(column, 2800, 144);

      layout.scrollHeight = 3064;
      flushColumn(column, 2800, 208);

      expect(scrollEl.scrollTop).toBe(targetFor());
    });

    it("leaves growth under an unchanged reserve to the hook's animated follow", () => {
      const { scrollEl } = renderContainer();
      const column = getColumn();
      flushColumn(column, 2800, 144);
      const before = scrollEl.scrollTop;

      layout.scrollHeight = 3064;
      flushColumn(column, 2864, 144);

      expect(scrollEl.scrollTop).toBe(before);
    });

    it('does not pin a user who has scrolled up', () => {
      const { instance, scrollEl } = renderContainer();
      const column = getColumn();
      flushColumn(column, 2800, 144);
      instance.state.isAtBottom = false;
      scrollEl.scrollTop = 100;

      layout.scrollHeight = 3064;
      flushColumn(column, 2800, 208);

      expect(scrollEl.scrollTop).toBe(100);
    });

    it('holds still while the mouse is pressed in the thread, as in a drag-selection', () => {
      const { scrollEl } = renderContainer();
      const column = getColumn();
      flushColumn(column, 2800, 144);
      const before = scrollEl.scrollTop;
      // happy-dom models no pressed state; the browser keeps :active on the thread until mouse-up.
      vi.spyOn(scrollEl, 'matches').mockImplementation((selector) => selector === ':active');

      layout.scrollHeight = 3064;
      flushColumn(column, 2800, 208);

      expect(scrollEl.scrollTop).toBe(before);
    });
  });

  it('publishes the viewport height for the last group min-height', () => {
    const { scrollEl } = renderContainer();
    flushResize(scrollEl, 640);
    expect(scrollEl.style.getPropertyValue('--chat-container-height')).toBe('640px');
  });

  // MessageGroup exempts the newest two groups from content-visibility with :nth-last-child, so
  // the groups must stay the trailing children of the content column.
  it('keeps message groups as the trailing children of the content column', () => {
    render(
      <Harness onInstance={() => {}}>
        <MessageGroup>a</MessageGroup>
        <MessageGroup>b</MessageGroup>
        <MessageGroup isLastGroup>c</MessageGroup>
      </Harness>,
    );
    const column = screen.getByTestId('trigger-fallback').parentElement!;
    expect(column.firstElementChild).toBe(screen.getByTestId('trigger-fallback'));
    expect(column.lastElementChild).toHaveAttribute('data-last-group');
  });
});
