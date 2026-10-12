// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { createStore, Provider } from 'jotai';
import { afterEach, describe, expect, it } from 'vitest';
import { selectedAgentChatIdAtom } from '../../../../../lib/atoms/agent-navigation-atoms';
import type { ChatItem } from '../../types';
import { FolderRowMeta } from '.';

const OPEN_CHAT_LABEL = 'Open chat is in this project';
const chats: Pick<ChatItem, 'id'>[] = [{ id: 'chat-a' }, { id: 'chat-b' }];

function renderMeta(options: { openChatId: string | null; isExpanded?: boolean; split?: boolean }) {
  const store = createStore();
  store.set(selectedAgentChatIdAtom, options.openChatId);
  return render(
    <Provider store={store}>
      <FolderRowMeta
        isExpanded={options.isExpanded ?? false}
        chats={chats}
        chatPaneMap={options.split ? new Map([['chat-a', 1]]) : undefined}
        folderState={null}
        totalChats={2}
      />
    </Provider>,
  );
}

describe('FolderRowMeta open-chat marker', () => {
  afterEach(cleanup);

  it('marks a collapsed project holding the open chat in single view', () => {
    renderMeta({ openChatId: 'chat-a' });
    expect(screen.getByLabelText(OPEN_CHAT_LABEL)).toBeTruthy();
    expect(screen.queryByTitle(/Open in pane/)).toBeNull();
  });

  it('leaves a project unmarked when the open chat is elsewhere', () => {
    renderMeta({ openChatId: 'chat-in-another-project' });
    expect(screen.queryByLabelText(OPEN_CHAT_LABEL)).toBeNull();
  });

  it('drops the marker once expanded, where the selected row shows it', () => {
    renderMeta({ openChatId: 'chat-a', isExpanded: true });
    expect(screen.queryByLabelText(OPEN_CHAT_LABEL)).toBeNull();
  });

  it('shows pane numbers, not the marker, in split view', () => {
    renderMeta({ openChatId: 'chat-a', split: true });
    expect(screen.queryByLabelText(OPEN_CHAT_LABEL)).toBeNull();
    expect(screen.getByTitle('Open in pane 1')).toBeTruthy();
  });
});
