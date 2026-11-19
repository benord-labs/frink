import type {
  BackgroundTaskSummary,
  CanUseTool,
  McpServerStatus,
  Query,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { vi } from 'vitest';
import type { TaskStopHook } from '../../../task-stop-hook';
import type { ClaudeQueryCall } from '../../test-utils';
import { RUNNING_TASK, stopInput } from '../claude-turn-bindings';

type QueryInput = {
  prompt: AsyncIterable<SDKUserMessage>;
  options: {
    abortController?: AbortController;
    hooks: { Stop: Array<{ hooks: TaskStopHook[] }> } & NonNullable<
      NonNullable<ClaudeQueryCall['options']>['hooks']
    >;
    canUseTool: CanUseTool;
  };
};
export type Cli = {
  prompt: AsyncIterator<SDKUserMessage>;
  options: QueryInput['options'];
  stop: (backgroundTasks?: BackgroundTaskSummary[]) => ReturnType<TaskStopHook>;
};
/** An SDK message as the suite's transformer mock reads it. */
export type Frame = { type?: string; chunks?: object[] };
/** The CLI's side of one fake session: reads prompts, fires hooks, and yields frames. */
export type CliScript = (cli: Cli) => AsyncGenerator<Frame>;

const DONE = { done: true, value: undefined } as const;
/** A tool call that never answers, like a CLI blocked in a silent tool. */
export const never = () => new Promise<never>(() => {});
/** A result the CLI flags `is_error` without failing the turn (usage-limit or API-error text). */
export const UNCLEAN_RESULT = { type: 'result', subtype: 'success', is_error: true, result: '' };

/** Registers the next SDK query. Like the real `Query`, `close()`/`return()` end the pending read
 * at once and an aborted `abortController` option fails it as a user abort. */
export function mockQuery(claudeQueryMock: ReturnType<typeof vi.fn>, cli: CliScript) {
  let ended = false;
  let end: (error?: Error) => void = () => {};
  const stopped = new Promise<IteratorResult<Frame>>((resolve, reject) => {
    end = (error) => {
      ended = true;
      if (error) reject(error);
      else resolve(DONE);
    };
  });
  stopped.catch(() => {});
  const query = {
    close: vi.fn(() => end()),
    return: vi.fn(async () => {
      end();
      await new Promise((resolve) => setImmediate(resolve));
      return DONE;
    }),
    interrupt: vi.fn(async () => {}),
    setPermissionMode: vi.fn(async () => {}),
    setModel: vi.fn(async (_model?: string) => {}),
    applyFlagSettings: vi.fn(async (_settings: Parameters<Query['applyFlagSettings']>[0]) => {}),
    initializationResult: vi.fn(async () => ({})),
    mcpServerStatus: vi.fn(async (): Promise<McpServerStatus[]> => []),
  };
  claudeQueryMock.mockImplementationOnce(({ prompt, options }: QueryInput) => {
    options.abortController?.signal.addEventListener('abort', () =>
      end(new Error('Claude Code process aborted by user')),
    );
    const stop = (backgroundTasks: BackgroundTaskSummary[] = []) =>
      options.hooks.Stop[0].hooks[0](stopInput(backgroundTasks));
    const frames = cli({ prompt: prompt[Symbol.asyncIterator](), options, stop });
    return Object.assign(query, {
      next: () => (ended ? stopped : Promise.race([frames.next(), stopped])),
      [Symbol.asyncIterator]() {
        return this;
      },
    });
  });
  return query;
}

/** Ends turn 1 with `turnEnd` while background work runs, so the chat holds; `wake()` then has the
 * CLI play `burst` on its own, as a wake burst streaming into the arming message. */
export function wakingCli(turnEnd: readonly Frame[], burst: (cli: Cli) => AsyncGenerator<Frame>) {
  let wake = () => {};
  const woke = new Promise<void>((resolve) => {
    wake = resolve;
  });
  const script: CliScript = async function* (cli) {
    await cli.prompt.next();
    await cli.stop([RUNNING_TASK]);
    yield* turnEnd;
    await woke;
    yield* burst(cli);
    await never();
  };
  return { script, wake };
}
