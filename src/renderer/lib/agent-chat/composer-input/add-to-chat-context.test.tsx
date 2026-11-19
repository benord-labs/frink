// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react';
import { createStore, Provider } from 'jotai';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { AddToChatProvider, useAddToChat } from './add-to-chat-context';
import { type PendingComposerInput, pendingComposerInputAtomFamily } from './pending-input';

function renderAddToChat(chatId: string | undefined) {
  const store = createStore();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <Provider store={store}>
      <AddToChatProvider chatId={chatId}>{children}</AddToChatProvider>
    </Provider>
  );
  return { store, add: renderHook(() => useAddToChat(), { wrapper }).result.current };
}

describe('AddToChatProvider', () => {
  it('has nothing to send to without a chat or in an empty split pane', () => {
    expect(renderAddToChat(undefined).add).toBeUndefined();
    expect(renderAddToChat('empty-0').add).toBeUndefined();
  });

  it("queues the paths for the chat's composer after anything already queued", () => {
    const { store, add } = renderAddToChat('chat-1');
    const queued: PendingComposerInput = { kind: 'text', text: 'FAIL', label: 'Terminal 1 output' };
    store.set(pendingComposerInputAtomFamily('chat-1'), [queued]);
    add?.([{ path: 'src/a.ts', type: 'file' }]);
    expect(store.get(pendingComposerInputAtomFamily('chat-1'))).toEqual([
      queued,
      { kind: 'paths', items: [{ path: 'src/a.ts', type: 'file' }] },
    ]);
  });
});
