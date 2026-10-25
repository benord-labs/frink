// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { observable } from '@trpc/server/observable';
import { createStore, Provider } from 'jotai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  chatContextFileAtomFamily,
  chatContextFileDismissedAtomFamily,
} from '@/lib/code-editor/state';
import type { CodexAccountCatalog } from '../../../../shared/lib/codex-cli-models';
import { TooltipProvider } from '../../../components/ui/tooltip';
import { COMMAND_PROMPTS } from '../../../lib/commands/builtin-commands';
import { appStore } from '../../../lib/jotai-store';
import { trpc } from '../../../lib/trpc';
import { lastSelectedModelIdAtom, lastSelectedModelIdAtomFamily, NEW_CHAT_PANE } from '../atoms';
import { NewChatForm } from './new-chat-form';

// `lib/trpc` wires its ipc client at import time, so the preload bridge must exist first.
vi.hoisted(() => {
  Object.assign(globalThis, {
    electronTRPC: { onMessage: () => () => undefined, sendMessage: () => undefined },
  });
});

type CreateChatInput = Parameters<ReturnType<typeof trpc.chats.create.useMutation>['mutate']>[0];

const createChat = vi.fn<(input: CreateChatInput) => void>();

/** Query answers a test names; any query left out stays loading. */
type TestAnswers = {
  account?: { type: 'codex'; label: string; isAuthenticated: boolean };
  codexCatalog?: CodexAccountCatalog;
  createdChat?: { id: string; subChats: [] };
};

function answerFor(path: string, answers: TestAnswers) {
  switch (path) {
    case 'projects.scaffold':
      return { id: 'project-1', path: '/repo' };
    case 'claudeCode.getResolvedAccount':
      return answers.account;
    case 'usage.getCodexAccountCatalog':
      return answers.codexCatalog;
    case 'chats.create':
      return answers.createdChat;
    default:
      return undefined;
  }
}

/** A real trpc client: queries stay loading unless `answers` names them, a scaffolded project is a
 *  fixed folder, and chat creation is recorded and left pending (or answered, when named). */
function createTestClient(answers: TestAnswers = {}) {
  return trpc.createClient({
    links: [
      () =>
        ({ op }) =>
          observable((observer) => {
            if (op.path === 'chats.create') {
              // SAFETY: with no transformer link, op.input is exactly what the form passed to chats.create.
              const input = op.input as CreateChatInput;
              createChat(input);
            }
            const data = answerFor(op.path, answers);
            if (data === undefined) return;
            observer.next({ result: { data } });
            observer.complete();
          }),
    ],
  });
}

afterEach(() => {
  cleanup();
  createChat.mockReset();
});

const notes = { name: 'notes.md', path: '/repo/docs/notes.md' };

function renderNewChat(store = createStore(), answers: TestAnswers = {}) {
  store.set(chatContextFileAtomFamily(NEW_CHAT_PANE), notes);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <trpc.Provider client={createTestClient(answers)} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <Provider store={store}>
          <TooltipProvider>
            <NewChatForm />
          </TooltipProvider>
        </Provider>
      </QueryClientProvider>
    </trpc.Provider>,
  );
  return { store, ...view };
}

describe('NewChatForm editor context', () => {
  it('shows the open file inside the composer, with a remove control that takes it off', () => {
    const { store } = renderNewChat();

    const remove = screen.getByRole('button', { name: 'Remove notes.md from context' });
    expect(remove.closest('.chat-composer-glass')).not.toBeNull();

    fireEvent.click(remove);

    expect(store.get(chatContextFileDismissedAtomFamily(NEW_CHAT_PANE))).toBe(true);
    expect(screen.queryByText('notes.md')).not.toBeInTheDocument();
  });

  it('sends the file it shows with the first message', async () => {
    const { container } = renderNewChat();
    const editor = container.querySelector<HTMLElement>('[contenteditable="true"]');
    if (!editor) throw new Error('composer editor not found');
    editor.textContent = 'summarise this';
    fireEvent.input(editor);

    fireEvent.keyDown(editor, { key: 'Enter' });

    await waitFor(() => expect(createChat).toHaveBeenCalledOnce());
    expect(createChat.mock.calls[0][0].initialMessageParts).toEqual([
      { type: 'text', text: '@[file:editor:/repo/docs/notes.md] summarise this' },
    ]);
  });
});

describe('NewChatForm on a free Codex account (its model/list has no GPT-6 Astra)', () => {
  afterEach(() => appStore.set(lastSelectedModelIdAtom, 'sonnet'));

  it('starts the chat on a model the account has, without the user changing it', async () => {
    // The app's own store: new-chat seeding reads and writes it directly.
    appStore.set(lastSelectedModelIdAtom, 'codex-gpt-6-astra-medium');
    const { container } = renderNewChat(appStore, {
      account: { type: 'codex', label: 'Codex', isAuthenticated: true },
      codexCatalog: { tiers: { 'gpt-6-luna': [], 'gpt-5.5': [] }, defaultSlug: 'gpt-6-luna' },
      createdChat: { id: 'chat-free', subChats: [] },
    });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^Model: GPT-6 Luna/ })).toBeInTheDocument(),
    );
    const editor = container.querySelector<HTMLElement>('[contenteditable="true"]');
    if (!editor) throw new Error('composer editor not found');
    editor.textContent = 'hello';
    fireEvent.input(editor);

    fireEvent.keyDown(editor, { key: 'Enter' });

    await waitFor(() =>
      expect(appStore.get(lastSelectedModelIdAtomFamily('chat-free'))).toBe(
        'codex-gpt-6-luna-medium',
      ),
    );
  });
});

describe('NewChatForm slash-menu picks', () => {
  it('inserts a prompt-based built-in as a command block', async () => {
    const { container } = renderNewChat();
    const editor = container.querySelector<HTMLElement>('[contenteditable="true"]');
    if (!editor) throw new Error('composer editor not found');
    editor.focus();
    editor.textContent = '/';
    const range = document.createRange();
    range.selectNodeContents(editor.lastChild ?? editor);
    range.collapse(false);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    fireEvent.input(editor);

    const menu = await screen.findByRole('listbox', { name: 'Slash commands' });
    fireEvent.mouseDown(within(menu).getByText('/review'));

    expect(screen.getByLabelText('Command: review')).toHaveTextContent(
      COMMAND_PROMPTS.review ?? '',
    );
  });
});
