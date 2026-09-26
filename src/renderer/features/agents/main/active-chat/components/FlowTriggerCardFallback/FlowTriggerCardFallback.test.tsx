// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FlowTriggerCardFallback } from './index';

// Real trigger-context validators / summary run here (they own the parse contract this component
// leans on) — only the wiring boundaries are stubbed: the atom (list-emptiness), the tRPC query
// (the task), and TriggerBubble (props captured, so the "unit passes but the wiring is wrong" gap
// is closed). A realistic Shortcut context is fed through unchanged.
const TRIGGER_CTX = {
  source: 'shortcut',
  sourceAccountId: 'acc-1',
  eventType: 'story_update',
  triggeredBy: { name: 'Benji' },
  timestamp: '2026-07-19T12:00:00.000Z',
  fullContent: { name: 'Evaluate Shortcut story - 34', url: 'https://app.shortcut.com/story/34' },
  // autoStart intentionally omitted — asserts withTriggerContextDefaults ran on the value the card gets.
};
const DESC = 'Evaluate Shortcut story - 34';

let userMsgIds: string[] = [];
let taskData: { triggerContext?: unknown; description?: string | null; status?: string } | null =
  null;
// biome-ignore lint/suspicious/noExplicitAny: test capture of arbitrary component props
let bubbleProps: any = null;
let capturedQueryInput: { subChatId: string; fallbackTaskId: string | null } | undefined;

vi.mock('jotai', () => ({ useAtomValue: () => userMsgIds }));
vi.mock('../../../../stores/message-store', () => ({
  userMessageIdsForSubChatAtomFamily: (id: string) => id,
}));
vi.mock('../../../../../../lib/trpc', () => ({
  trpc: {
    tasks: {
      getActionableTaskForSubChat: {
        useQuery: (input: { subChatId: string; fallbackTaskId: string | null }) => {
          capturedQueryInput = input;
          return { data: taskData };
        },
      },
    },
  },
}));
vi.mock('../../../../ui/trigger-bubble', () => ({
  // biome-ignore lint/suspicious/noExplicitAny: test capture of arbitrary component props
  TriggerBubble: (props: any) => {
    bubbleProps = props;
    return <div data-testid="trigger-bubble" />;
  },
}));

const renderFallback = (pinnedTaskId: string | null = null) =>
  render(<FlowTriggerCardFallback subChatId="sub-1" pinnedTaskId={pinnedTaskId} />);

describe('FlowTriggerCardFallback', () => {
  beforeEach(() => {
    userMsgIds = [];
    taskData = { triggerContext: TRIGGER_CTX, description: DESC, status: 'failed' };
    bubbleProps = null;
    capturedQueryInput = undefined;
  });
  afterEach(() => cleanup());

  it('projects the trigger card from the task, wiring summary + defaulted context + prompt through', () => {
    renderFallback();

    expect(screen.getByTestId('trigger-bubble')).toBeInTheDocument();
    // Wiring: the bubble gets the built summary (data), the DEFAULTED context, and the description.
    expect(bubbleProps.data.source).toBe('shortcut');
    expect(bubbleProps.triggerContext.source).toBe('shortcut');
    expect(bubbleProps.triggerContext.autoStart).toBe(false); // withTriggerContextDefaults applied
    expect(bubbleProps.fullPrompt).toBe(DESC);
  });

  it('yields to the real message once one is persisted (never double-renders the card)', () => {
    userMsgIds = ['msg-1'];
    renderFallback();

    expect(screen.queryByTestId('trigger-bubble')).toBeNull();
    expect(bubbleProps).toBeNull();
  });

  it('shows the card regardless of task status (gates on trigger presence, not failure)', () => {
    // A live pre-send run (task running, message not yet persisted) also gets the card — the same
    // card the persisted message would show — so there is no empty-body flash on a normal start.
    taskData = { triggerContext: TRIGGER_CTX, description: DESC, status: 'running' };
    renderFallback();

    expect(screen.getByTestId('trigger-bubble')).toBeInTheDocument();
  });

  it('renders nothing for a config-only context (a continuation / converging-merge idle branch)', () => {
    // {Config} with no source/eventType fails isValidTriggerContext — matching buildTaskPrompt,
    // which emits no bubble for continuation tasks.
    taskData = { triggerContext: { Config: {} }, description: 'continue', status: 'failed' };
    renderFallback();

    expect(screen.queryByTestId('trigger-bubble')).toBeNull();
  });

  it('honours a flow agent opting out of the trigger card (showTriggerCard false)', () => {
    taskData = {
      triggerContext: { ...TRIGGER_CTX, Config: { showTriggerCard: false } },
      description: DESC,
      status: 'failed',
    };
    renderFallback();

    expect(screen.queryByTestId('trigger-bubble')).toBeNull();
  });

  it('renders nothing when there is no actionable task', () => {
    taskData = null;
    renderFallback();

    expect(screen.queryByTestId('trigger-bubble')).toBeNull();
  });

  it('queries the SAME key TaskControls uses so the poll is shared, not forked', () => {
    // The dedup contract (decision flow-run-chat-surface): identical {subChatId, fallbackTaskId} →
    // one react-query cache entry → no second 5s poll.
    renderFallback('pinned-1');

    expect(capturedQueryInput).toEqual({ subChatId: 'sub-1', fallbackTaskId: 'pinned-1' });
  });
});
