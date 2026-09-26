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
