import { describe, expect, it, vi } from 'vitest';
import { createTaskStopHook } from './task-stop-hook';

/** Minimal SDK StopHookInput shapes — the SDK always passes the hook input (it is not optional
 * in the HookCallback contract), so every invocation here supplies one. */
const SESSION = '8356fc65-d823-4d80-b661-e22ad5c8a352';
const stopInput = (overrides: Record<string, unknown> = {}) =>
  ({
    hook_event_name: 'Stop',
    stop_hook_active: false,
    session_id: SESSION,
    ...overrides,
  }) as Parameters<ReturnType<typeof createTaskStopHook>>[0];
const idleStop = () => stopInput();

describe('createTaskStopHook', () => {
  // ── Signal already called ────────────────────────────────────────────────

  it('allows stop immediately when signal is already called', async () => {
    const hook = createTaskStopHook({
      hasSignal: () => true,
      isAborted: () => false,
    });
    expect(await hook(idleStop())).toEqual({});
  });

  it('allows stop once signal becomes set mid-session (checked per invocation)', async () => {
    let signaled = false;
    const hook = createTaskStopHook({
      hasSignal: () => signaled,
      isAborted: () => false,
    });
    // First invocation: no signal yet → block (retry 1)
    const first = await hook(idleStop());
    expect(first).toEqual({
      decision: 'block',
      reason: expect.stringContaining('frink_task_signal'),
    });
    // Signal called between hook invocations
    signaled = true;
    // Second invocation: signal now set → allow stop
    expect(await hook(idleStop())).toEqual({});
  });

  // ── Async hasSignal (PromiseLike<boolean>) ──────────────────────────────
  //
  // executor.ts may pass async hasSignal; implementation uses await Promise.resolve(...).

  it('allows stop immediately when async hasSignal resolves true', async () => {
    const hook = createTaskStopHook({
      hasSignal: async () => true,
      isAborted: () => false,
    });
    expect(await hook(idleStop())).toEqual({});
  });

  it('allows stop once async hasSignal becomes true between invocations', async () => {
    let signaled = false;
    const hook = createTaskStopHook({
      hasSignal: async () => signaled,
      isAborted: () => false,
    });
    const first = await hook(idleStop());
    expect(first).toEqual({
      decision: 'block',
      reason: expect.stringContaining('frink_task_signal'),
    });
    signaled = true;
    expect(await hook(idleStop())).toEqual({});
  });

  it('blocks on the first invocation when async hasSignal resolves false', async () => {
    const hook = createTaskStopHook({
      hasSignal: async () => false,
      isAborted: () => false,
    });
    expect((await hook(idleStop())) as object).toMatchObject({ decision: 'block' });
  });

  it('allows stop after default maxRetries when async hasSignal stays false', async () => {
    const hook = createTaskStopHook({
      hasSignal: async () => false,
      isAborted: () => false,
    });
    await hook(idleStop());
    await hook(idleStop());
    expect(await hook(idleStop())).toEqual({});
  });

  it('does not consume retries while aborted when hasSignal is async (retries preserved)', async () => {
    let aborted = true;
    const hook = createTaskStopHook({
      hasSignal: async () => false,
      isAborted: () => aborted,
      maxRetries: 1,
    });
    await hook(idleStop());
    await hook(idleStop());
    aborted = false;
    expect((await hook(idleStop())) as object).toMatchObject({ decision: 'block' });
    expect(await hook(idleStop())).toEqual({});
  });

  // ── Retry logic (no abort, no signal) ───────────────────────────────────

  it('blocks on the first invocation when signal has not been called', async () => {
    const hook = createTaskStopHook({
      hasSignal: () => false,
      isAborted: () => false,
    });
    const result = await hook(idleStop());
    expect(result).toEqual({
      decision: 'block',
      reason: expect.stringContaining('frink_task_signal'),
    });
  });

  it('blocks on the second invocation when signal still not called', async () => {
    const hook = createTaskStopHook({
      hasSignal: () => false,
      isAborted: () => false,
    });
    await hook(idleStop()); // retry 1
    const result = await hook(idleStop()); // retry 2
    expect(result).toEqual({
      decision: 'block',
      reason: expect.stringContaining('frink_task_signal'),
    });
  });

  it('allows stop after default max retries are exhausted (prevents infinite loop)', async () => {
    const hook = createTaskStopHook({
      hasSignal: () => false,
      isAborted: () => false,
    });
    await hook(idleStop()); // retry 1
    await hook(idleStop()); // retry 2 — default maxRetries is 2
    expect(await hook(idleStop())).toEqual({});
  });

  it('respects a custom maxRetries of 1', async () => {
    const hook = createTaskStopHook({
      hasSignal: () => false,
      isAborted: () => false,
      maxRetries: 1,
    });
    expect((await hook(idleStop())) as object).toMatchObject({ decision: 'block' }); // retry 1
    expect(await hook(idleStop())).toEqual({}); // retries >= 1 → allow stop
  });

  // ── Abort / cancel ───────────────────────────────────────────────────────
  //
  // Edge case 2: the inline closures in claude.ts and executor.ts previously
  // had NO abort check, meaning a user-cancelled run would still trigger up to
  // 2 forced-continuation turns, wasting tokens. This factory fixes that.

  it('allows stop immediately when the abort controller has fired', async () => {
    const hook = createTaskStopHook({
      hasSignal: () => false,
      isAborted: () => true,
    });
    expect(await hook(idleStop())).toEqual({});
  });

  it('does not invoke hasSignal when aborted (short-circuit before async lookup)', async () => {
    const hasSignal = vi.fn(() => Promise.resolve(false));
    const hook = createTaskStopHook({
      hasSignal,
      isAborted: () => true,
    });
    await hook(idleStop());
    expect(hasSignal).not.toHaveBeenCalled();
  });

  it('does not invoke hasSignal when retry budget is exhausted before async lookup', async () => {
    const hasSignal = vi.fn(() => false);
    const hook = createTaskStopHook({
      hasSignal,
      isAborted: () => false,
      maxRetries: 2,
    });
    await hook(idleStop());
    await hook(idleStop());
    hasSignal.mockClear();
    await hook(idleStop());
    expect(hasSignal).not.toHaveBeenCalled();
  });

  it('allows stop when aborted after async hasSignal yields (re-check after await)', async () => {
    let aborted = false;
    const hook = createTaskStopHook({
      hasSignal: async () => {
        await Promise.resolve();
        return false;
      },
      isAborted: () => aborted,
    });
    const p = hook(idleStop());
    aborted = true;
    expect(await p).toEqual({});
  });

  it('does not consume retries while aborted (retries are preserved)', async () => {
    let aborted = true;
    const hook = createTaskStopHook({
      hasSignal: () => false,
      isAborted: () => aborted,
      maxRetries: 1,
    });
    // Aborted: two invocations, neither consumes a retry
    await hook(idleStop());
    await hook(idleStop());
    // Abort clears (edge case: temporary abort)
    aborted = false;
    // Retry budget is still intact → should block once
    expect((await hook(idleStop())) as object).toMatchObject({ decision: 'block' });
    expect(await hook(idleStop())).toEqual({}); // maxRetries=1 exhausted
  });

  // ── Follow-up message behavior (Edge Case 3) ─────────────────────────────
  //
  // In claude.ts, hasExplicitTaskSignal resets to false on each sendMessage call,
  // so each follow-up message in a task-linked chat creates a fresh hook with
  // hasSignal returning false. This means the Stop hook fires for EVERY turn,
  // not just the initial task execution message.
  // This test documents that expected (if surprising) behavior.

  it('fires on every independent turn because each sendMessage creates a fresh hook', async () => {
    // Simulates message 1: fresh hook with no signal yet
    const hookMsg1 = createTaskStopHook({ hasSignal: () => false, isAborted: () => false });
    expect((await hookMsg1(idleStop())) as object).toMatchObject({ decision: 'block' });

    // Simulates message 2 (follow-up): another fresh hook with no signal yet
    const hookMsg2 = createTaskStopHook({ hasSignal: () => false, isAborted: () => false });
    expect((await hookMsg2(idleStop())) as object).toMatchObject({ decision: 'block' });
  });

  // ── onAllow (streaming-input-queue close hook) ──────────────────────────
  //
  // The executor closes the CLI's stdin (permission control channel) via onAllow, which must fire
  // ONLY when the hook allows the stop — i.e. AFTER any forced frink_task_signal round-trip — so the
  // mandatory signal never lands on an already-closed channel ("Stream closed" bug).

  it('fires onAllow when the signal is already present', async () => {
    const onAllow = vi.fn();
    const hook = createTaskStopHook({ hasSignal: () => true, isAborted: () => false, onAllow });
    expect(await hook(idleStop())).toEqual({});
    expect(onAllow).toHaveBeenCalledTimes(1);
  });

  it('does NOT fire onAllow on a block, then fires it once the signal arrives', async () => {
    const onAllow = vi.fn();
    let signaled = false;
    const hook = createTaskStopHook({
      hasSignal: () => signaled,
      isAborted: () => false,
      onAllow,
    });
    expect((await hook(idleStop())) as object).toMatchObject({ decision: 'block' });
    expect(onAllow).not.toHaveBeenCalled(); // turn continues — channel must stay open for the forced signal
    signaled = true;
    expect(await hook(idleStop())).toEqual({});
    expect(onAllow).toHaveBeenCalledTimes(1); // allowed only after the signal — safe to close now
  });

  it('fires onAllow when retries are exhausted without a signal', async () => {
    const onAllow = vi.fn();
    const hook = createTaskStopHook({
      hasSignal: () => false,
      isAborted: () => false,
      maxRetries: 2,
      onAllow,
    });
    await hook(idleStop()); // retry 1 — block
    await hook(idleStop()); // retry 2 — block
    expect(onAllow).not.toHaveBeenCalled();
    expect(await hook(idleStop())).toEqual({}); // exhausted → allow
    expect(onAllow).toHaveBeenCalledTimes(1);
  });

  it('fires onAllow immediately when aborted', async () => {
    const onAllow = vi.fn();
    const hook = createTaskStopHook({ hasSignal: () => false, isAborted: () => true, onAllow });
    expect(await hook(idleStop())).toEqual({});
    expect(onAllow).toHaveBeenCalledTimes(1);
  });

  // ── reset() (per executor-retry budget restore) ─────────────────────────
  //
  // The executor reuses one hook across resume/api-error retries. Without a reset, an attempt that
  // exhausted its retries then hit a transient error would carry a spent budget into the retry —
  // allowing (and, via onAllow, closing the retry's input queue) on the very first call, bypassing
  // the mandatory signal. reset() restores the budget so each fresh attempt forces the signal again.
  it('restores the retry budget after reset() so a reused hook forces the signal again', async () => {
    const onAllow = vi.fn();
    const hook = createTaskStopHook({ hasSignal: () => false, isAborted: () => false, onAllow });
    await hook(idleStop()); // retry 1 — block
    await hook(idleStop()); // retry 2 — block
    expect(await hook(idleStop())).toEqual({}); // exhausted → allow (+onAllow)
    expect(onAllow).toHaveBeenCalledTimes(1);

    hook.reset(); // new executor attempt: fresh budget

    expect((await hook(idleStop())) as object).toMatchObject({ decision: 'block' }); // forces the signal again
    expect(onAllow).toHaveBeenCalledTimes(1); // no premature allow/close on the retry's first call
  });

  // ── Pending harness work (machine wait) ─────────────────────────────────
  //
  // A stop while background tasks / session crons are in flight is a legitimate machine wait
  // (docs/decisions/flow-quiet-wait-handling.md): the harness wakes the model when the work
  // settles, so the hook must never coerce a signal. onAllow still runs — its quiet-end mark is
  // the park sweep's inactivity timestamp, refreshed by every wake turn's own stop.

  const bgTask = { id: 't1', type: 'shell', status: 'running', description: 'coverage run' };
  const cron = { id: 'c1' };

  it('allows a stop with pending background tasks without coercion or consuming a retry', async () => {
    const onAllow = vi.fn();
    const hasSignal = vi.fn(() => false);
    const hook = createTaskStopHook({ hasSignal, isAborted: () => false, maxRetries: 2, onAllow });

    expect(await hook(stopInput({ background_tasks: [bgTask] }))).toEqual({});
    expect(onAllow).toHaveBeenCalledTimes(1); // inactivity timestamp still marks
    expect(hasSignal).not.toHaveBeenCalled(); // a machine wait is never coerced into a signal

    // The wait consumed no retry: a later no-pending stop still gets the full budget.
    expect((await hook(idleStop())) as object).toMatchObject({ decision: 'block' });
    expect((await hook(idleStop())) as object).toMatchObject({ decision: 'block' });
    expect(await hook(idleStop())).toEqual({});
  });

  it('treats background subagents as pending work', async () => {
    // A turn that launched background research agents and stopped to wait: the subagent-typed
    // entries must survive readPendingWork (never judged by the shell-only dead-follower rule)
    // and allow without coercion, so the executor can arm the wake pump on them.
    const agents = [
      { id: 'a1', type: 'subagent', status: 'running', description: 'Explore settings UI' },
      { id: 'a2', type: 'subagent', status: 'running', description: 'Explore usage data' },
    ];
    const hasSignal = vi.fn(() => false);
    const hook = createTaskStopHook({ hasSignal, isAborted: () => false });

    expect(await hook(stopInput({ background_tasks: agents }))).toEqual({});
    expect(hasSignal).not.toHaveBeenCalled();
    expect(hook.lastPendingWork).toEqual({ backgroundTasks: agents, sessionCrons: [] });
  });

  it('treats pending session crons (ScheduleWakeup) the same as background tasks', async () => {
    const hasSignal = vi.fn(() => false);
    const hook = createTaskStopHook({ hasSignal, isAborted: () => false });
    expect(await hook(stopInput({ session_crons: [cron] }))).toEqual({});
    expect(hasSignal).not.toHaveBeenCalled();
    expect(hook.lastPendingWork).toEqual({ backgroundTasks: [], sessionCrons: [cron] });
  });

  it('exposes the pending work on lastPendingWork and clears it on an idle stop and on reset', async () => {
    const hook = createTaskStopHook({ hasSignal: () => true, isAborted: () => false });
    await hook(stopInput({ background_tasks: [bgTask], session_crons: [cron] }));
    expect(hook.lastPendingWork).toEqual({ backgroundTasks: [bgTask], sessionCrons: [cron] });

    await hook(stopInput({ background_tasks: [], session_crons: [] }));
    expect(hook.lastPendingWork).toBeNull();
    expect(hook.stoppedSinceReset).toBe(true); // nothing pending, unlike no Stop at all

    await hook(stopInput({ background_tasks: [bgTask] }));
    hook.reset();
    expect(hook.lastPendingWork).toBeNull();
    expect(hook.stoppedSinceReset).toBe(false);
  });

  it('abort wins over pending work: allows with onAllow', async () => {
    const onAllow = vi.fn();
    const hook = createTaskStopHook({ hasSignal: () => false, isAborted: () => true, onAllow });
    expect(await hook(stopInput({ background_tasks: [bgTask] }))).toEqual({});
    expect(onAllow).toHaveBeenCalledTimes(1);
  });

  // ── Dead followers ───────────────────────────────────────────────────────
  // `tail -f <other-task>.output | grep …` is what an agent reaches for to narrate a long run, and
  // `tail -f` never exits — so once the run it watched finishes, the follower stays `running` and
  // keeps the chat waiting on nothing. The command names the ids it follows, so this is decidable
  // from the harness's own list rather than guessed from a status.

  // Anchored on THIS session's id, which is what scopes the rule to the harness's own sandbox.
  const TASKS_DIR = `/tmp/claude-501/-Users-x-repo/${SESSION}/tasks`;
  const shell = (id: string, command: string) =>
    ({ id, type: 'shell', status: 'running', description: '', command }) as never;
  const follower = (id: string, watchedId: string) =>
    shell(id, `tail -f ${TASKS_DIR}/${watchedId}.output | grep -E --line-buffered "gate|FAILED"`);

  const pendingAfter = async (tasks: unknown[]) => {
    const hook = createTaskStopHook({ hasSignal: () => true, isAborted: () => false });
    await hook(stopInput({ background_tasks: tasks }));
    return hook.lastPendingWork;
  };

  it('drops a follower whose watched task has finished, flagging it for the session end', async () => {
    const hook = createTaskStopHook({ hasSignal: () => true, isAborted: () => false });
    await hook(stopInput({ background_tasks: [follower('tail1', 'ship9')] }));
    expect(hook.lastPendingWork).toBeNull();
    expect(hook.droppedFollower).toBe(true);

    await hook(stopInput({ background_tasks: [shell('ship9', 'devkit ship --pr')] }));
    expect(hook.droppedFollower).toBe(false);
  });

  it('drops the observed real-world follower verbatim', async () => {
    // Captured from a chat that advertised a wait for 28 minutes after its ship had finished.
    const observed = shell(
      'bfd3yr61g',
      'tail -f /private/tmp/claude-501/-Users-benji--frink-worktrees-frink-usual-cove/' +
        '8356fc65-d823-4d80-b661-e22ad5c8a352/tasks/bpji7n21g.output | ' +
        'grep -E --line-buffered "Coverage gate|pre-commit script failed|files changed|fatal"',
    );
    expect(await pendingAfter([observed])).toBeNull();
  });

  it('keeps a follower while the task it watches is still running', async () => {
    const live = shell('ship9', 'devkit ship --pr');
    expect(await pendingAfter([follower('tail1', 'ship9'), live])).toEqual({
      backgroundTasks: [follower('tail1', 'ship9'), live],
      sessionCrons: [],
    });
  });

  it('drops every dead follower but leaves unrelated live work waiting', async () => {
    // The reported shape: three abandoned followers stacked up beside one real command.
    const real = shell('qavis1', 'qavis qa --diff origin/main');
    const pending = await pendingAfter([
      follower('t1', 'gone1'),
      follower('t2', 'gone2'),
      real,
      follower('t3', 'gone3'),
    ]);
    expect(pending?.backgroundTasks).toEqual([real]);
  });

  it('keeps a follower watching several tasks while any one of them lives', async () => {
    const live = shell('live1', 'bun run build');
    const multi = shell('tail1', `tail -f ${TASKS_DIR}/gone1.output ${TASKS_DIR}/live1.output`);
    expect((await pendingAfter([multi, live]))?.backgroundTasks).toEqual([multi, live]);
  });

  it('keeps a reader that exits on its own, even when its task is gone', async () => {
    // `cat`/`grep` reach EOF and leave the list without help — only an endless follow is the leak.
    const reader = shell('r1', `grep -c FAILED ${TASKS_DIR}/gone1.output`);
    expect((await pendingAfter([reader]))?.backgroundTasks).toEqual([reader]);
  });

  it('keeps a tail that follows something other than a task output file', async () => {
    const appLog = shell('t1', 'tail -f /var/log/app.log');
    expect((await pendingAfter([appLog]))?.backgroundTasks).toEqual([appLog]);
  });

  it('keeps a command whose follow target is unrelated to the finished task it also names', async () => {
    // The follow flag and the task-output path must be CORRELATED, not merely both present: this
    // tails a live log and separately reads a dead task's output, so its tail outlives nothing.
    const mixed = shell('t1', `tail -f /var/log/app.log & cat ${TASKS_DIR}/gone1.output`);
    expect((await pendingAfter([mixed]))?.backgroundTasks).toEqual([mixed]);
  });

  it('keeps a follower that also tails a path this rule cannot account for', async () => {
    const partly = shell('t1', `tail -f ${TASKS_DIR}/gone1.output /var/log/app.log`);
    expect((await pendingAfter([partly]))?.backgroundTasks).toEqual([partly]);
  });

  it("keeps a tail on a repo's own tasks/ directory", async () => {
    // A project may have a directory literally called `tasks`. Only the harness's own
    // `<session-id>/tasks/` layout is a task output; anything else is an ordinary file being watched.
    const projectTail = shell('t1', 'tail -f tasks/build.output');
    expect((await pendingAfter([projectTail]))?.backgroundTasks).toEqual([projectTail]);
  });

  it("keeps a tail on ANOTHER session's task output", async () => {
    const other = shell(
      't1',
      `tail -f /tmp/claude-501/-Users-x-repo/${'a'.repeat(8)}/tasks/x.output`,
    );
    expect((await pendingAfter([other]))?.backgroundTasks).toEqual([other]);
  });

  it('keeps a dead follower chained to an independent command that is still running', async () => {
    // Dropping this would end the wait under the `sleep`, which is exactly the work a wait is for.
    const chained = shell('t1', `tail -f ${TASKS_DIR}/gone1.output & sleep 600`);
    expect((await pendingAfter([chained]))?.backgroundTasks).toEqual([chained]);
  });

  it.each([';', '&&', '||', '&'])(
    'keeps anything joined by `%s`, which can leave a second command running',
    async (sep) => {
      const chained = shell('t1', `tail -f ${TASKS_DIR}/gone1.output ${sep} bun run build`);
      expect((await pendingAfter([chained]))?.backgroundTasks).toEqual([chained]);
    },
  );

  it('keeps two dead followers chained together, since the chain itself is unjudgeable', async () => {
    // Both halves happen to be dead, but the rule recognises one pipeline and nothing else — an
    // unrecognised shape stays, rather than being reasoned about case by case.
    const both = shell(
      't1',
      `tail -f ${TASKS_DIR}/gone1.output | grep x & tail -f ${TASKS_DIR}/gone2.output`,
    );
    expect((await pendingAfter([both]))?.backgroundTasks).toEqual([both]);
  });

  it('keeps a redirect and a quoted `>` in the filter, which cannot outlive the tail', async () => {
    // The real observed follower greps for "-> benjinorval"; disqualifying `>` would miss it.
    const quoted = shell('t1', `tail -f ${TASKS_DIR}/gone1.output | grep -E "push OK|-> benji"`);
    expect(await pendingAfter([quoted])).toBeNull();
  });

  it('still drops a follower piped through several consumers', async () => {
    // Everything downstream of the tail exits when its stdin closes, so the pipeline is one unit.
    const piped = shell('t1', `tail -f ${TASKS_DIR}/gone1.output | grep -E "x" | head -5`);
    expect(await pendingAfter([piped])).toBeNull();
  });

  it('keeps a non-shell task whose description happens to name a finished task', async () => {
    // command is shell-only; a monitor or subagent must never be judged by this rule.
    const monitor = {
      id: 'm1',
      type: 'monitor',
      status: 'running',
      description: `tail -f ${TASKS_DIR}/gone1.output`,
    } as never;
    expect((await pendingAfter([monitor]))?.backgroundTasks).toEqual([monitor]);
  });

  it('keeps a cron pending even when every background task was a dead follower', async () => {
    const hook = createTaskStopHook({ hasSignal: () => true, isAborted: () => false });
    await hook(stopInput({ background_tasks: [follower('t1', 'gone1')], session_crons: [cron] }));
    expect(hook.lastPendingWork).toEqual({ backgroundTasks: [], sessionCrons: [cron] });
  });
});
