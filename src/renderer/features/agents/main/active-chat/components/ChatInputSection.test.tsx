// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createStore, Provider } from 'jotai';
import type { ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chatContextFileAtomFamily } from '@/lib/code-editor/state';
import { pendingTerminalOutputAtomFamily } from '@/lib/terminal/pending-output';
import { ChatInputSection } from './ChatInputSection';

vi.mock('../../chat-input-area', () => ({
  ChatInputArea: ({ activeFilePath }: { activeFilePath?: string | null }) => (
    <div data-testid="chat-input-area" data-active-file-path={activeFilePath ?? 'none'} />
  ),
}));

vi.mock('../../../components/no-accounts-empty-state', () => ({
  NoAccountsEmptyState: ({
    compact,
    existingAccount,
  }: {
    compact?: boolean;
    existingAccount?: { label: string; type: string } | null;
  }) => (
    <div
      data-testid="no-accounts-empty-state"
      data-compact={String(Boolean(compact))}
      data-existing-account={existingAccount ? existingAccount.label : 'none'}
      data-existing-account-type={existingAccount ? existingAccount.type : 'none'}
    />
  ),
}));

afterEach(cleanup);

function createProps(): ComponentProps<typeof ChatInputSection> {
  return {
    editorRef: { current: null },
    fileInputRef: { current: null },
    onSend: vi.fn(),
    onForceSend: vi.fn(),
    onStop: vi.fn(async () => undefined),
    onCompact: vi.fn(),
    isStreaming: false,
    isCompacting: false,
    images: [],
    files: [],
    onAddAttachments: vi.fn(),
    onRemoveImage: vi.fn(),
    onRemoveFile: vi.fn(),
    isUploading: false,
    textContexts: [],
    onRemoveTextContext: vi.fn(),
    diffTextContexts: [],
    onRemoveDiffTextContext: vi.fn(),
    codeSelectionContext: null,
    onClearCodeSelection: vi.fn(),
    activeFileName: null,
    activeFileDismissed: false,
    onDismissActiveFile: vi.fn(),
    pastedTexts: [],
    onAddPastedText: vi.fn(async () => undefined),
    onRemovePastedText: vi.fn(),
    messageTokenData: { contextTokens: 0, contextWindow: null, promptCacheExpiresAt: null },
    subChatId: 'sub-chat-1',
    parentChatId: 'chat-1',
    teamId: undefined,
    repository: undefined,
    projectPath: '/tmp/project',
    changedFiles: [],
    isMobile: false,
    queueLength: 0,
    onSendFromQueue: vi.fn(),
    firstQueueItemId: undefined,
    onInputContentChange: vi.fn(),
    isResolvedExecutionAccountReady: true,
  };
}

describe('ChatInputSection', () => {
  it("takes its chat's terminal output as a chip", () => {
    const store = createStore();
    store.set(pendingTerminalOutputAtomFamily('chat-1'), {
      text: 'FAIL',
      label: 'Terminal 1 output',
    });
    const props = createProps();

    render(
      <Provider store={store}>
        <ChatInputSection {...props} />
      </Provider>,
    );

    expect(props.onAddPastedText).toHaveBeenCalledWith('FAIL', {
      label: 'Terminal 1 output',
      filename: expect.stringMatching(/^terminal_\d+\.txt$/),
    });
  });

  it('renders the input area', () => {
    const props = createProps();

    render(<ChatInputSection {...props} />);

    expect(screen.getByTestId('chat-input-area')).toBeInTheDocument();
  });

  it.each([
    { state: 'ready', ready: true, loading: false },
    { state: 'account loading', ready: false, loading: true },
  ])("gives the composer its chat's open-file path when the account is $state", (c) => {
    const store = createStore();
    store.set(chatContextFileAtomFamily('other-chat'), { name: 'b.ts', path: '/repo/b.ts' });
    store.set(chatContextFileAtomFamily('chat-1'), {
      name: 'index.ts',
      path: '/repo/src/a/index.ts',
    });
    const props = createProps();
    props.isResolvedExecutionAccountReady = c.ready;
    props.isLoadingResolvedAccount = c.loading;

    render(
      <Provider store={store}>
        <ChatInputSection {...props} />
      </Provider>,
    );

    expect(screen.getByTestId('chat-input-area')).toHaveAttribute(
      'data-active-file-path',
      '/repo/src/a/index.ts',
    );
  });

  it('does not render chat retry controls in input section', () => {
    const props = createProps();

    render(<ChatInputSection {...props} />);

    expect(screen.queryByRole('button', { name: 'Retry chat send' })).toBeNull();
  });

  it('renders NoAccountsEmptyState (compact) instead of ChatInputArea when account is not ready', () => {
    const props = createProps();
    props.isResolvedExecutionAccountReady = false;

    render(<ChatInputSection {...props} />);

    expect(screen.getByTestId('no-accounts-empty-state')).toBeInTheDocument();
    expect(screen.getByTestId('no-accounts-empty-state')).toHaveAttribute('data-compact', 'true');
    expect(screen.queryByTestId('chat-input-area')).not.toBeInTheDocument();
  });

  it('renders ChatInputArea while getResolvedAccount is loading (avoids login empty-state flash)', () => {
    const props = createProps();
    props.isResolvedExecutionAccountReady = false;
    props.isLoadingResolvedAccount = true;

    render(<ChatInputSection {...props} />);

    expect(screen.getByTestId('chat-input-area')).toBeInTheDocument();
    expect(screen.queryByTestId('no-accounts-empty-state')).not.toBeInTheDocument();
  });

  it('renders resolved-account error state (not no-account) when query failed and not loading', () => {
    const props = createProps();
    props.isResolvedExecutionAccountReady = false;
    props.isLoadingResolvedAccount = false;
    props.isErrorResolvedAccount = true;
    props.onRetryResolvedAccount = vi.fn();

    render(<ChatInputSection {...props} />);

    expect(screen.getByTestId('resolved-account-error-state')).toBeInTheDocument();
    expect(screen.queryByTestId('no-accounts-empty-state')).not.toBeInTheDocument();
    expect(screen.queryByTestId('chat-input-area')).not.toBeInTheDocument();
  });

  it('error card spans the composer column, so no transcript line runs sharp beside it', () => {
    const props = createProps();
    props.isResolvedExecutionAccountReady = false;
    props.isErrorResolvedAccount = true;

    render(<ChatInputSection {...props} />);

    expect(screen.getByTestId('resolved-account-error-state').className).not.toMatch(/\bmax-w-/);
  });

  it('error card is a slot surface, so a stacked card on it squares its top', () => {
    const props = createProps();
    props.isResolvedExecutionAccountReady = false;
    props.isErrorResolvedAccount = true;

    render(<ChatInputSection {...props} />);

    expect(screen.getByTestId('resolved-account-error-state')).toHaveClass('composer-slot-surface');
  });

  it('calls onRetryResolvedAccount when Retry is clicked on error state', () => {
    const onRetry = vi.fn();
    const props = createProps();
    props.isResolvedExecutionAccountReady = false;
    props.isErrorResolvedAccount = true;
    props.onRetryResolvedAccount = onRetry;

    render(<ChatInputSection {...props} />);

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('prefers loading branch over error when both could apply', () => {
    const props = createProps();
    props.isResolvedExecutionAccountReady = false;
    props.isLoadingResolvedAccount = true;
    props.isErrorResolvedAccount = true;

    render(<ChatInputSection {...props} />);

    expect(screen.getByTestId('chat-input-area')).toBeInTheDocument();
    expect(screen.queryByTestId('resolved-account-error-state')).not.toBeInTheDocument();
  });

  it('passes unauthAccount label to NoAccountsEmptyState when account exists but is unauthenticated', () => {
    const props = createProps();
    props.isResolvedExecutionAccountReady = false;
    props.unauthAccount = { label: 'benji@example.com', type: 'claude-code' };

    render(<ChatInputSection {...props} />);

    expect(screen.getByTestId('no-accounts-empty-state')).toHaveAttribute(
      'data-existing-account',
      'benji@example.com',
    );
  });

  it('renders ChatInputArea (not empty state) when account is ready', () => {
    const props = createProps();
    props.isResolvedExecutionAccountReady = true;

    render(<ChatInputSection {...props} />);

    expect(screen.getByTestId('chat-input-area')).toBeInTheDocument();
    expect(screen.queryByTestId('no-accounts-empty-state')).not.toBeInTheDocument();
  });

  it('composer reappears when isResolvedExecutionAccountReady flips from false to true', () => {
    const props = createProps();
    props.isResolvedExecutionAccountReady = false;

    const { rerender } = render(<ChatInputSection {...props} />);

    expect(screen.getByTestId('no-accounts-empty-state')).toBeInTheDocument();
    expect(screen.queryByTestId('chat-input-area')).not.toBeInTheDocument();

    rerender(<ChatInputSection {...props} isResolvedExecutionAccountReady={true} />);

    expect(screen.getByTestId('chat-input-area')).toBeInTheDocument();
    expect(screen.queryByTestId('no-accounts-empty-state')).not.toBeInTheDocument();
  });

  it('passes existingAccount=null to NoAccountsEmptyState when no account is configured (null unauthAccount)', () => {
    const props = createProps();
    props.isResolvedExecutionAccountReady = false;
    // unauthAccount defaults to null — means no account at all, not just unauthenticated

    render(<ChatInputSection {...props} />);

    expect(screen.getByTestId('no-accounts-empty-state')).toHaveAttribute(
      'data-existing-account',
      'none',
    );
  });

  it('passes the account type through to NoAccountsEmptyState for its provider CTA', () => {
    const props = createProps();
    props.isResolvedExecutionAccountReady = false;
    props.unauthAccount = { label: 'work-codex', type: 'codex' };

    render(<ChatInputSection {...props} />);

    expect(screen.getByTestId('no-accounts-empty-state')).toHaveAttribute(
      'data-existing-account-type',
      'codex',
    );
  });
});
