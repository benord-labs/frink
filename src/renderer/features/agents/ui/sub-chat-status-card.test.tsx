// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SubChatStatusCard } from './sub-chat-status-card';

vi.mock('../../../lib/trpc', () => ({
  trpc: { changes: { getStatus: { useQuery: () => ({ data: undefined }) } } },
}));

vi.mock('../../../lib/hooks/use-file-change-listener', () => ({
  useFileChangeListener: () => {},
}));

const changedFiles = [{ filePath: '/p/a.ts', displayPath: 'a.ts', additions: 1, deletions: 0 }];

afterEach(() => {
  cleanup();
});

// The marker squares the top of the composer-slot surface below (globals.css), and the top card
// takes that surface's 1rem radius, so the stack reads as one object.
describe('SubChatStatusCard — stacked on the composer slot', () => {
  it('marks itself as a stacked card and rounds its top like the slot surface', () => {
    const { container } = render(
      <SubChatStatusCard chatId="c" subChatId="s" isStreaming changedFiles={changedFiles} />,
    );
    expect(container.firstChild).toHaveAttribute('data-stacked-card');
    expect(container.firstChild).toHaveClass('rounded-t-2xl', 'border-b-0');
  });

  it('squares its top under the queue card', () => {
    const { container } = render(
      <SubChatStatusCard
        chatId="c"
        subChatId="s"
        isStreaming
        changedFiles={changedFiles}
        hasQueueCardAbove
      />,
    );
    expect(container.firstChild).toHaveAttribute('data-stacked-card');
    expect(container.firstChild).toHaveClass('rounded-none');
  });
});
