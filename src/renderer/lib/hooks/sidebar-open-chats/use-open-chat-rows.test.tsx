// @vitest-environment happy-dom
import { cleanup, screen, waitFor } from '@testing-library/react';
import type { Operation } from '@trpc/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { renderWithTrpc } from '@/lib/test-utils/render-with-trpc';
import { useOpenChatRows } from './use-open-chat-rows';

// `lib/trpc` wires its ipc client at import time, so the preload bridge must exist first.
vi.hoisted(() => {
  Object.assign(globalThis, {
    electronTRPC: { onMessage: () => () => undefined, sendMessage: () => undefined },
  });
});

const TIMING = { CHAT_POLL_INTERVAL_MS: 60_000 };
const LIST_BY_IDS_INPUT = z.object({ ids: z.array(z.string()) });
const requests: string[][] = [];
let holdAnswers = false;

/** Answers chats.listByIds with one row per requested id, or never while `holdAnswers` is set. */
async function answer(op: Operation): Promise<Array<{ id: string }>> {
  if (op.path !== 'chats.listByIds') throw new Error(`Unexpected test operation: ${op.path}`);
  const { ids } = LIST_BY_IDS_INPUT.parse(op.input);
  requests.push(ids);
  if (holdAnswers) return new Promise(() => {});
  return ids.map((id) => ({ id }));
}

function OpenChats(props: {
  chatPaneMap: Map<string, number> | null;
  selectedChatId: string | null;
}) {
  const rows = useOpenChatRows(props.chatPaneMap, props.selectedChatId, TIMING);
  return <span data-testid="rows">{rows.map((row) => row.id).join(',')}</span>;
}

const shownRows = () => screen.getByTestId('rows').textContent;

afterEach(() => {
  cleanup();
  requests.length = 0;
  holdAnswers = false;
});

describe('useOpenChatRows', () => {
  it('fetches the chats open in split panes, in a stable order', async () => {
    const panes = new Map([
      ['b', 1],
      ['a', 2],
    ]);
    renderWithTrpc(<OpenChats chatPaneMap={panes} selectedChatId="c" />, answer);
    await waitFor(() => expect(shownRows()).toBe('a,b'));
    expect(requests).toEqual([['a', 'b']]);
  });

  it('fetches the selected chat in single view', async () => {
    renderWithTrpc(<OpenChats chatPaneMap={null} selectedChatId="c" />, answer);
    await waitFor(() => expect(shownRows()).toBe('c'));
  });

  it('fetches nothing when no chat is open', () => {
    renderWithTrpc(<OpenChats chatPaneMap={null} selectedChatId={null} />, answer);
    expect(shownRows()).toBe('');
    expect(requests).toEqual([]);
  });

  it('drops a closed chat at once while the new set of open chats loads', async () => {
    const before = new Map([
      ['a', 1],
      ['b', 2],
    ]);
    const { rerender } = renderWithTrpc(
      <OpenChats chatPaneMap={before} selectedChatId={null} />,
      answer,
    );
    await waitFor(() => expect(shownRows()).toBe('a,b'));

    holdAnswers = true;
    const after = new Map([
      ['b', 1],
      ['d', 2],
    ]);
    rerender(<OpenChats chatPaneMap={after} selectedChatId={null} />);
    expect(shownRows()).toBe('b');
  });
});
