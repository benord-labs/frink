// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskResultRecord } from '../../../../../../../shared/types/task-result';
import { ParkAnswerSurface } from './index';

// The driving task is resolved and polled by ActiveChat and passed in as a prop, so these tests
// exercise the render gate on that row directly — no query to mock.
let taskData: {
  id: string;
  status: string;
  flowRunId?: string | null;
  result?: TaskResultRecord;
} | null = null;

const QUESTIONS = [
  {
    header: 'Path',
    question: 'which',
    options: [{ label: 'Now', description: '' }],
    multiSelect: false,
  },
];

// Flow-driven by default: the reply-box variant only renders for flow tasks (a non-flow park
// keeps the composer, so a second input would be redundant).
const parked = (
  state: string,
  questions: TaskResultRecord[string] | undefined,
  summary?: string,
): NonNullable<typeof taskData> => {
  const agentSignal: TaskResultRecord = { state };
  if (questions !== undefined) agentSignal.questions = questions;
  if (summary !== undefined) agentSignal.summary = summary;
  return {
    id: 'driver1',
    status: 'needs_attention',
    flowRunId: 'run-1',
    result: { agentSignal },
  };
};

function renderSurface(suppressed = false, sent = true) {
  const onSubmitAnswer = vi.fn((_text: string, _metadata?: Record<string, unknown>) => sent);
  render(
    <ParkAnswerSurface
      task={taskData}
      subChatId="sub1"
      parentChatId="chat1"
      suppressed={suppressed}
      onSubmitAnswer={onSubmitAnswer}
    />,
  );
  return { onSubmitAnswer };
}

// The park sub-state matrix (transient parks, user-pause, blocked/partial, summaries) is covered
// by src/renderer/lib/agent-chat/flow-chat-surface-state.test.ts — these tests cover rendering.
describe('ParkAnswerSurface', () => {
  beforeEach(() => {
    taskData = null;
  });
  afterEach(cleanup);

  it('renders nothing when no driving task resolves', () => {
    taskData = null;
    renderSurface();
    expect(screen.queryByText('Now')).toBeNull();
    expect(screen.queryByPlaceholderText('Reply to continue…')).toBeNull();
  });

  it('renders nothing when suppressed (a live AskUserQuestion card is showing)', () => {
    taskData = parked('awaiting_input', QUESTIONS);
    renderSurface(true);
    expect(screen.queryByText('Now')).toBeNull();
  });

  it('renders nothing when the task is not parked (status !== needs_attention)', () => {
    taskData = {
      id: 'driver1',
      status: 'running',
      result: { agentSignal: { state: 'awaiting_input', questions: QUESTIONS } },
    };
    renderSurface();
    expect(screen.queryByText('Now')).toBeNull();
    expect(screen.queryByPlaceholderText('Reply to continue…')).toBeNull();
  });

  it('shows the options and submits the answer text plus display-only pairs', () => {
    taskData = parked('awaiting_input', QUESTIONS);
    const { onSubmitAnswer } = renderSurface();
    expect(screen.getByText('Now')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Now'));
    fireEvent.click(screen.getByText('Submit'));

    const [text, metadata] = onSubmitAnswer.mock.calls[0];
    // The answer restates its question: a park's answer always arrives as a standalone follow-up in
    // a later turn, and after a hold expiry the CLI has discarded the asking turn — a bare "Now"
    // would reach the agent with nothing to attach it to. The labels still ride separately as
    // display-only metadata.
    expect(text).toBe('Q: which\nA: Now');
    expect(text).not.toContain('<!--');
    expect(metadata).toEqual({
      answeredQuestions: [{ label: QUESTIONS[0].header, answer: 'Now' }],
    });
  });

  it('re-enables the card when the send does not go through (no permanent stuck state)', () => {
    taskData = parked('awaiting_input', QUESTIONS);
    const { onSubmitAnswer } = renderSurface(false, /* sent */ false);
    fireEvent.click(screen.getByText('Now'));
    fireEvent.click(screen.getByText('Submit'));
    // Send reported failure -> card resets -> the user can submit again (not frozen on isSubmitting).
    fireEvent.click(screen.getByText('Submit'));
    expect(onSubmitAnswer).toHaveBeenCalledTimes(2);
  });

  it('does not render the Skip All action for a parked card', () => {
    taskData = parked('awaiting_input', QUESTIONS);
    renderSurface();
    expect(screen.getByText('Now')).toBeInTheDocument();
    expect(screen.queryByText('Skip All')).toBeNull();
  });

  it('renders the reply box with the agent summary for a questionless awaiting_input park', () => {
    taskData = parked('awaiting_input', undefined, 'how should I verify?');
    renderSurface();
    expect(screen.getByText('how should I verify?')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Reply to continue…')).toBeInTheDocument();
  });

  it('renders the reply box for a blocked park with fallback copy when no summary', () => {
    taskData = parked('blocked', undefined);
    renderSurface();
    expect(screen.getByText('The agent needs your input to continue.')).toBeInTheDocument();
  });

  it('submits reply text and clears the input on a successful send', () => {
    taskData = parked('awaiting_input', undefined, 'which path?');
    const { onSubmitAnswer } = renderSurface();
    const input = screen.getByPlaceholderText('Reply to continue…');
    fireEvent.change(input, { target: { value: 'take path B' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSubmitAnswer).toHaveBeenCalledWith('take path B');
    expect(input).toHaveValue('');
  });

  it('keeps the reply text when the send does not go through, so the user can retry', () => {
    taskData = parked('blocked', undefined);
    const { onSubmitAnswer } = renderSurface(false, /* sent */ false);
    const input = screen.getByPlaceholderText('Reply to continue…');
    fireEvent.change(input, { target: { value: 'unblock via X' } });
    fireEvent.click(screen.getByText('Reply'));
    expect(onSubmitAnswer).toHaveBeenCalledWith('unblock via X');
    expect(input).toHaveValue('unblock via X');
  });

  it('does not submit an empty or whitespace-only reply', () => {
    taskData = parked('blocked', undefined);
    const { onSubmitAnswer } = renderSurface();
    const input = screen.getByPlaceholderText('Reply to continue…');
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSubmitAnswer).not.toHaveBeenCalled();
  });

  it('renders nothing for a transient park (usage limit) — TaskControls owns Continue/Retry', () => {
    taskData = {
      id: 'driver1',
      status: 'needs_attention',
      flowRunId: 'run-1',
      result: { usageLimit: { at: 1 } },
    };
    renderSurface();
    expect(screen.queryByPlaceholderText('Reply to continue…')).toBeNull();
  });

  it('renders no reply box for a NON-flow prose park (the composer is still visible)', () => {
    taskData = { ...parked('awaiting_input', undefined, 'which path?'), flowRunId: null };
    renderSurface();
    expect(screen.queryByPlaceholderText('Reply to continue…')).toBeNull();
  });

  it('still renders the questions card for a NON-flow park (pick affordance, not a duplicate input)', () => {
    taskData = { ...parked('awaiting_input', QUESTIONS), flowRunId: null };
    renderSurface();
    expect(screen.getByText('Now')).toBeInTheDocument();
  });
});
