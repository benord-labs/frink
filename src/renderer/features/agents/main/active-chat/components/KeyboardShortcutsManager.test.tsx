// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KeyboardShortcutsManager } from './KeyboardShortcutsManager';

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

describe('KeyboardShortcutsManager', () => {
  it.each([
    ['Escape', { key: 'Escape' }],
    ['Ctrl+C', { key: 'c', code: 'KeyC', ctrlKey: true }],
    ['Cmd+Shift+Backspace', { key: 'Backspace', metaKey: true, shiftKey: true }],
    ['Ctrl+Shift+Backspace', { key: 'Backspace', ctrlKey: true, shiftKey: true }],
  ])(
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
            subChatId="sub-chat-1"
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
          subChatId="sub-chat-1"
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
          subChatId="sub-chat-1"
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
          subChatId="sub-chat-1"
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
        subChatId="sub-chat-1"
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
});
