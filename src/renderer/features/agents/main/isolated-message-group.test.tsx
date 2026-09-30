// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ComponentType } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRIGGER_BUBBLE_MARKER } from '../../../../shared/lib/trigger-bubble-marker';
import { PLAN_APPROVAL_EXECUTION_TRIGGER_TEXT } from '../../../../shared/types/plan';
import { TooltipProvider } from '../../../components/ui/tooltip';
import { COMPACTING_PENDING } from '../../../lib/agent-chat/planning/planning-status-message';
import { type IsolatedChatToolRegistry, IsolatedMessageGroup } from './isolated-message-group';

const atomValues = new Map<string, unknown>();

vi.mock('jotai', () => ({
  useAtomValue: (atom: string) => atomValues.get(atom),
  atom: () => 'inert-atom',
  createStore: () => ({ get: () => new Set<string>(), set: () => {} }),
}));

vi.mock('../atoms', () => ({
  showMessageJsonAtom: 'show-message-json',
  compactingForSubChatAtomFamily: (subChatId: string) => `compacting:${subChatId}`,
  compactingSubChatsAtom: Symbol('compactingSubChatsAtom'),
}));

vi.mock('../stores/message-store', () => ({
  messageAtomFamily: (messageId: string) => `message:${messageId}`,
  assistantIdsForSubChatMsgAtomFamily: (key: string) => `assistant-ids:${key}`,
  isLastUserMessageForSubChatAtomFamily: (key: string) => `is-last-user:${key}`,
  isFirstUserMessageForSubChatAtomFamily: (key: string) => `is-first-user:${key}`,
  isStreamingForSubChatAtomFamily: (subChatId: string) => `is-streaming:${subChatId}`,
  chatHasGitContextAtomFamily: (subChatId: string) => `has-git-context:${subChatId}`,
  flowRunIncompleteAtomFamily: (subChatId: string) => `flow-run-incomplete:${subChatId}`,
  isRollingBackAtom: 'is-rolling-back',
  rollbackHandlerAtom: 'rollback-handler',
  ORPHAN_ANCHOR_PREFIX: '__orphan_anchor__',
}));

vi.mock('../mentions/render-file-mentions', () => ({
  extractTextMentions: (text: string) => ({ textMentions: [], cleanedText: text }),
  TextMentionBlocks: () => null,
}));

vi.mock('./messages-list', () => ({
  MemoizedAssistantMessages: ({ assistantMsgIds }: { assistantMsgIds: string[] }) => (
    <div data-testid="assistant-messages">{assistantMsgIds.join(',')}</div>
  ),
}));

vi.mock('./active-chat/components/RetryActionButton', () => ({
  RetryActionButton: ({
    label,
    ariaLabel,
    disabled,
    ariaBusy,
    onClick,
  }: {
    label?: string;
    ariaLabel: string;
    disabled?: boolean;
    ariaBusy?: boolean;
    onClick?: () => void;
  }) => (
    <button
      type="button"
      aria-label={ariaLabel}
      aria-busy={ariaBusy || undefined}
      disabled={disabled}
      onClick={onClick}
    >
      {label ?? 'Retry'}
    </button>
  ),
}));

vi.mock('../ui/account-indicator', () => ({
  ContinueAfterUsageLimit: ({ chatId, subChatId }: { chatId: string; subChatId: string }) => (
    <span data-testid="continue-after-usage-limit">{`${chatId}/${subChatId}`}</span>
  ),
}));

vi.mock('../ui/message-json-display', () => ({
  MessageJsonDisplay: () => null,
}));

vi.mock('../../../lib/utils', () => ({
  cn: (...classes: Array<string | false | null | undefined>) => classes.filter(Boolean).join(' '),
}));

const UserBubbleComponent = ({
  textContent,
  endGutter,
}: {
  textContent: string;
  endGutter?: boolean;
}) => (
  <div data-testid="user-bubble" data-end-gutter={endGutter || undefined}>
    {textContent}
  </div>
);

const StubPlanningIcon: ComponentType<{ className?: string }> = () => null;

/** Minimal registry: isolated chat requires tool-planning. */
const toolRegistryWithPlanning = {
  'tool-planning': {
    icon: StubPlanningIcon,
    title: () => 'Planning...',
  },
};

function renderGroup(messageText: string) {
  cleanup();
  atomValues.clear();
  atomValues.set('show-message-json', false);
  atomValues.set('message:user-1', {
    id: 'user-1',
    role: 'user',
    parts: [{ type: 'text', text: messageText }],
  });
  atomValues.set('assistant-ids:sub-1:user-1', []);
  atomValues.set('is-last-user:sub-1:user-1', true);
  atomValues.set('is-streaming:sub-1', false);

  render(
    <IsolatedMessageGroup
      userMsgId="user-1"
      subChatId="sub-1"
      chatId="chat-1"
      taskId={null}
      isMobile={false}
      sandboxSetupStatus="ready"
      stickyTopClass=""
      UserBubbleComponent={UserBubbleComponent}
      ToolCallComponent={() => null}
      MessageGroupWrapper={({ children }) => <>{children}</>}
      toolRegistry={toolRegistryWithPlanning}
      showChatRetryControl={false}
      retryInFlight={false}
      onRetryChat={() => {}}
      onCarryOnChat={() => {}}
      chatRetryTooltipText={null}
    />,
  );
}

describe('IsolatedMessageGroup plan-approval masking', () => {
  beforeEach(() => {
    atomValues.clear();
  });

  it('shows a Plan accepted card for the new plan-approval trigger text', () => {
    renderGroup(PLAN_APPROVAL_EXECUTION_TRIGGER_TEXT);
    expect(screen.getByText('Plan accepted')).toBeInTheDocument();
    expect(screen.queryByText(PLAN_APPROVAL_EXECUTION_TRIGGER_TEXT)).not.toBeInTheDocument();
  });

  it('keeps normal user messages visible as-is', () => {
    renderGroup('Please continue implementation');
    expect(screen.getByText('Please continue implementation')).toBeInTheDocument();
    expect(screen.queryByText('Plan accepted')).not.toBeInTheDocument();
  });

  it('does not mask legacy Build plan text', () => {
    renderGroup('Build plan');
    expect(screen.getByText('Build plan')).toBeInTheDocument();
    expect(screen.queryByText('Plan accepted')).not.toBeInTheDocument();
  });
});

describe('IsolatedMessageGroup orphan anchor rendering', () => {
  beforeEach(() => {
    cleanup();
    atomValues.clear();
  });

  it('renders assistant messages without user bubble for orphan anchor', () => {
    const orphanId = '__orphan_anchor__sub-1';
    atomValues.set('show-message-json', false);
    atomValues.set(`message:${orphanId}`, undefined);
    atomValues.set(`assistant-ids:sub-1:${orphanId}`, ['asst-1', 'asst-2']);
    atomValues.set(`is-last-user:sub-1:${orphanId}`, true);
    atomValues.set('is-streaming:sub-1', false);

    render(
      <IsolatedMessageGroup
        userMsgId={orphanId}
        subChatId="sub-1"
        chatId="chat-1"
        taskId={null}
        isMobile={false}
        sandboxSetupStatus="ready"
        stickyTopClass=""
        UserBubbleComponent={UserBubbleComponent}
        ToolCallComponent={() => null}
        MessageGroupWrapper={({ children }) => <>{children}</>}
        toolRegistry={toolRegistryWithPlanning}
        showChatRetryControl={false}
        retryInFlight={false}
        onRetryChat={() => {}}
        onCarryOnChat={() => {}}
        chatRetryTooltipText={null}
      />,
    );

    expect(screen.getByTestId('assistant-messages')).toBeInTheDocument();
    expect(screen.getByText('asst-1,asst-2')).toBeInTheDocument();
    expect(screen.queryByTestId('user-bubble')).not.toBeInTheDocument();
  });

  it('shows retry affordance for orphan anchor with no assistants when chat retry is enabled', () => {
    const orphanId = '__orphan_anchor__sub-1';
    atomValues.set('show-message-json', false);
    atomValues.set(`message:${orphanId}`, undefined);
    atomValues.set(`assistant-ids:sub-1:${orphanId}`, []);
    atomValues.set(`is-last-user:sub-1:${orphanId}`, true);
    atomValues.set('is-streaming:sub-1', false);

    render(
      <TooltipProvider>
        <IsolatedMessageGroup
          userMsgId={orphanId}
          subChatId="sub-1"
          chatId="chat-1"
          taskId={null}
          isMobile={false}
          sandboxSetupStatus="ready"
          stickyTopClass=""
          UserBubbleComponent={UserBubbleComponent}
          ToolCallComponent={() => null}
          MessageGroupWrapper={({ children }) => <>{children}</>}
          toolRegistry={toolRegistryWithPlanning}
          showChatRetryControl={true}
          retryInFlight={false}
          onRetryChat={() => {}}
          onCarryOnChat={() => {}}
          chatRetryTooltipText={null}
        />
      </TooltipProvider>,
    );

    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('renders Carry on beside Retry and wires its handler (recovery must never be retry-only)', () => {
    const orphanId = '__orphan_anchor__sub-1';
    atomValues.set('show-message-json', false);
    atomValues.set(`message:${orphanId}`, undefined);
    atomValues.set(`assistant-ids:sub-1:${orphanId}`, []);
    atomValues.set(`is-last-user:sub-1:${orphanId}`, true);
    atomValues.set('is-streaming:sub-1', false);
    const onCarryOn = vi.fn();

    render(
      <TooltipProvider>
        <IsolatedMessageGroup
          userMsgId={orphanId}
          subChatId="sub-1"
          chatId="chat-1"
          taskId={null}
          isMobile={false}
          sandboxSetupStatus="ready"
          stickyTopClass=""
          UserBubbleComponent={UserBubbleComponent}
          ToolCallComponent={() => null}
          MessageGroupWrapper={({ children }) => <>{children}</>}
          toolRegistry={toolRegistryWithPlanning}
          showChatRetryControl={true}
          retryInFlight={false}
          onRetryChat={() => {}}
          onCarryOnChat={onCarryOn}
          chatRetryTooltipText={null}
        />
      </TooltipProvider>,
    );

    const carryOn = screen.getByRole('button', { name: /carry on/i });
    fireEvent.click(carryOn);
    expect(onCarryOn).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('continue-after-usage-limit')).toHaveTextContent('chat-1/sub-1');
  });

  it('omits Carry on when there is no session to resume, leaving Retry alone', () => {
    const orphanId = '__orphan_anchor__sub-1';
    atomValues.set('show-message-json', false);
    atomValues.set(`message:${orphanId}`, undefined);
    atomValues.set(`assistant-ids:sub-1:${orphanId}`, []);
    atomValues.set(`is-last-user:sub-1:${orphanId}`, true);
    atomValues.set('is-streaming:sub-1', false);

    render(
      <TooltipProvider>
        <IsolatedMessageGroup
          userMsgId={orphanId}
          subChatId="sub-1"
          chatId="chat-1"
          taskId={null}
          isMobile={false}
          sandboxSetupStatus="ready"
          stickyTopClass=""
          UserBubbleComponent={UserBubbleComponent}
          ToolCallComponent={() => null}
          MessageGroupWrapper={({ children }) => <>{children}</>}
          toolRegistry={toolRegistryWithPlanning}
          showChatRetryControl={true}
          retryInFlight={false}
          onRetryChat={() => {}}
          onCarryOnChat={null}
          chatRetryTooltipText={null}
        />
      </TooltipProvider>,
    );

    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /carry on/i })).not.toBeInTheDocument();
  });

  it('shows retry as in-flight with Retrying label and disabled when retryInFlight is true', () => {
    const orphanId = '__orphan_anchor__sub-1';
    atomValues.set('show-message-json', false);
    atomValues.set(`message:${orphanId}`, undefined);
    atomValues.set(`assistant-ids:sub-1:${orphanId}`, []);
    atomValues.set(`is-last-user:sub-1:${orphanId}`, true);
    atomValues.set('is-streaming:sub-1', false);

    render(
      <TooltipProvider>
        <IsolatedMessageGroup
          userMsgId={orphanId}
          subChatId="sub-1"
          chatId="chat-1"
          taskId={null}
          isMobile={false}
          sandboxSetupStatus="ready"
          stickyTopClass=""
          UserBubbleComponent={UserBubbleComponent}
          ToolCallComponent={() => null}
          MessageGroupWrapper={({ children }) => <>{children}</>}
          toolRegistry={toolRegistryWithPlanning}
          showChatRetryControl={true}
          retryInFlight={true}
          onRetryChat={() => {}}
          onCarryOnChat={() => {}}
          chatRetryTooltipText={null}
        />
      </TooltipProvider>,
    );

    const btn = screen.getByRole('button', { name: 'Retrying chat send' });
    expect(btn).toHaveTextContent('Retrying...');
    expect(btn).toHaveAttribute('aria-busy', 'true');
    expect(btn).toBeDisabled();
  });

  it('returns null for orphan anchor with no assistant messages', () => {
    const orphanId = '__orphan_anchor__sub-1';
    atomValues.set('show-message-json', false);
    atomValues.set(`message:${orphanId}`, undefined);
    atomValues.set(`assistant-ids:sub-1:${orphanId}`, []);
    atomValues.set(`is-last-user:sub-1:${orphanId}`, true);
    atomValues.set('is-streaming:sub-1', false);

    const { container } = render(
      <IsolatedMessageGroup
        userMsgId={orphanId}
        subChatId="sub-1"
        chatId="chat-1"
        taskId={null}
        isMobile={false}
        sandboxSetupStatus="ready"
        stickyTopClass=""
        UserBubbleComponent={UserBubbleComponent}
        ToolCallComponent={() => null}
        MessageGroupWrapper={({ children }) => <>{children}</>}
        toolRegistry={toolRegistryWithPlanning}
        showChatRetryControl={false}
        retryInFlight={false}
        onRetryChat={() => {}}
        onCarryOnChat={() => {}}
        chatRetryTooltipText={null}
      />,
    );

    expect(container.innerHTML).toBe('');
  });

  it('shows planning indicator for orphan anchor when streaming and no assistant rows yet', () => {
    const orphanId = '__orphan_anchor__sub-1';
    atomValues.set('show-message-json', false);
    atomValues.set(`message:${orphanId}`, undefined);
    atomValues.set(`assistant-ids:sub-1:${orphanId}`, []);
    atomValues.set(`is-last-user:sub-1:${orphanId}`, true);
    atomValues.set('is-streaming:sub-1', true);

    const PlanningStub: ComponentType<{
      icon: ComponentType<{ className?: string }>;
      title: string;
      isPending: boolean;
      isError: boolean;
    }> = (props) => <div data-testid="planning-indicator">{props.title}</div>;

    render(
      <IsolatedMessageGroup
        userMsgId={orphanId}
        subChatId="sub-1"
        chatId="chat-1"
        taskId={null}
        isMobile={false}
        sandboxSetupStatus="ready"
        stickyTopClass=""
        UserBubbleComponent={UserBubbleComponent}
        ToolCallComponent={PlanningStub}
        MessageGroupWrapper={({ children }) => <>{children}</>}
        toolRegistry={toolRegistryWithPlanning}
        showChatRetryControl={false}
        retryInFlight={false}
        onRetryChat={() => {}}
        onCarryOnChat={() => {}}
        chatRetryTooltipText={null}
      />,
    );

    expect(screen.getByTestId('planning-indicator')).toHaveTextContent('Planning...');
  });

  it('names compaction on the pending card instead of showing a planning phrase', () => {
    const orphanId = '__orphan_anchor__sub-1';
    atomValues.set('show-message-json', false);
    atomValues.set(`message:${orphanId}`, undefined);
    atomValues.set(`assistant-ids:sub-1:${orphanId}`, []);
    atomValues.set(`is-last-user:sub-1:${orphanId}`, true);
    atomValues.set('is-streaming:sub-1', true);
    atomValues.set('compacting:sub-1', true);

    let receivedIcon: ComponentType<{ className?: string }> | null = null;
    const ToolCapture: ComponentType<{
      icon: ComponentType<{ className?: string }>;
      title: string;
      isPending: boolean;
      isError: boolean;
    }> = (props) => {
      receivedIcon = props.icon;
      return <div data-testid="planning-indicator">{props.title}</div>;
    };

    render(
      <IsolatedMessageGroup
        userMsgId={orphanId}
        subChatId="sub-1"
        chatId="chat-1"
        taskId={null}
        isMobile={false}
        sandboxSetupStatus="ready"
        stickyTopClass=""
        UserBubbleComponent={UserBubbleComponent}
        ToolCallComponent={ToolCapture}
        MessageGroupWrapper={({ children }) => <>{children}</>}
        toolRegistry={toolRegistryWithPlanning}
        showChatRetryControl={false}
        retryInFlight={false}
        onRetryChat={() => {}}
        onCarryOnChat={() => {}}
        chatRetryTooltipText={null}
      />,
    );

    expect(screen.getByTestId('planning-indicator')).toHaveTextContent(COMPACTING_PENDING.title);
    expect(receivedIcon).toBe(COMPACTING_PENDING.icon);
  });

  it('passes tool-planning icon from registry to ToolCallComponent', () => {
    const orphanId = '__orphan_anchor__sub-1';
    atomValues.set('show-message-json', false);
    atomValues.set(`message:${orphanId}`, undefined);
    atomValues.set(`assistant-ids:sub-1:${orphanId}`, []);
    atomValues.set(`is-last-user:sub-1:${orphanId}`, true);
    atomValues.set('is-streaming:sub-1', true);

    const CustomIcon: ComponentType<{ className?: string }> = () => (
      <span data-testid="custom-planning-icon" />
    );

    let receivedIcon: ComponentType<{ className?: string }> | null = null;
    const ToolCapture: ComponentType<{
      icon: ComponentType<{ className?: string }>;
      title: string;
      isPending: boolean;
      isError: boolean;
    }> = (props) => {
      receivedIcon = props.icon;
      return <div data-testid="planning-row">{props.title}</div>;
    };

    render(
      <IsolatedMessageGroup
        userMsgId={orphanId}
        subChatId="sub-1"
        chatId="chat-1"
        taskId={null}
        isMobile={false}
        sandboxSetupStatus="ready"
        stickyTopClass=""
        UserBubbleComponent={UserBubbleComponent}
        ToolCallComponent={ToolCapture}
        MessageGroupWrapper={({ children }) => <>{children}</>}
        toolRegistry={{
          'tool-planning': {
            icon: CustomIcon,
            title: () => 'From registry',
          },
        }}
        showChatRetryControl={false}
        retryInFlight={false}
        onRetryChat={() => {}}
        onCarryOnChat={() => {}}
        chatRetryTooltipText={null}
      />,
    );

    expect(screen.getByTestId('planning-row')).toHaveTextContent('From registry');
    expect(receivedIcon).toBe(CustomIcon);
  });

  it('throws when tool-planning is missing from registry while streaming planning (orphan anchor)', () => {
    const orphanId = '__orphan_anchor__sub-1';
    atomValues.set('show-message-json', false);
    atomValues.set(`message:${orphanId}`, undefined);
    atomValues.set(`assistant-ids:sub-1:${orphanId}`, []);
    atomValues.set(`is-last-user:sub-1:${orphanId}`, true);
    atomValues.set('is-streaming:sub-1', true);

    expect(() =>
      render(
        <IsolatedMessageGroup
          userMsgId={orphanId}
          subChatId="sub-1"
          chatId="chat-1"
          taskId={null}
          isMobile={false}
          sandboxSetupStatus="ready"
          stickyTopClass=""
          UserBubbleComponent={UserBubbleComponent}
          ToolCallComponent={() => <div data-testid="tc" />}
          MessageGroupWrapper={({ children }) => <>{children}</>}
          toolRegistry={{} as unknown as IsolatedChatToolRegistry}
          showChatRetryControl={false}
          retryInFlight={false}
          onRetryChat={() => {}}
          onCarryOnChat={() => {}}
          chatRetryTooltipText={null}
        />,
      ),
    ).toThrow('tool-planning entry is required in toolRegistry when streaming');
  });
});

describe('IsolatedMessageGroup tool-planning registry', () => {
  const emptyRegistry = {} as unknown as IsolatedChatToolRegistry;

  beforeEach(() => {
    cleanup();
    atomValues.clear();
  });

  it('does not throw when tool-planning is missing while not streaming (last group, no assistants)', () => {
    atomValues.set('show-message-json', false);
    atomValues.set('message:user-1', {
      id: 'user-1',
      role: 'user',
      parts: [{ type: 'text', text: 'Hello' }],
    });
    atomValues.set('assistant-ids:sub-1:user-1', []);
    atomValues.set('is-last-user:sub-1:user-1', true);
    atomValues.set('is-streaming:sub-1', false);

    expect(() =>
      render(
        <IsolatedMessageGroup
          userMsgId="user-1"
          subChatId="sub-1"
          chatId="chat-1"
          taskId={null}
          isMobile={false}
          sandboxSetupStatus="ready"
          stickyTopClass=""
          UserBubbleComponent={UserBubbleComponent}
          ToolCallComponent={() => null}
          MessageGroupWrapper={({ children }) => <>{children}</>}
          toolRegistry={emptyRegistry}
          showChatRetryControl={false}
          retryInFlight={false}
          onRetryChat={() => {}}
          onCarryOnChat={() => {}}
          chatRetryTooltipText={null}
        />,
      ),
    ).not.toThrow();

    expect(screen.getByTestId('user-bubble')).toHaveTextContent('Hello');
  });

  it('does not throw when tool-planning is missing while streaming on a non-last group', () => {
    atomValues.set('show-message-json', false);
    atomValues.set('message:user-1', {
      id: 'user-1',
      role: 'user',
      parts: [{ type: 'text', text: 'Earlier turn' }],
    });
    atomValues.set('assistant-ids:sub-1:user-1', []);
    atomValues.set('is-last-user:sub-1:user-1', false);
    atomValues.set('is-streaming:sub-1', true);

    expect(() =>
      render(
        <IsolatedMessageGroup
          userMsgId="user-1"
          subChatId="sub-1"
          chatId="chat-1"
          taskId={null}
          isMobile={false}
          sandboxSetupStatus="ready"
          stickyTopClass=""
          UserBubbleComponent={UserBubbleComponent}
          ToolCallComponent={() => null}
          MessageGroupWrapper={({ children }) => <>{children}</>}
          toolRegistry={emptyRegistry}
          showChatRetryControl={false}
          retryInFlight={false}
          onRetryChat={() => {}}
          onCarryOnChat={() => {}}
          chatRetryTooltipText={null}
        />,
      ),
    ).not.toThrow();

    expect(screen.getByTestId('user-bubble')).toHaveTextContent('Earlier turn');
  });
});

describe('IsolatedMessageGroup rollback affordance', () => {
  beforeEach(() => {
    cleanup();
    atomValues.clear();
  });

  function renderForRollback(messageText: string) {
    atomValues.set('show-message-json', false);
    atomValues.set('message:user-1', {
      id: 'user-1',
      role: 'user',
      parts: [{ type: 'text', text: messageText }],
    });
    atomValues.set('assistant-ids:sub-1:user-1', ['asst-1']);
    atomValues.set('is-last-user:sub-1:user-1', false);
    atomValues.set('is-first-user:sub-1:user-1', false);
    atomValues.set('is-streaming:sub-1', false);
    atomValues.set('has-git-context:sub-1', true);
    atomValues.set('is-rolling-back', false);
    atomValues.set('rollback-handler', vi.fn());

    render(
      <IsolatedMessageGroup
        userMsgId="user-1"
        subChatId="sub-1"
        chatId="chat-1"
        taskId={null}
        isMobile={false}
        sandboxSetupStatus="ready"
        stickyTopClass=""
        UserBubbleComponent={UserBubbleComponent}
        ToolCallComponent={() => null}
        MessageGroupWrapper={({ children }) => <>{children}</>}
        toolRegistry={toolRegistryWithPlanning}
        showChatRetryControl={false}
        retryInFlight={false}
        onRetryChat={() => {}}
        onCarryOnChat={() => {}}
        chatRetryTooltipText={null}
      />,
    );
  }

  it('shows the revert affordance on a normal user message', () => {
    renderForRollback('Please continue implementation');
    expect(screen.getByLabelText('Revert to this message')).toBeInTheDocument();
  });

  it('hides the revert affordance on a trigger-origin message (immutable)', () => {
    renderForRollback(`${TRIGGER_BUBBLE_MARKER}{"uiData":{}}-->\n\nDo the thing`);
    expect(screen.queryByLabelText('Revert to this message')).not.toBeInTheDocument();
    expect(screen.getByTestId('user-bubble')).not.toHaveAttribute('data-end-gutter');
  });

  it('reserves the bubble gutter the revert icon sits in, so text never runs under it', () => {
    renderForRollback('Please continue implementation');
    expect(screen.getByTestId('user-bubble')).toHaveAttribute('data-end-gutter');
  });

  it('reserves the gutter on the Plan accepted card when it carries the revert icon', () => {
    renderForRollback(PLAN_APPROVAL_EXECUTION_TRIGGER_TEXT);
    expect(screen.getByLabelText('Revert to this message')).toBeInTheDocument();
    expect(screen.getByText('Plan accepted')).toHaveClass('pr-10');
  });

  it('keeps the revert affordance on a task-bubble message (user-authored, revertible)', () => {
    renderForRollback('<!--TASK:{"title":"x"}-->\n\nDo the thing');
    expect(screen.getByLabelText('Revert to this message')).toBeInTheDocument();
  });

  it('hides the revert affordance while the chat’s flow run is not yet completed (incl. failed/cancelled)', () => {
    atomValues.set('flow-run-incomplete:sub-1', true);
    renderForRollback('Please continue implementation');
    expect(screen.queryByLabelText('Revert to this message')).not.toBeInTheDocument();
  });
});
