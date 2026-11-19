// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KeyboardShortcutsManager } from './KeyboardShortcutsManager';

const setPlatform = (platform: 'darwin' | 'win32' | undefined) => {
  Object.assign(window, { desktopApi: platform ? { platform } : undefined });
};

beforeEach(() => setPlatform('darwin'));
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  setPlatform(undefined);
});

const STOP_KEYS = [
  ['Escape', { key: 'Escape' }],
  ['Ctrl+C', { key: 'c', code: 'KeyC', ctrlKey: true }],
  ['Cmd+Shift+Backspace', { key: 'Backspace', metaKey: true, shiftKey: true }],
  ['Ctrl+Shift+Backspace', { key: 'Backspace', ctrlKey: true, shiftKey: true }],
] as const;

describe('KeyboardShortcutsManager', () => {
  it.each(STOP_KEYS)(
    'stops a streaming chat for %s, but never while a flow run owns Stop',
    async (_name, key) => {
      const stop = vi.fn(async () => undefined);
      const manager = (suppressRawStop: boolean) => (
        <KeyboardShortcutsManager
          isActive={true}
          isPaneActive={true}
          isStreaming={true}
          pendingQuestions={null}
          hasUnapprovedPlan={false}
          editorRef={createRef()}
          stop={stop}
          handleQuestionsSkip={vi.fn(async () => undefined)}
          handleApprovePlan={vi.fn()}
          scrollToBottom={vi.fn()}
          suppressRawStop={suppressRawStop}
        />
      );
      const press = () =>
        act(async () => {
          fireEvent.keyDown(document.body, key);
          await Promise.resolve();
        });

      const { rerender } = render(manager(true));
      await press();
      expect(stop).not.toHaveBeenCalled();

      rerender(manager(false));
      await press();
      expect(stop).toHaveBeenCalledOnce();
    },
  );

  it.each(STOP_KEYS)(
    'does not stop a streaming chat for %s while Work Queue owns shortcuts',
    async (_name, key) => {
      const stop = vi.fn(async () => undefined);
      render(
        <>
          <button type="button" data-agents-destination="workqueue">
            Work Queue
          </button>
          <KeyboardShortcutsManager
            isActive={true}
            isPaneActive={true}
            isStreaming={true}
            pendingQuestions={null}
            hasUnapprovedPlan={false}
            editorRef={createRef()}
            stop={stop}
            handleQuestionsSkip={vi.fn(async () => undefined)}
            handleApprovePlan={vi.fn()}
            scrollToBottom={vi.fn()}
          />
        </>,
      );

      await act(async () => {
        fireEvent.keyDown(screen.getByRole('button', { name: 'Work Queue' }), key);
        await Promise.resolve();
      });

      expect(stop).not.toHaveBeenCalled();
    },
  );

  it('does not stop a streaming chat hidden behind a side panel that fills its pane', async () => {
    const original = Element.prototype.checkVisibility;
    Element.prototype.checkVisibility = function (this: Element) {
      return this.closest('[data-hidden-chat]') === null;
    };
    const stop = vi.fn(async () => undefined);
    render(
      <div data-hidden-chat>
        <KeyboardShortcutsManager
          isActive={true}
          isPaneActive={true}
          isStreaming={true}
          pendingQuestions={null}
          hasUnapprovedPlan={false}
          editorRef={createRef()}
          stop={stop}
          handleQuestionsSkip={vi.fn(async () => undefined)}
          handleApprovePlan={vi.fn()}
          scrollToBottom={vi.fn()}
        />
      </div>,
    );

    await act(async () => {
      fireEvent.keyDown(document.body, { key: 'Escape' });
      await Promise.resolve();
    });

    Element.prototype.checkVisibility = original;
    expect(stop).not.toHaveBeenCalled();
  });

  it('does not skip pending questions while Work Queue owns Escape', async () => {
    const handleQuestionsSkip = vi.fn(async () => undefined);
    render(
      <>
        <button type="button" data-agents-destination="workqueue">
          Work Queue
        </button>
        <KeyboardShortcutsManager
          isActive={true}
          isPaneActive={true}
          isStreaming={true}
          pendingQuestions={{}}
          hasUnapprovedPlan={true}
          editorRef={createRef()}
          stop={vi.fn(async () => undefined)}
          handleQuestionsSkip={handleQuestionsSkip}
          handleApprovePlan={vi.fn()}
          scrollToBottom={vi.fn()}
        />
      </>,
    );

    await act(async () => {
      fireEvent.keyDown(screen.getByRole('button', { name: 'Work Queue' }), { key: 'Escape' });
      await Promise.resolve();
    });

    expect(handleQuestionsSkip).not.toHaveBeenCalled();
  });

  it('does not abandon edits, approve plans, or scroll while Work Queue owns shortcuts', () => {
    const onAbandonEdit = vi.fn();
    const handleApprovePlan = vi.fn();
    const scrollToBottom = vi.fn();
    render(
      <>
        <button type="button" data-agents-destination="workqueue">
          Work Queue
        </button>
        <KeyboardShortcutsManager
          isActive={true}
          isPaneActive={true}
          isStreaming={false}
          pendingQuestions={null}
          hasUnapprovedPlan={true}
          editorRef={createRef()}
          stop={vi.fn(async () => undefined)}
          handleQuestionsSkip={vi.fn(async () => undefined)}
          handleApprovePlan={handleApprovePlan}
          scrollToBottom={scrollToBottom}
          editingItemId="queued-item-1"
          onAbandonEdit={onAbandonEdit}
        />
      </>,
    );

    const workQueue = screen.getByRole('button', { name: 'Work Queue' });
    fireEvent.keyDown(workQueue, { key: 'Escape' });
    fireEvent.keyDown(workQueue, {
      key: 'Enter',
      metaKey: true,
    });
    fireEvent.keyDown(workQueue, {
      key: 'ArrowDown',
      metaKey: true,
    });

    expect(onAbandonEdit).not.toHaveBeenCalled();
    expect(handleApprovePlan).not.toHaveBeenCalled();
    expect(scrollToBottom).not.toHaveBeenCalled();
  });

  it('keeps plan approval and pane scrolling active when chat owns shortcuts', () => {
    const handleApprovePlan = vi.fn();
    const scrollToBottom = vi.fn();
    render(
      <KeyboardShortcutsManager
        isActive={true}
        isPaneActive={true}
        isStreaming={false}
        pendingQuestions={null}
        hasUnapprovedPlan={true}
        editorRef={createRef()}
        stop={vi.fn(async () => undefined)}
        handleQuestionsSkip={vi.fn(async () => undefined)}
        handleApprovePlan={handleApprovePlan}
        scrollToBottom={scrollToBottom}
      />,
    );

    fireEvent.keyDown(window, { key: 'Enter', metaKey: true });
    fireEvent.keyDown(window, { key: 'ArrowDown', ctrlKey: true });

    expect(handleApprovePlan).toHaveBeenCalledOnce();
    expect(scrollToBottom).toHaveBeenCalledOnce();
  });

  it('approves a plan with Ctrl+Enter on Windows and Linux, not Meta+Enter', () => {
    setPlatform('win32');
    const handleApprovePlan = vi.fn();
    render(
      <KeyboardShortcutsManager
        isActive={true}
        isPaneActive={true}
        isStreaming={false}
        pendingQuestions={null}
        hasUnapprovedPlan={true}
        editorRef={createRef()}
        stop={vi.fn(async () => undefined)}
        handleQuestionsSkip={vi.fn(async () => undefined)}
        handleApprovePlan={handleApprovePlan}
        scrollToBottom={vi.fn()}
      />,
    );

    fireEvent.keyDown(window, { key: 'Enter', metaKey: true });
    expect(handleApprovePlan).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'Enter', ctrlKey: true });
    expect(handleApprovePlan).toHaveBeenCalledOnce();
  });

  it('lets the approve shortcut own Ctrl+Enter typed in the composer, so the draft is not also sent', () => {
    setPlatform('win32');
    const handleApprovePlan = vi.fn();
    const submit = vi.fn();
    render(
      <>
        <textarea
          aria-label="composer"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) submit();
          }}
        />
        <KeyboardShortcutsManager
          isActive={true}
          isPaneActive={true}
          isStreaming={false}
          pendingQuestions={null}
          hasUnapprovedPlan={true}
          editorRef={createRef()}
          stop={vi.fn(async () => undefined)}
          handleQuestionsSkip={vi.fn(async () => undefined)}
          handleApprovePlan={handleApprovePlan}
          scrollToBottom={vi.fn()}
        />
      </>,
    );

    const composer = screen.getByLabelText('composer');
    fireEvent.keyDown(composer, { key: 'Enter', ctrlKey: true });
    expect(handleApprovePlan).toHaveBeenCalledOnce();
    expect(submit).not.toHaveBeenCalled();

    fireEvent.keyDown(composer, { key: 'Enter' });
    expect(submit).toHaveBeenCalledOnce();
  });

  it('runs one action per Cmd+Enter alongside other window capture listeners', () => {
    const handleApprovePlan = vi.fn();
    const earlierOwner = vi.fn((e: KeyboardEvent) => e.preventDefault());
    window.addEventListener('keydown', earlierOwner, true);
    const view = (approve: () => void) => (
      <KeyboardShortcutsManager
        isActive={true}
        isPaneActive={true}
        isStreaming={false}
        pendingQuestions={null}
        hasUnapprovedPlan={true}
        editorRef={createRef()}
        stop={vi.fn(async () => undefined)}
        handleQuestionsSkip={vi.fn(async () => undefined)}
        handleApprovePlan={approve}
        scrollToBottom={vi.fn()}
      />
    );
    const { unmount } = render(view(handleApprovePlan));

    // An earlier capture listener (the hotkeys manager) already owns this chord.
    fireEvent.keyDown(window, { key: 'Enter', metaKey: true });
    expect(handleApprovePlan).not.toHaveBeenCalled();
    window.removeEventListener('keydown', earlierOwner, true);
    unmount();

    // Approval registered first: a later capture listener must not also act on the chord.
    render(view(handleApprovePlan));
    const laterListener = vi.fn();
    window.addEventListener('keydown', laterListener, true);
    fireEvent.keyDown(window, { key: 'Enter', metaKey: true });
    window.removeEventListener('keydown', laterListener, true);
    expect(handleApprovePlan).toHaveBeenCalledOnce();
    expect(laterListener).not.toHaveBeenCalled();
  });
});
