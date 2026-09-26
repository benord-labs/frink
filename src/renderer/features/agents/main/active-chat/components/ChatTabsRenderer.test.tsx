// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import type { Chat } from '@ai-sdk/react';
import { cleanup, render, screen } from '@testing-library/react';
import type { UIMessage } from 'ai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SubChatMeta } from '../../../stores/sub-chat-store';
import type { UseSubChatMessagesResult } from '../hooks/useSubChatMessages';
import type { ChatViewInnerProps } from '../types';
import { ChatTabsRenderer } from './ChatTabsRenderer';

afterEach(cleanup);

const stubSubChatMessages: UseSubChatMessagesResult = {
  messages: [],
  isLoading: false,
  isFetching: false,
  isLoadingOlder: false,
  hasMore: false,
  loadOlder: async () => {},
  error: null,
  loadOlderError: null,
  refetch: () => {},
};

type RenderParams = {
  agentSubChats: SubChatMeta[];
  allSubChats: SubChatMeta[];
  getOrCreateChat?: (id: string) => Chat<UIMessage> | null;
  subChatMessages?: UseSubChatMessagesResult;
  projectPath?: string;
};

function renderTabsRenderer(params: RenderParams) {
  const ChatViewInnerStub = ({
    initialSubChatName,
    loadOlderMessages,
    hasOlderMessages,
    isLoadingOlderMessages,
    projectPath,
  }: ChatViewInnerProps) => (
    <div>
      <div data-testid="inner-title">{initialSubChatName ?? ''}</div>
      <div data-testid="inner-project-path">{projectPath ?? ''}</div>
      {hasOlderMessages && <div data-testid="has-older">true</div>}
      {isLoadingOlderMessages && <div data-testid="loading-older">true</div>}
      {loadOlderMessages && hasOlderMessages && (
        <button data-testid="load-older-btn" type="button" onClick={() => loadOlderMessages()}>
          Load older
        </button>
      )}
    </div>
  );

  return render(
    <ChatTabsRenderer
      subChatId="subchat-1"
      agentSubChats={params.agentSubChats}
      allSubChats={params.allSubChats}
      getOrCreateChat={params.getOrCreateChat ?? (() => ({ id: 'subchat-1' }) as Chat<UIMessage>)}
      subChatMessages={params.subChatMessages ?? stubSubChatMessages}
      chatId="chat-1"
      selectedTeamId={null}
      isMobileFullscreen={false}
      projectPath={params.projectPath}
      isArchived={false}
      isResolvedExecutionAccountReady
      handleRestoreWorkspace={vi.fn()}
      ChatViewInnerComponent={ChatViewInnerStub}
    />,
  );
}

const defaultSubChats: SubChatMeta[] = [{ id: 'subchat-1', name: 'Test Chat' }];

describe('ChatTabsRenderer', () => {
  it('prefers agentSubChats name over allSubChats fallback', () => {
    renderTabsRenderer({
      agentSubChats: [{ id: 'subchat-1', name: 'Latest Name' }],
      allSubChats: [{ id: 'subchat-1', name: 'Stale Name' }],
    });

    expect(screen.getByTestId('inner-title')).toHaveTextContent('Latest Name');
  });

  it('falls back to allSubChats name when agentSubChats is missing entry', () => {
    renderTabsRenderer({
      agentSubChats: [],
      allSubChats: [{ id: 'subchat-1', name: 'Fallback Name' }],
    });

    expect(screen.getByTestId('inner-title')).toHaveTextContent('Fallback Name');
  });

  it('renders the sub-chat even when allSubChats has not been hydrated yet', () => {
    // The caller already validates the sub-chat id against the sub-chat lists.
    // Re-checking here only turned a transient empty store into a pane with no content
    // and no loading state, so it must render purely on getOrCreateChat's result.
    renderTabsRenderer({
      agentSubChats: [{ id: 'subchat-1', name: 'Server Name' }],
      allSubChats: [],
    });

    expect(screen.getByTestId('inner-title')).toHaveTextContent('Server Name');
  });

  it('keeps the conversation layer from becoming a backdrop root, so frosted surfaces blur the transcript', () => {
    renderTabsRenderer({ agentSubChats: defaultSubChats, allSubChats: defaultSubChats });

    const layer = screen.getByTestId('inner-title').closest<HTMLElement>('[style]');
    expect(layer?.style.willChange).toBe('transform');
    expect(layer?.style.opacity).toBe('');
  });

  it('passes projectPath through to ChatViewInner', () => {
    renderTabsRenderer({
      agentSubChats: defaultSubChats,
      allSubChats: defaultSubChats,
      projectPath: '/tmp/owners-web',
    });

    expect(screen.getByTestId('inner-project-path')).toHaveTextContent('/tmp/owners-web');
  });

  describe('loading/error states when chat is null', () => {
    it('shows loading indicator when chat is null and messages are loading', () => {
      renderTabsRenderer({
        agentSubChats: defaultSubChats,
        allSubChats: defaultSubChats,
        getOrCreateChat: () => null,
        subChatMessages: { ...stubSubChatMessages, isLoading: true },
      });

      expect(screen.getByText('Loading messages…')).toBeInTheDocument();
    });

    it('shows error state with retry button when chat is null and fetch errored', () => {
      const refetchFn = vi.fn();
      renderTabsRenderer({
        agentSubChats: defaultSubChats,
        allSubChats: defaultSubChats,
        getOrCreateChat: () => null,
        subChatMessages: {
          ...stubSubChatMessages,
          error: new Error('Network failure'),
          refetch: refetchFn,
        },
      });

      expect(screen.getByText('Failed to load messages.')).toBeInTheDocument();
      screen.getByText('Retry').click();
      expect(refetchFn).toHaveBeenCalledOnce();
    });

    it('renders nothing when chat is null and not loading/errored', () => {
      const { container } = renderTabsRenderer({
        agentSubChats: defaultSubChats,
        allSubChats: defaultSubChats,
        getOrCreateChat: () => null,
      });

      expect(screen.queryByText('Loading messages…')).not.toBeInTheDocument();
      expect(screen.queryByText('Failed to load messages.')).not.toBeInTheDocument();
      expect(container.querySelector('[data-testid="inner-title"]')).not.toBeInTheDocument();
    });
  });

  describe('load-older pass-through to ChatViewInner', () => {
    it('passes loadOlder/hasMore/isLoadingOlder to the conversation', () => {
      renderTabsRenderer({
        agentSubChats: defaultSubChats,
        allSubChats: defaultSubChats,
        subChatMessages: {
          ...stubSubChatMessages,
          hasMore: true,
          isLoadingOlder: true,
        },
      });

      expect(screen.getByTestId('has-older')).toBeInTheDocument();
      expect(screen.getByTestId('loading-older')).toBeInTheDocument();
      expect(screen.getByTestId('load-older-btn')).toBeInTheDocument();
    });

    it('does not pass loadOlder when hasMore is false', () => {
      renderTabsRenderer({
        agentSubChats: defaultSubChats,
        allSubChats: defaultSubChats,
        subChatMessages: { ...stubSubChatMessages, hasMore: false },
      });

      expect(screen.queryByTestId('has-older')).not.toBeInTheDocument();
      expect(screen.queryByTestId('load-older-btn')).not.toBeInTheDocument();
    });
  });
});
