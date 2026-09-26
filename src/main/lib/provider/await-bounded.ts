/**
 * Await `work` for at most `timeoutMs`; resolve `true` if the deadline elapsed first.
 *
 * The deadline abandons the AWAIT, not the work — `work` keeps running and settles in
 * the background. A rejection BEFORE the deadline propagates to the caller; a rejection
 * AFTER it is suppressed here (the caller has moved on), so it can never surface as an
 * unhandled-rejection crash. The timer is unref'd (never holds the process open) and
 * always cleared.
 */
export async function awaitBounded(work: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  const settledFirst = work.then(() => false);
  settledFirst.catch(() => {}); // separate observer: a post-deadline rejection is not unhandled
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(true), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
  });
  try {
    return await Promise.race([settledFirst, timedOut]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
