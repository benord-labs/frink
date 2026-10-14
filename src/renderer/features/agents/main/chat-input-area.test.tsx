// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { observable } from '@trpc/server/observable';
import { Provider } from 'jotai';
import type { ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '../../../components/ui/tooltip';
import { CODEX_DEFAULT_MODEL_ID } from '../../../../shared/lib/codex-cli-models';
import { writeComposerCache } from '../../../lib/atoms/atom-family-factory';
import { appStore } from '../../../lib/jotai-store';
import { renderWithTrpc } from '../../../lib/test-utils/render-with-trpc';
import { trpc } from '../../../lib/trpc';
import { chatModeAtomFamily, lastSelectedModelIdAtomFamily } from '../atoms';
import { ChatInputArea } from './chat-input-area';

// `lib/trpc` wires its ipc client at import time, so the preload bridge must exist first.
vi.hoisted(() => {
  Object.assign(globalThis, {
    electronTRPC: { onMessage: () => () => undefined, sendMessage: () => undefined },
  });
});

/** A real trpc client that never answers: the composer's account, model and command queries stay
 *  loading, which is all these tests need. */
function createIdleClient() {
  return trpc.createClient({ links: [() => () => observable(() => undefined)] });
}

afterEach(cleanup);

const selection = {
  id: 'sel-1',
  text: 'const a = 1;',
  filePath: '/repo/src/send.ts',
  fileName: 'send.ts',
  language: 'typescript',
  startLine: 279,
  endLine: 282,
  preview: 'const a = 1;',
  createdAt: new Date(0),
};

function composerProps(
  over: Partial<ComponentProps<typeof ChatInputArea>> = {},
): ComponentProps<typeof ChatInputArea> {
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
    messageTokenData: { contextTokens: 0, contextWindow: null, promptCacheExpiresAt: null },
    subChatId: 'sub-chat-1',
    parentChatId: 'chat-1',
    projectPath: '/repo',
    changedFiles: [],
    codeSelectionContext: null,
    onClearCodeSelection: vi.fn(),
    activeFileName: null,
    activeFileDismissed: false,
    onDismissActiveFile: vi.fn(),
    ...over,
  };
}

function renderComposer(over: Partial<ComponentProps<typeof ChatInputArea>> = {}) {
  const props = composerProps(over);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <trpc.Provider client={createIdleClient()} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <ChatInputArea {...props} />
        </TooltipProvider>
      </QueryClientProvider>
    </trpc.Provider>,
  );
  return { props, ...view };
}

/** The footer control row: Mode, Auto and Model sit in it, and the editor chip must not. */
function footerRow(container: HTMLElement): HTMLElement {
  const row = container.querySelector<HTMLElement>('.flex-nowrap');
  if (!row) throw new Error('composer footer row not found');
  return row;
}

describe('ChatInputArea editor context', () => {
  it('shows the open file above the text box with a remove control, outside the footer row', () => {
    const { props, container } = renderComposer({ activeFileName: 'notes.md' });

    const remove = screen.getByRole('button', { name: 'Remove notes.md from context' });
    expect(remove.className).not.toContain('sr-only');
    expect(footerRow(container)).not.toContainElement(remove);
    expect(within(footerRow(container)).queryByText('notes.md')).not.toBeInTheDocument();

    fireEvent.click(remove);
    expect(props.onDismissActiveFile).toHaveBeenCalledOnce();
  });

  it('shows nothing for a file the user removed, matching what the send path attaches', () => {
    renderComposer({ activeFileName: 'notes.md', activeFileDismissed: true });

    expect(screen.queryByText('notes.md')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /from context/ })).not.toBeInTheDocument();
  });

  it('shows a code selection in place of the file, and removing it removes both', () => {
    const { props } = renderComposer({
      activeFileName: 'notes.md',
      codeSelectionContext: selection,
    });

    expect(screen.getByText('L279-282')).toBeInTheDocument();
    expect(screen.queryByText('notes.md')).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Remove code selection and file from context: send.ts lines 279-282',
      }),
    );
    expect(props.onClearCodeSelection).toHaveBeenCalledOnce();
    expect(props.onDismissActiveFile).toHaveBeenCalledOnce();
  });
});

describe('ChatInputArea on a free Codex account (its model/list has no GPT-6 Astra)', () => {
  /** Answers the account as Codex and its catalog as a free login's (or fails that query); every
   *  other query stays loading. */
  function renderFreeCodexComposer(catalogQueryFails = false) {
    const account = { type: 'codex', label: 'Codex', isAuthenticated: true };
    const catalog = { tiers: { 'gpt-6-luna': [], 'gpt-5.5': [] }, defaultSlug: 'gpt-6-luna' };
    renderWithTrpc(
      <Provider store={appStore}>
        <TooltipProvider>
          <ChatInputArea {...composerProps()} />
        </TooltipProvider>
      </Provider>,
      ({ path }) => {
        if (path === 'claudeCode.getResolvedAccount') return Promise.resolve(account);
        if (path === 'usage.getCodexAccountCatalog') {
          return catalogQueryFails
            ? Promise.reject(new Error('main unavailable'))
            : Promise.resolve(catalog);
        }
        return new Promise(() => {});
      },
    );
  }

  it("names a saved model the plan lacks, rather than showing a model it won't send", async () => {
    writeComposerCache('chat-1', { modelId: 'codex-gpt-6-astra-medium' });
    renderFreeCodexComposer();

    const note = "GPT-6 Astra isn't available on your ChatGPT plan — pick another model";
    const trigger = await waitFor(() => screen.getByRole('button', { name: `Model: ${note}` }));
    fireEvent.click(trigger);
    expect(screen.getByRole('option', { name: 'GPT-6 Luna' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'GPT-6 Astra' })).toBeNull();
  });

  it('still moves a saved Claude model to a Codex one when the account list query fails', async () => {
    writeComposerCache('chat-1', { modelId: 'sonnet' });
    renderFreeCodexComposer(true);

    await waitFor(() =>
      expect(appStore.get(lastSelectedModelIdAtomFamily('chat-1'))).toBe(CODEX_DEFAULT_MODEL_ID),
    );
  });
});

describe('ChatInputArea hides what the chat agent cannot do', () => {
  /** Places the caret after the editor's last text, as a typed `/` leaves it. */
  function caretAtEnd(root: HTMLElement) {
    const range = document.createRange();
    range.selectNodeContents(root.lastChild ?? root);
    range.collapse(false);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
  }

  async function openSlashMenu(props: ComponentProps<typeof ChatInputArea>, container: Element) {
    const root = container.querySelector<HTMLElement>('[contenteditable="true"]');
    if (!root) throw new Error('composer editor not found');
    root.focus();
    act(() => props.editorRef.current?.setValue('/'));
    caretAtEnd(root);
    fireEvent.input(root);
    return screen.findByRole('listbox', { name: 'Slash commands' });
  }

  it.each([
    { type: 'claude-code', supportsAll: true },
    { type: 'opencode', supportsAll: false },
  ])('$type: compact ring, /compact and /debug shown only when supported', async (c) => {
    const props = composerProps({ projectId: 'project-1' });
    const account = { type: c.type, label: c.type, isAuthenticated: true };
    const { container } = renderWithTrpc(
      <Provider store={appStore}>
        <TooltipProvider>
          <ChatInputArea {...props} />
        </TooltipProvider>
      </Provider>,
      ({ path }) =>
        path === 'claudeCode.getResolvedAccount' ? Promise.resolve(account) : new Promise(() => {}),
    );
    // The model trigger shows the agent's own default once the account resolves.
    if (!c.supportsAll) await screen.findByRole('button', { name: /OpenCode default/ });

    const ring = screen.queryByRole('button', { name: 'Compact context' });
    expect(ring !== null).toBe(c.supportsAll);
    const menu = await openSlashMenu(props, container);
    expect(within(menu).getByText('/plan')).toBeInTheDocument();
    expect(within(menu).queryByText('/compact') !== null).toBe(c.supportsAll);
    expect(within(menu).queryByText('/debug') !== null).toBe(c.supportsAll);
  });

  it('switches a saved Debug to Agent once the chat agent turns out to have no Debug', async () => {
    const props = composerProps({ projectId: 'project-1', parentChatId: 'chat-debug' });
    appStore.set(chatModeAtomFamily('chat-debug'), 'debug');
    const account = { type: 'opencode', label: 'OpenCode', isAuthenticated: true };
    renderWithTrpc(
      <Provider store={appStore}>
        <TooltipProvider>
          <ChatInputArea {...props} />
        </TooltipProvider>
      </Provider>,
      ({ path }) =>
        path === 'claudeCode.getResolvedAccount' ? Promise.resolve(account) : new Promise(() => {}),
    );

    await waitFor(() => expect(appStore.get(chatModeAtomFamily('chat-debug'))).toBe('agent'));
  });

  it('tries the switch to Agent once, even when saving it keeps failing', async () => {
    const props = composerProps({
      projectId: 'project-1',
      parentChatId: 'chat-failing',
      subChatId: 'sub-failing',
    });
    appStore.set(chatModeAtomFamily('chat-failing'), 'debug');
    const account = { type: 'opencode', label: 'OpenCode', isAuthenticated: true };
    let saves = 0;
    renderWithTrpc(
      <Provider store={appStore}>
        <TooltipProvider>
          <ChatInputArea {...props} />
        </TooltipProvider>
      </Provider>,
      ({ path }) => {
        if (path === 'claudeCode.getResolvedAccount') return Promise.resolve(account);
        if (path !== 'chats.updateSubChatMode') return new Promise(() => {});
        saves += 1;
        return Promise.reject(new Error('The database is busy.'));
      },
    );

    await waitFor(() => expect(saves).toBe(1));
    await waitFor(() => expect(appStore.get(chatModeAtomFamily('chat-failing'))).toBe('debug'));
    expect(saves).toBe(1);
  });
});
