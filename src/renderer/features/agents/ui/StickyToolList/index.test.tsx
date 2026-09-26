// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Provider } from 'jotai';
import { afterEach, describe, expect, it } from 'vitest';
import type { MessagePart } from '../../stores/message-store';
import { AgentTaskToolsGroup } from '../agent-task-tools';
import { AgentTodoTool } from '../agent-todo-tool';

afterEach(cleanup);

/** Tinted in place like any tool card. While stuck every row wears the glass (with no visible user
 *  message nothing covers the title) and any glow drops; nothing is drawn below the list. */
function expectGlassOnlyWhileStuck(container: HTMLElement, glowingRows: number) {
  const list = container.firstElementChild;
  expect(list).toHaveClass('sticky', '[container-type:scroll-state]');
  expect(list).not.toHaveClass('bg-background');
  const rows = Array.from(list?.children ?? []);
  expect(rows).not.toHaveLength(0);
  for (const row of rows) expect(row).toHaveClass('stuck:glass-float');
  expect(list?.querySelector('.glass-float')).toBeNull();
  const glows = list?.querySelectorAll('.shadow-background') ?? [];
  expect(glows).toHaveLength(glowingRows);
  for (const glow of glows) expect(glow).toHaveClass('stuck:shadow-none');
}

const TASK_PARTS: MessagePart[] = [
  {
    type: 'tool-TaskCreate',
    toolCallId: 'task-1',
    state: 'output-available',
    input: { subject: 'Write the tests' },
    output: { task: { id: '1', subject: 'Write the tests' } },
  },
];

describe('sticky transcript lists', () => {
  it('puts the to-do list on the glass while stuck', () => {
    const { container } = render(
      <Provider>
        <AgentTodoTool
          part={{
            type: 'tool-TodoWrite',
            toolCallId: 'todo-1',
            state: 'output-available',
            input: { todos: [{ content: 'Write the tests', status: 'in_progress' }] },
          }}
          chatStatus="ready"
          subChatId="chat-1"
        />
      </Provider>,
    );
    expect(screen.getByRole('button', { name: 'Expand to-do list' })).toBeInTheDocument();
    expectGlassOnlyWhileStuck(container, 1);
  });

  it('puts the to-do placeholder on the glass while stuck', () => {
    const { container } = render(
      <Provider>
        <AgentTodoTool
          part={{ type: 'tool-TodoWrite', toolCallId: 'todo-1', state: 'input-streaming' }}
          chatStatus="streaming"
          subChatId="chat-1"
        />
      </Provider>,
    );
    expect(screen.getByText('Creating to-do list...')).toBeInTheDocument();
    expectGlassOnlyWhileStuck(container, 0);
  });

  it('puts a streaming task list on the glass while stuck, and unpins it once done', () => {
    const { container, rerender } = render(
      <Provider>
        <AgentTaskToolsGroup parts={TASK_PARTS} isStreaming subChatId="chat-1" />
      </Provider>,
    );
    expect(screen.getByText('Created 1 task')).toBeInTheDocument();
    expectGlassOnlyWhileStuck(container, 1);

    rerender(
      <Provider>
        <AgentTaskToolsGroup parts={TASK_PARTS} isStreaming={false} subChatId="chat-1" />
      </Provider>,
    );
    expect(container.firstElementChild).not.toHaveClass('sticky');
  });
});
