// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TextSelectionProvider } from '../../../context/text-selection-context';
import { ChatHeaderSection } from './ChatHeaderSection';

const props = {
  messages: [],
  quickCommentState: null,
  addTextContext: vi.fn(),
  handleQuickComment: vi.fn(),
  handleQuickCommentSubmit: vi.fn(),
  handleQuickCommentCancel: vi.fn(),
  handleFocusInput: vi.fn(),
  subChatName: 'My Chat',
  subChatId: 'sc-1',
  hasMessages: true,
  handleRenameSubChat: vi.fn(),
};

afterEach(cleanup);

describe('ChatHeaderSection title row', () => {
  it('hides the title row in a Compact split pane, where the PaneHeader already shows the title', () => {
    render(
      <TextSelectionProvider>
        <ChatHeaderSection {...props} isMobile={false} />
      </TextSelectionProvider>,
    );

    expect(screen.getByText('My Chat').closest('.shrink-0')?.className).toContain(
      '@max-[30rem]/pane:hidden',
    );
  });

  it('omits the title row on mobile', () => {
    render(
      <TextSelectionProvider>
        <ChatHeaderSection {...props} isMobile />
      </TextSelectionProvider>,
    );

    expect(screen.queryByText('My Chat')).toBeNull();
  });
});
