// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { observable } from '@trpc/server/observable';
import { createStore, Provider } from 'jotai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  chatContextFileAtomFamily,
  chatContextFileDismissedAtomFamily,
  codeSelectionContextAtomFamily,
} from '@/lib/code-editor/state';
import { codeSelectionMention } from '@/lib/mentions/queued-message-text';
import type { CodexAccountCatalog } from '../../../../shared/lib/codex-cli-models';
import { TooltipProvider } from '../../../components/ui/tooltip';
import { newChatTerminalId } from '@/lib/agent-chat/sentinel-ids';
import { pendingTerminalOutputAtomFamily } from '@/lib/terminal/pending-output';
import { appStore } from '../../../lib/jotai-store';
import { trpc } from '../../../lib/trpc';
import {
  lastSelectedModelIdAtom,
  lastSelectedModelIdAtomFamily,
  NEW_CHAT_PANE,
  selectedProjectAtom,
} from '../atoms';
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

const repoProject = { id: 'project-1', name: 'repo', path: '/repo' };

function answerFor(path: string, answers: TestAnswers) {
  switch (path) {
    case 'projects.scaffold':
      return { id: 'project-1', path: '/repo' };
    case 'projects.list':
      return [repoProject];
    case 'claudeCode.getResolvedAccount':
      return answers.account;
    case 'usage.getCodexAccountCatalog':
      return answers.codexCatalog;
    case 'chats.create':
      return answers.createdChat;
    case 'files.writePastedText':
      return { filePath: '/s/pasted/terminal_1.txt', filename: 'terminal_1.txt', size: 4 };
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
  // Unmounting saves the composer's draft; a chip left there would ride the next test's send.
  localStorage.clear();
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

  // Keyed by the form's terminal id, not its draft key: outside split view the two differ.
  it("puts its terminal's output in the composer as a labelled chip", async () => {
    const store = createStore();
    store.set(pendingTerminalOutputAtomFamily(newChatTerminalId()), {
      text: 'FAIL',
      label: 'Terminal 1 output',
    });

    renderNewChat(store);

    expect(await screen.findByText('Terminal 1 output')).toBeInTheDocument();
    expect(store.get(pendingTerminalOutputAtomFamily(newChatTerminalId()))).toBeNull();
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

  it('sends a code selection with the first message, in the shared token format', async () => {
    const selection = {
      id: 'sel-1',
      text: 'const ü = 1;',
      filePath: '/repo/a b.ts',
      fileName: 'a b.ts',
      language: 'typescript',
      startLine: 3,
      endLine: 4,
      preview: 'const ü = 1;',
      createdAt: new Date(0),
    };
    const store = createStore();
    store.set(codeSelectionContextAtomFamily(NEW_CHAT_PANE), selection);
    const { container } = renderNewChat(store);
    const editor = container.querySelector<HTMLElement>('[contenteditable="true"]');
    if (!editor) throw new Error('composer editor not found');
    editor.textContent = 'explain this';
    fireEvent.input(editor);

    fireEvent.keyDown(editor, { key: 'Enter' });

    await waitFor(() => expect(createChat).toHaveBeenCalledOnce());
    expect(createChat.mock.calls[0][0].initialMessageParts).toEqual([
      { type: 'text', text: `${codeSelectionMention(selection)} explain this` },
    ]);
  });
});

describe('NewChatForm empty chat copy', () => {
  it('greets a General chat with a task heading and a hint that does not promise files', async () => {
    renderNewChat();

    expect(await screen.findByRole('heading', { name: 'Hand Frink a task' })).toBeInTheDocument();
    expect(screen.getByText('Describe a task in plain words.')).toBeInTheDocument();
  });

  it('tells a project chat that @ adds a file', async () => {
    const store = createStore();
    store.set(selectedProjectAtom, repoProject);

    renderNewChat(store);

    expect(await screen.findByRole('heading', { name: 'Hand Frink a task' })).toBeInTheDocument();
    expect(
      screen.getByText('Describe a task in plain words. Type @ to add a file.'),
    ).toBeInTheDocument();
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
