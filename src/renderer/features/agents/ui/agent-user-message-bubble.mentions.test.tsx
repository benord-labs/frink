// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { createStore, Provider } from 'jotai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chatMarkdownModeAtom } from '../atoms';
import { AgentUserMessageBubble } from './agent-user-message-bubble';

// `lib/trpc` wires its ipc client at import time, so the preload bridge must exist first.
vi.hoisted(() => {
  Object.assign(globalThis, {
    electronTRPC: { onMessage: () => () => undefined, sendMessage: () => undefined },
  });
});

function renderWithMarkdownOn(textContent: string) {
  const store = createStore();
  store.set(chatMarkdownModeAtom, 'rendered');
  return render(
    <Provider store={store}>
      <AgentUserMessageBubble messageId="m" textContent={textContent} />
    </Provider>,
  );
}

describe('AgentUserMessageBubble mentions with markdown rendering on', () => {
  afterEach(() => {
    cleanup();
  });

  it('draws the chip inside rendered markdown', () => {
    const { container } = renderWithMarkdownOn(
      '@[file:local:.oxlintrc.json] fix the **lint** rule',
    );

    expect(screen.getByTitle('local:.oxlintrc.json')).toHaveTextContent('.oxlintrc.json');
    expect(container.querySelector('.prose strong')).toHaveTextContent('lint');
    expect(container).not.toHaveTextContent('@[');
  });

  it('renders a list whose items are only mentions as markdown', () => {
    const { container } = renderWithMarkdownOn(
      'Review these:\n- @[file:local:src/a.ts]\n- @[file:local:src/b.ts]',
    );

    expect(container.querySelectorAll('.prose li')).toHaveLength(2);
    expect(screen.getByTitle('local:src/a.ts')).toHaveTextContent('a.ts');
    expect(container).not.toHaveTextContent('@[');
  });

  it('keeps a message without markdown on the plain mention view', () => {
    const { container } = renderWithMarkdownOn('@[file:local:.oxlintrc.json] how are you?');

    expect(screen.getByTitle('local:.oxlintrc.json')).toHaveTextContent('.oxlintrc.json');
    expect(container.querySelector('.prose')).toBeNull();
    expect(container).not.toHaveTextContent('@[');
  });
});
