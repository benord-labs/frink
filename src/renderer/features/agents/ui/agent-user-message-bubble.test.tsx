// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createStore, Provider } from 'jotai';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnsweredQuestion } from '../../../../shared/lib/agent-questions/answered-questions';
import { buildHiddenWakeMessage } from '../../../../shared/lib/message-markers/hidden-wake-marker';
import type { TriggerBubbleParseResult } from '../../../../shared/lib/trigger-bubble-marker';
import { chatMarkdownModeAtom } from '../atoms';
import { AgentUserMessageBubble } from './agent-user-message-bubble';

const parseTriggerBubbleMessageMock = vi.fn<(text: string) => TriggerBubbleParseResult>();
const extractTaskBubbleDataMock =
  vi.fn<(text: string) => { taskData: Record<string, unknown> | null; fullPrompt: string }>();
type SlashParts = {
  textMentions: unknown[];
  commandName: string | null;
  commandText: string | null;
  cleanedText: string;
};
const parseSlashCommandDisplayPartsMock = vi.fn<(raw: string) => SlashParts>();
const overflowDetectionMock = vi.fn(() => false);

const triggerBubbleMock = vi.fn(
  (props: { data: Record<string, unknown>; triggerContext?: unknown; fullPrompt?: string }) => (
    <div data-testid="trigger-bubble">
      {String(props.data.triggerRuleName ?? 'trigger')}
      {props.triggerContext ? ' with-context' : ' no-context'}
      {props.fullPrompt ? ` ${props.fullPrompt}` : ''}
    </div>
  ),
);
const taskBubbleMock = vi.fn((props: { data: Record<string, unknown> }) => (
  <div data-testid="task-bubble">{String(props.data.taskTitle ?? 'task')}</div>
));

vi.mock('../../../../shared/lib/trigger-bubble-marker', () => ({
  parseTriggerBubbleMessage: (text: string) => parseTriggerBubbleMessageMock(text),
}));

vi.mock('@/lib/tasks/format-task-message', () => ({
  extractTaskBubbleData: (text: string) => extractTaskBubbleDataMock(text),
}));

vi.mock('../../../hooks/use-overflow-detection', () => ({
  useOverflowDetection: () => overflowDetectionMock(),
}));

vi.mock('../search', () => ({
  useSearchHighlight: () => [],
  useSearchQuery: () => '',
}));

vi.mock('../commands/parse-slash-command-display', () => ({
  parseSlashCommandDisplayParts: (rawMessage: string) =>
    parseSlashCommandDisplayPartsMock(rawMessage),
}));

vi.mock('../mentions/render-file-mentions', () => ({
  RenderFileMentions: ({ text }: { text: string }) => <span data-testid="raw-mention">{text}</span>,
  TextMentionBlocks: () => null,
}));

vi.mock('../../../components/chat-markdown-renderer', () => ({
  ChatMarkdownRenderer: ({ content }: { content: string }) => (
    <div data-testid="markdown-rendered">{content}</div>
  ),
}));

vi.mock('./agent-image-item', () => ({
  AgentImageItem: () => null,
}));

vi.mock('./trigger-bubble', () => ({
  TriggerBubble: (props: { data: Record<string, unknown>; triggerContext?: unknown }) =>
    triggerBubbleMock(props),
}));

vi.mock('./task-bubble', () => ({
  TaskBubble: (props: { data: Record<string, unknown> }) => taskBubbleMock(props),
}));

describe('AgentUserMessageBubble', () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    localStorage.clear();
    parseTriggerBubbleMessageMock.mockReset();
    extractTaskBubbleDataMock.mockReset();
    triggerBubbleMock.mockClear();
    taskBubbleMock.mockClear();
    parseSlashCommandDisplayPartsMock.mockReset();
    overflowDetectionMock.mockReturnValue(false);
    parseSlashCommandDisplayPartsMock.mockImplementation((raw: string) => ({
      textMentions: [],
      commandName: null,
      commandText: null,
      cleanedText: raw,
    }));
    parseTriggerBubbleMessageMock.mockReturnValue({
      triggerData: null,
      triggerContext: null,
      fullPrompt: '',
    } as TriggerBubbleParseResult);
    extractTaskBubbleDataMock.mockReturnValue({ taskData: null, fullPrompt: '' });
  });

  it('renders nothing for a hidden wake message (e.g. the Carry on nudge)', () => {
    const { container } = render(
      <AgentUserMessageBubble
        messageId="m-wake"
        textContent={buildHiddenWakeMessage('Your previous attempt stopped — carry on.')}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the answer card from metadata, never from the message text', () => {
    const answered: AnsweredQuestion[] = [
      { label: 'Coverage gate', answer: 'Opt coverage out for this ship' },
      { label: 'Clone gate', answer: 'Allowlist as pre-existing' },
    ];
    const { container } = render(
      <AgentUserMessageBubble
        messageId="m-answer"
        textContent="Coverage gate: Opt coverage out for this ship\nClone gate: Allowlist as pre-existing"
        answeredQuestions={answered}
      />,
    );

    expect(screen.getByText('Answered · 2 questions')).toBeInTheDocument();
    expect(screen.getByText('Coverage gate')).toBeInTheDocument();
    expect(screen.getByText('Opt coverage out for this ship')).toBeInTheDocument();
    // The card replaces the body — the raw text must not render alongside it.
    expect(screen.queryByTestId('raw-mention')).not.toBeInTheDocument();
    // MessageGroup measures [data-user-bubble] for --user-message-height, and search scrolls to
    // [data-message-id][data-part-index] — the card must keep both hooks the plain bubble has.
    expect(container.querySelector('[data-user-bubble]')).not.toBeNull();
    expect(
      container.querySelector('[data-message-id="m-answer"][data-part-index="0"]'),
    ).not.toBeNull();
  });

  it('renders TriggerBubble and passes trigger context when trigger marker is present', () => {
    parseTriggerBubbleMessageMock.mockReturnValue({
      triggerData: { source: 'shortcut', triggerRuleName: 'Rule A', autoStart: true },
      triggerContext: { source: 'shortcut' },
      fullPrompt: 'trigger prompt',
    } as TriggerBubbleParseResult);
    extractTaskBubbleDataMock.mockReturnValue({ taskData: null, fullPrompt: '' });

    render(<AgentUserMessageBubble messageId="m1" textContent="trigger text" />);

    expect(screen.getByTestId('trigger-bubble')).toBeInTheDocument();
    expect(screen.queryByTestId('task-bubble')).not.toBeInTheDocument();
    expect(triggerBubbleMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ triggerRuleName: 'Rule A' }),
        triggerContext: expect.objectContaining({ source: 'shortcut' }),
      }),
    );
    expect(extractTaskBubbleDataMock).not.toHaveBeenCalled();
  });

  it('renders TaskBubble when task data exists without trigger marker', () => {
    parseTriggerBubbleMessageMock.mockReturnValue({
      triggerData: null,
      triggerContext: null,
      fullPrompt: 'plain',
    });
    extractTaskBubbleDataMock.mockReturnValue({
      taskData: { taskTitle: 'Task A' },
      fullPrompt: 'task prompt',
    });

    render(<AgentUserMessageBubble messageId="m2" textContent="task text" />);

    expect(screen.getByTestId('task-bubble')).toBeInTheDocument();
    expect(screen.queryByTestId('trigger-bubble')).not.toBeInTheDocument();
  });

  it('renders plain text bubble when neither trigger nor task data exists', () => {
    parseTriggerBubbleMessageMock.mockReturnValue({
      triggerData: null,
      triggerContext: null,
      fullPrompt: 'plain',
    });
    extractTaskBubbleDataMock.mockReturnValue({
      taskData: null,
      fullPrompt: 'plain',
    });

    render(<AgentUserMessageBubble messageId="m3" textContent="plain text body" />);

    expect(screen.queryByTestId('trigger-bubble')).not.toBeInTheDocument();
    expect(screen.queryByTestId('task-bubble')).not.toBeInTheDocument();
    expect(screen.getByText('plain text body')).toBeInTheDocument();
  });

  function renderInStore(ui: ReactNode, mode: 'raw' | 'rendered' | null = null) {
    const store = createStore();
    if (mode !== null) store.set(chatMarkdownModeAtom, mode);
    return render(<Provider store={store}>{ui}</Provider>);
  }

  it('shows the markdown toggle and renders markdown when toggled', () => {
    renderInStore(<AgentUserMessageBubble messageId="md1" textContent="**Project**: frink" />);

    // Default (user) is raw: literal text via RenderFileMentions, no rendered markdown.
    expect(screen.getByTestId('raw-mention')).toHaveTextContent('**Project**: frink');
    expect(screen.queryByTestId('markdown-rendered')).not.toBeInTheDocument();

    const toggle = screen.getByRole('button', { name: 'Render markdown' });
    fireEvent.click(toggle);

    expect(screen.getByTestId('markdown-rendered')).toHaveTextContent('**Project**: frink');
    expect(screen.queryByTestId('raw-mention')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'View raw text' })).toBeInTheDocument();
  });

  it('hides the toggle when no markdown is detected', () => {
    renderInStore(<AgentUserMessageBubble messageId="md2" textContent="just plain words here" />);

    expect(screen.queryByRole('button', { name: 'Render markdown' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'View raw text' })).not.toBeInTheDocument();
  });

  it('keeps the command pill on the raw path in rendered mode', () => {
    parseSlashCommandDisplayPartsMock.mockReturnValue({
      textMentions: [],
      commandName: 'plan',
      commandText: '/plan',
      cleanedText: 'fix the **thing**',
    });

    renderInStore(
      <AgentUserMessageBubble messageId="md3" textContent="/plan fix the **thing**" />,
      'rendered',
    );

    // Command pill stays rendered via RenderFileMentions (raw-mention mock)...
    expect(screen.getByText('/plan')).toBeInTheDocument();
    // ...while the user's prose renders as markdown.
    expect(screen.getByTestId('markdown-rendered')).toHaveTextContent('fix the **thing**');
  });

  it('keeps Show more as the last row of the collapsed card, never over its text', () => {
    overflowDetectionMock.mockReturnValue(true);
    const { container } = render(<AgentUserMessageBubble messageId="long" textContent="long" />);

    const text = container.querySelector('[data-message-id="long"]');
    const toggle = screen.getByRole('button', { name: 'Show more' });
    expect(toggle.className).not.toMatch(/\babsolute\b/);
    // Same opaque card as the text, so a bubble stuck to the top never lets text show beside it.
    const card = text?.parentElement?.parentElement;
    expect(card?.contains(toggle)).toBe(true);
    // Outside the text and its fade, so the fade never paints over the toggle.
    expect(text?.parentElement?.contains(toggle)).toBe(false);
  });

  it('reserves a right gutter on the shell only when endGutter is set', () => {
    const { container, rerender } = render(
      <AgentUserMessageBubble messageId="g1" textContent="text" endGutter />,
    );
    const card = () =>
      container.querySelector('[data-message-id="g1"]')?.parentElement?.parentElement;
    expect(card()).toHaveClass('pr-10');

    rerender(<AgentUserMessageBubble messageId="g1" textContent="text" />);
    expect(card()).not.toHaveClass('pr-10');
  });
});
