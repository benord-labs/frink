// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MessagePart } from '../stores/message-store';
import { AgentBashTool } from './agent-bash-tool';

type PollOptions = {
  enabled: boolean;
  refetchInterval: (query: { state: { data: unknown } }) => number | false;
};
type CommandOutputInput = { subChatId: string; commandId: string };
let pollOptions: PollOptions | undefined;
const commandOutputQuery = vi.fn((_input: CommandOutputInput) => ({
  data: { runningForMs: 12_000, text: 'Compiling…\nBuilt in 9s' },
}));
vi.mock('../../../lib/trpc', () => ({
  trpc: {
    socket: {
      getCommandOutput: {
        useQuery: (input: CommandOutputInput, options: PollOptions) => {
          pollOptions = options;
          return commandOutputQuery(input);
        },
      },
    },
  },
}));

const bash = (state: string, output?: unknown) =>
  ({
    type: 'tool-Bash',
    toolCallId: 'item-1',
    state,
    input: { command: 'bun run build' },
    output,
  }) as unknown as MessagePart;

afterEach(() => {
  cleanup();
  commandOutputQuery.mockClear();
});

describe('AgentBashTool', () => {
  it('shows a running command’s live output', () => {
    render(<AgentBashTool part={bash('input-available')} subChatId="sc1" chatStatus="streaming" />);

    expect(commandOutputQuery).toHaveBeenCalledWith({ subChatId: 'sc1', commandId: 'item-1' });
    expect(screen.getByText('Running for 12s')).toBeInTheDocument();
    expect(screen.getByText(/Built in 9s/)).toBeInTheDocument();
  });

  it('stops pulling once the command has its final output', () => {
    render(
      <AgentBashTool
        part={bash('output-available', { output: 'Built in 9s', exitCode: 0 })}
        subChatId="sc1"
        chatStatus="ready"
      />,
    );

    expect(commandOutputQuery).not.toHaveBeenCalled();
  });

  it('requests nothing for a running card scrolled out of view', () => {
    let report: ((entries: { isIntersecting: boolean }[]) => void) | undefined;
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(callback: typeof report) {
          report = callback;
        }
        observe() {}
        disconnect() {}
      },
    );
    render(<AgentBashTool part={bash('input-available')} subChatId="sc1" chatStatus="streaming" />);

    expect(pollOptions?.enabled).toBe(false);
    act(() => report?.([{ isIntersecting: true }]));
    expect(pollOptions?.enabled).toBe(true);
    vi.unstubAllGlobals();
  });

  it('polls only while the command is still running', () => {
    render(<AgentBashTool part={bash('input-available')} subChatId="sc1" chatStatus="streaming" />);
    const interval = (data: unknown) => pollOptions?.refetchInterval({ state: { data } });

    expect(interval({ runningForMs: 1, text: 'tick' })).toBe(1000);
    // Unreadable output is retried at main's own pace, since the file may not exist yet.
    expect(interval({ runningForMs: null, text: null })).toBe(1000);
    expect(interval(null)).toBe(false);
  });
});
