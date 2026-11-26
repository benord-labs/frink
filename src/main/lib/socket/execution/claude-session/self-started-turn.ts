import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ClaudeSession } from '../../claude-session-registry';

/** How long a turn the CLI started on its own waits for an execute to take it over. */
const SELF_STARTED_ADOPT_DEADLINE_MS = 30_000;

type FrameHandler = (m: SDKMessage) => void | Promise<void>;

/** The hand-over of a turn the CLI started on its own, such as a message from another session, to
 * the execute that renders it. Settles once: attached, or failed with a reason. */
export type SelfStartedAdoption = {
  /** The adopter's frame handler; rejects with an adopt-refused error when the adoption fails. */
  readonly handler: Promise<FrameHandler>;
  /** Tool callbacks wait on this instead of denying a turn that has no execute attached yet. */
  readonly attached: Promise<boolean>;
  pending: boolean;
  attach: (onMessage: FrameHandler) => boolean;
  /** The adopting execute registered: from here only its attach or its own end settles this. */
  claim: () => void;
  fail: (reason: string) => void;
};

/** `onFail` runs once, after the waiters are released: the caller retires the session there. */
export function createSelfStartedAdoption(
  onFail: (reason: string) => void,
  deadlineMs = SELF_STARTED_ADOPT_DEADLINE_MS,
): SelfStartedAdoption {
  let resolveHandler!: (handler: FrameHandler) => void;
  let rejectHandler!: (err: Error) => void;
  const handler = new Promise<FrameHandler>((resolve, reject) => {
    resolveHandler = resolve;
    rejectHandler = reject;
  });
  // A failure is observed through `attached` and the frame that awaits the handler.
  handler.catch(() => {});
  let resolveAttached!: (ok: boolean) => void;
  const attached = new Promise<boolean>((resolve) => {
    resolveAttached = resolve;
  });
  const settle = (): boolean => {
    if (!adoption.pending) return false;
    adoption.pending = false;
    clearTimeout(timer);
    return true;
  };
  const adoption: SelfStartedAdoption = {
    handler,
    attached,
    pending: true,
    attach: (onMessage) => {
      if (!settle()) return false;
      resolveHandler(onMessage);
      resolveAttached(true);
      return true;
    },
    claim: () => clearTimeout(timer),
    fail: (reason) => {
      if (!settle()) return;
      rejectHandler(new Error(`self-started turn not adopted (${reason}) — adopt refused`));
      resolveAttached(false);
      onFail(reason);
    },
  };
  const timer = setTimeout(() => adoption.fail('self-turn-unadopted'), deadlineMs);
  timer.unref?.();
  return adoption;
}

/** Take over the turn the CLI started on its own: resolves at its own result, like runTurn. */
export function adoptSelfStartedTurn(
  session: ClaudeSession,
  onMessage: (m: SDKMessage) => void | Promise<void>,
): Promise<void> {
  const sink = session.loop.turn;
  const adoption = session.selfStartedAdoption;
  if (sink?.path !== 'self-started' || !adoption?.pending) {
    return Promise.reject(
      new Error(`runTurn: no self-started turn on ${session.subChatId} — adopt refused`),
    );
  }
  return new Promise<void>((resolve, reject) => {
    sink.resolve = resolve;
    sink.reject = reject;
    adoption.attach(onMessage);
  });
}

/** The sink of a turn the CLI started on its own: its frames wait for the execute that adopts it. */
export function selfStartedSink(adoption: SelfStartedAdoption) {
  return {
    path: 'self-started' as const,
    pushedAt: Date.now(),
    ownToolIds: new Set<string>(),
    onMessage: async (m: SDKMessage) => (await adoption.handler)(m),
    resolve: () => {},
    reject: () => {},
  };
}
