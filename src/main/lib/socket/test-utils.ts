export type PreToolUseHook = (
  hookInput: { hook_event_name: string; tool_name: string; tool_input: unknown },
  toolUseId: string,
) => Promise<
  { hookSpecificOutput: { permissionDecision: 'allow' | 'deny' } } | Record<string, never>
>;

export type PreToolUseQueryInput = {
  options?: {
    env?: Record<string, string>;
    hooks?: { PreToolUse?: Array<{ hooks: PreToolUseHook[] }> };
    permissionMode?: string;
  };
};

export function getPreToolUseHook(queryInput: PreToolUseQueryInput): PreToolUseHook {
  const hook = queryInput.options?.hooks?.PreToolUse?.[0]?.hooks?.[0];
  if (!hook) throw new Error('Missing PreToolUse hook');
  return hook;
}

export type StopHookQueryHandle = {
  /** Pass to `claudeQueryMock.mockImplementationOnce` — becomes the SDK `query()` for one turn. */
  impl: (queryInput: unknown) => unknown;
  /** Emit a harness wake (task_notification + one text burst + result) into the open stream. */
  emitWake: () => void;
  /** End the stream (CLI death / test cleanup). */
  endStream: () => void;
};

/**
 * Channel-style fake Claude Query for the wake-pump seam: the turn fires its Stop hook with the
 * given background-task snapshot, finishes with a result, and the stream then stays OPEN so the
 * test can emit wake bursts or end it. `interrupt` is injected by the caller (usually a vi.fn())
 * so this module stays mock-framework-free.
 */
export function stopHookQuery(opts: {
  sessionId: string;
  backgroundTasks: unknown[];
  /** Frames yielded BEFORE the Stop hook fires (e.g. a mid-turn EnterPlanMode tool chunk). */
  prelude?: unknown[];
  wakeText?: string;
  interrupt: () => Promise<void> | void;
}): StopHookQueryHandle {
  const handle: StopHookQueryHandle = {
    impl: () => undefined,
    emitWake: () => {},
    endStream: () => {},
  };
  handle.impl = (queryInput: unknown) => {
    const input = queryInput as {
      options?: { hooks?: { Stop?: Array<{ hooks: Array<(i: unknown) => Promise<unknown>> }> } };
    };
    const stopHook = input.options?.hooks?.Stop?.[0]?.hooks?.[0];
    const buffer: unknown[] = [];
    let wakeGen: (() => void) | null = null;
    let ended = false;
    const release = () => {
      wakeGen?.();
      wakeGen = null;
    };
    handle.emitWake = () => {
      buffer.push({ type: 'system', subtype: 'task_notification' });
      buffer.push({
        chunks: [{ type: 'text-delta', id: 'wake-text', delta: opts.wakeText ?? 'wake burst' }],
      });
      buffer.push({ type: 'result' });
      release();
    };
    handle.endStream = () => {
      ended = true;
      release();
    };
    const gen = (async function* () {
      for (const frame of opts.prelude ?? []) yield frame;
      await stopHook?.({
        hook_event_name: 'Stop',
        stop_hook_active: false,
        background_tasks: opts.backgroundTasks,
      });
      yield { chunks: [{ type: 'finish', messageMetadata: { sessionId: opts.sessionId } }] };
      yield { type: 'result' };
      while (true) {
        while (buffer.length > 0) yield buffer.shift();
        if (ended) return;
        await new Promise<void>((resolve) => {
          wakeGen = resolve;
        });
      }
    })();
    return Object.assign(gen, { interrupt: opts.interrupt });
  };
  return handle;
}

type SubmitHookInput = { hook_event_name: 'UserPromptSubmit'; source: 'sdk'; prompt: string };
type SubmitHookOutput = { hookSpecificOutput?: { additionalContext?: string } };
type SubmitHook = (input: SubmitHookInput) => Promise<SubmitHookOutput>;
/** The part of one claudeQuery call that carries the hooks the executor registered. */
export type ClaudeQueryCall = {
  options?: { hooks?: { UserPromptSubmit?: Array<{ hooks?: SubmitHook[] }> } };
};

/**
 * Operator reminders (mode-exit, disarmed task-signal) are delivered on the Claude path as an
 * in-conversation system prompt via the SDK's UserPromptSubmit hook — NOT prepended to the user
 * prompt. Returns the hook's `additionalContext` for a given claudeQuery call, or undefined when no
 * reminder hook was registered that turn. Assertions check this instead of `call.prompt`.
 */
export async function userPromptSubmitReminder(
  call: ClaudeQueryCall,
  prompt = '',
): Promise<string | undefined> {
  const hook = call.options?.hooks?.UserPromptSubmit?.[0]?.hooks?.[0];
  if (!hook) return undefined;
  const out = await hook({ hook_event_name: 'UserPromptSubmit', source: 'sdk', prompt });
  return out.hookSpecificOutput?.additionalContext;
}

/** Extract the text of one user-message `content` (a bare string, or an array of content blocks). */
function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b): b is { type?: string; text?: string } => !!b && typeof b === 'object')
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('');
}

/**
 * Read the text of a Claude query prompt in tests. The Claude path streams its prompt as an
 * AsyncIterable<SDKUserMessage> — an input queue kept OPEN for the whole turn so the CLI's stdin (its
 * permission control channel) stays live through the end-of-turn frink_task_signal / ExitPlanMode
 * round-trips (the "Stream closed" fix). Tests that assert prompt CONTENT read the text of the initial
 * user message(s) out of that stream via this helper. Codex prompts stay plain strings, so a
 * string is returned as-is.
 */
export async function claudePromptText(prompt: unknown): Promise<string> {
  if (typeof prompt === 'string') return prompt;
  const iterable = prompt as { [Symbol.asyncIterator]?: unknown } | null | undefined;
  if (!iterable || typeof iterable[Symbol.asyncIterator] !== 'function') return '';
  let text = '';
  for await (const msg of prompt as AsyncIterable<{ message?: { content?: unknown } }>) {
    text += textFromContent(msg?.message?.content);
  }
  return text;
}
