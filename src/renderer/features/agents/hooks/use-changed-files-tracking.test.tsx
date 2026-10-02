// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react';
import { Provider } from 'jotai';
import { describe, expect, it, vi } from 'vitest';
import { useChangedFilesTracking } from './use-changed-files-tracking';

vi.mock('../../../lib/trpc', () => ({
  trpc: {
    claudeSettings: {
      getWorktreeBasePath: {
        useQuery: () => ({ data: undefined as { path?: string } | undefined }),
      },
    },
  },
}));

function jotaiWrapper({ children }: { children: React.ReactNode }) {
  return <Provider>{children}</Provider>;
}

type TestMessage = { role: string; parts?: Array<{ type: string; text?: string }> };

describe('useChangedFilesTracking — recomputeChangedFiles stability', () => {
  it('keeps recomputeChangedFiles identity when messages reference changes between renders', () => {
    const messagesA: TestMessage[] = [{ role: 'assistant', parts: [] }];
    const messagesB: TestMessage[] = [
      {
        role: 'assistant',
        parts: [{ type: 'text', text: 'chunk' }],
      },
    ];

    const { result, rerender } = renderHook(
      ({ messages }: { messages: TestMessage[] }) =>
        useChangedFilesTracking(messages, 'sub-chat-x', false, 'chat-y'),
      {
        wrapper: jotaiWrapper,
        initialProps: { messages: messagesA },
      },
    );

    const first = result.current.recomputeChangedFiles;
    rerender({ messages: messagesB });
    const second = result.current.recomputeChangedFiles;

    expect(typeof first).toBe('function');
    expect(second).toBe(first);
  });
});

// sc-3829: a reloaded chat's transcript comes from chats.getSubChatMessages in the stored SDK
// shape (snake_case tool inputs). The card is fed from this hook, so it must read that shape.
describe('useChangedFilesTracking — persisted transcript', () => {
  it('lists Edit and Write changes from a non-streaming, persisted transcript', () => {
    const messages = [
      {
        role: 'assistant',
        parts: [
          {
            type: 'tool-Edit',
            state: 'output-available',
            input: { file_path: '/repo/src/a.ts', old_string: 'x', new_string: 'y\nz' },
          },
          {
            type: 'tool-Write',
            state: 'output-available',
            input: { file_path: '/repo/src/b.ts', content: 'one\ntwo\nthree' },
          },
        ],
      },
    ];

    const { result } = renderHook(
      () => useChangedFilesTracking(messages, 'sub-chat-x', false, 'chat-y'),
      { wrapper: jotaiWrapper },
    );

    expect(result.current.changedFiles).toEqual([
      { filePath: '/repo/src/a.ts', displayPath: 'src/a.ts', additions: 2, deletions: 1 },
      { filePath: '/repo/src/b.ts', displayPath: 'src/b.ts', additions: 3, deletions: 0 },
    ]);
  });
});
