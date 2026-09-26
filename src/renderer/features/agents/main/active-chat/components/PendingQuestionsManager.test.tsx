// @vitest-environment happy-dom
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { createRef } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentUserQuestionHandle } from '../../../AgentUserQuestion';
import type { Message } from '../../../stores/message-store';
import { usePendingQuestionsManager } from './PendingQuestionsManager';
import { UserQuestionsPanel } from './UserQuestionsPanel';

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  listHeld: vi.fn(),
  setMap: vi.fn(),
  current: new Map<string, unknown>(),
}));

vi.mock('jotai', () => ({
  useAtom: () => [mocks.current, mocks.setMap],
}));
vi.mock('../../../atoms', () => ({
  pendingUserQuestionsAtom: Symbol('pendingUserQuestionsAtom'),
  QUESTIONS_SKIPPED_MESSAGE: 'User skipped questions - proceed with defaults',
}));
vi.mock('../../../../../lib/trpc', () => ({
  trpcClient: {
    claude: { respondToolApproval: { mutate: mocks.mutate } },
    socket: { listPendingQuestionSubChatIds: { query: mocks.listHeld } },
  },
}));
// AgentUserQuestion renders question strings as markdown; the real renderer pulls theme atoms
// that clash with the narrow jotai mock above, so it is stubbed to plain text here.
vi.mock('../../../../../components/chat-markdown-renderer', () => ({
  ChatMarkdownRenderer: ({ content }: { content: string }) => <span>{content}</span>,
}));
// Same clash via lib/atoms: keep keyboard ownership true so shortcuts behave as in the real chat.
vi.mock('../../../../../lib/work-queue/chat-owns-keyboard-shortcuts', () => ({
  chatOwnsKeyboardShortcuts: () => true,
}));

const pending = {
  subChatId: 'sub-1',
  parentChatId: 'chat-1',
  toolUseId: 'tool-1',
  questions: [
    {
      question: 'Continue?',
      header: 'Decision',
      multiSelect: false,
      options: [{ label: 'Yes', description: 'Continue' }],
    },
  ],
};

describe('usePendingQuestionsManager', () => {
  beforeEach(() => {
    mocks.current = new Map([['tool-1', pending]]);
    mocks.mutate.mockReset();
    mocks.listHeld.mockReset().mockResolvedValue(['sub-1']);
    mocks.setMap.mockReset().mockImplementation((update) => {
      mocks.current = update(mocks.current);
    });
  });

  type ManagerProps = Parameters<typeof usePendingQuestionsManager>[0];
  const initialProps = (): ManagerProps => ({
    subChatId: 'sub-1',
    isStreaming: true,
    lastAssistantMessage: null,
  });

  // A message carrying one AskUserQuestion tool part in a terminal state.
  const settledPart = (toolCallId: string): Message => ({
    id: `msg-${toolCallId}`,
    role: 'assistant',
    parts: [{ type: 'tool-AskUserQuestion', toolCallId, state: 'output-available', input: {} }],
  });

  it('keeps the question when the stream stops but main still holds it', async () => {
    const { rerender } = renderHook((props) => usePendingQuestionsManager(props), {
      initialProps: initialProps(),
    });

    rerender({ ...initialProps(), isStreaming: false });

    await waitFor(() => expect(mocks.listHeld).toHaveBeenCalled());
    expect(mocks.current.get('tool-1')).toBe(pending);
  });

  it('clears the question when the stream stops and main no longer holds it', async () => {
    // Covers a park whose timeout chunk this pane missed: main is the source of truth.
    mocks.listHeld.mockResolvedValue([]);
    const { rerender } = renderHook((props) => usePendingQuestionsManager(props), {
      initialProps: initialProps(),
    });

    rerender({ ...initialProps(), isStreaming: false });

    await waitFor(() => expect(mocks.current.has('tool-1')).toBe(false));
  });

  it('does not ask main while the stream is still running', () => {
    renderHook((props) => usePendingQuestionsManager(props), { initialProps: initialProps() });

    expect(mocks.listHeld).not.toHaveBeenCalled();
    expect(mocks.current.get('tool-1')).toBe(pending);
  });

  it('clears the question once its own tool call reaches a terminal state', () => {
    const { rerender } = renderHook((props) => usePendingQuestionsManager(props), {
      initialProps: initialProps(),
    });

    rerender({ ...initialProps(), lastAssistantMessage: settledPart('tool-1') });

    expect(mocks.current.has('tool-1')).toBe(false);
  });

  it('ignores a terminal part that belongs to a different question', () => {
    const { rerender } = renderHook((props) => usePendingQuestionsManager(props), {
      initialProps: initialProps(),
    });

    rerender({ ...initialProps(), lastAssistantMessage: settledPart('tool-other') });

    expect(mocks.current.get('tool-1')).toBe(pending);
  });

  it('keeps the question visible when parking won the backend answer race', async () => {
    mocks.mutate.mockResolvedValue({ ok: false });
    const { result } = renderHook(() => usePendingQuestionsManager(initialProps()));

    await act(async () => {
      await result.current.handleQuestionsAnswer({ Continue: 'Yes' });
    });

    expect(mocks.current.get('tool-1')).toBe(pending);
  });

  it('clears the question after the backend accepts its answer', async () => {
    mocks.mutate.mockResolvedValue({ ok: true });
    const { result } = renderHook(() => usePendingQuestionsManager(initialProps()));

    await act(async () => {
      await result.current.handleQuestionsAnswer({ Continue: 'Yes' });
    });

    expect(mocks.current.has('tool-1')).toBe(false);
  });

  it('keeps the question visible when answer transport fails', async () => {
    mocks.mutate.mockRejectedValue(new Error('transport failed'));
    const { result } = renderHook(() => usePendingQuestionsManager(initialProps()));

    let accepted: boolean | undefined;
    await act(async () => {
      accepted = await result.current.handleQuestionsAnswer({ Continue: 'Yes' });
    });

    expect(accepted).toBe(false);
    expect(mocks.current.get('tool-1')).toBe(pending);
  });

  it('keeps a skipped question visible when parking already owns the backend latch', async () => {
    mocks.mutate.mockResolvedValue({ ok: false });
    const { result } = renderHook(() => usePendingQuestionsManager(initialProps()));

    await act(async () => {
      await result.current.handleQuestionsSkip();
    });

    expect(mocks.current.get('tool-1')).toBe(pending);
  });

  it('clears a skipped question after the backend accepts its denial', async () => {
    mocks.mutate.mockResolvedValue({ ok: true });
    const { result } = renderHook(() => usePendingQuestionsManager(initialProps()));

    await act(async () => {
      await result.current.handleQuestionsSkip();
    });

    expect(mocks.current.has('tool-1')).toBe(false);
  });

  it('answers the first queued question without deleting the next one', async () => {
    const nextPending = { ...pending, toolUseId: 'tool-2' };
    mocks.current = new Map([
      ['tool-1', pending],
      ['tool-2', nextPending],
    ]);
    mocks.mutate.mockResolvedValue({ ok: true });
    const { result } = renderHook(() => usePendingQuestionsManager(initialProps()));

    await act(async () => {
      await result.current.handleQuestionsAnswer({ Continue: 'Yes' });
    });

    expect(mocks.current.has('tool-1')).toBe(false);
    expect(mocks.current.get('tool-2')).toBe(nextPending);
  });

  it('re-enables and announces a retained card after the answer CAS is rejected', async () => {
    const handleQuestionsAnswer = vi.fn(async () => false);
    render(
      <UserQuestionsPanel
        pendingQuestions={pending}
        questionRef={createRef<AgentUserQuestionHandle>()}
        canStopTurn={false}
        onStopTurn={vi.fn()}
        handleQuestionsAnswer={handleQuestionsAnswer}
        handleQuestionsSkip={vi.fn(async () => true)}
      />,
    );

    fireEvent.click(screen.getByText('Yes'));
    fireEvent.click(screen.getByText('Submit'));

    await waitFor(() => expect(handleQuestionsAnswer).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect((screen.getByText('Submit') as HTMLButtonElement).disabled).toBe(false),
    );
    expect(screen.getByRole('status').textContent).toContain('Answer not sent');
  });

  it('re-enables and announces a retained card after the skip CAS is rejected', async () => {
    const handleQuestionsSkip = vi.fn(async () => false);
    render(
      <UserQuestionsPanel
        pendingQuestions={pending}
        questionRef={createRef<AgentUserQuestionHandle>()}
        canStopTurn={false}
        onStopTurn={vi.fn()}
        handleQuestionsAnswer={vi.fn(async () => true)}
        handleQuestionsSkip={handleQuestionsSkip}
      />,
    );

    fireEvent.click(screen.getByText('Skip All'));

    await waitFor(() => expect(handleQuestionsSkip).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect((screen.getByText('Skip All') as HTMLButtonElement).disabled).toBe(false),
    );
    expect(screen.getByRole('status').textContent).toContain('Skip not sent');
  });

  it('re-enables and announces a retained card after answer transport failure', async () => {
    const handleQuestionsAnswer = vi.fn(async () => {
      throw new Error('transport failed');
    });
    render(
      <UserQuestionsPanel
        pendingQuestions={pending}
        questionRef={createRef<AgentUserQuestionHandle>()}
        canStopTurn={false}
        onStopTurn={vi.fn()}
        handleQuestionsAnswer={handleQuestionsAnswer}
        handleQuestionsSkip={vi.fn(async () => true)}
      />,
    );

    fireEvent.click(screen.getByText('Yes'));
    fireEvent.click(screen.getByText('Submit'));

    await waitFor(() => expect(handleQuestionsAnswer).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect((screen.getByText('Submit') as HTMLButtonElement).disabled).toBe(false),
    );
    expect(screen.getByRole('status').textContent).toContain('Answer not sent');
  });
});
