import type { ChildProcess } from 'node:child_process';

type CloseBarrierArmOptions = {
  forceKill?: () => void;
  forceKillDelayMs: number;
  timeoutMs: number;
  timeoutMessage: string;
};

/** Track a child through close, optional force-kill escalation, and a hard settlement timeout. */
export function createChildProcessCloseBarrier(child: ChildProcess): {
  settlement: Promise<void>;
  arm: (options: CloseBarrierArmOptions) => void;
} {
  let settled = child.exitCode != null || child.signalCode != null;
  let armed = false;
  let forceKillTimer: ReturnType<typeof setTimeout> | null = null;
  let settlementTimer: ReturnType<typeof setTimeout> | null = null;
  let resolveSettlement!: () => void;
  let rejectSettlement!: (error: Error) => void;
  const settlement = settled
    ? Promise.resolve()
    : new Promise<void>((resolve, reject) => {
        resolveSettlement = resolve;
        rejectSettlement = reject;
      });

  const cleanup = () => {
    if (forceKillTimer !== null) clearTimeout(forceKillTimer);
    if (settlementTimer !== null) clearTimeout(settlementTimer);
    forceKillTimer = null;
    settlementTimer = null;
    child.off('close', onClose);
  };
  const onClose = () => {
    if (settled) return;
    settled = true;
    cleanup();
    resolveSettlement();
  };

  if (!settled) child.once('close', onClose);
  // A legacy caller may not await settlement; Flow cleanup still awaits the original promise.
  void settlement.catch(() => {});

  return {
    settlement,
    arm: ({ forceKill, forceKillDelayMs, timeoutMs, timeoutMessage }) => {
      if (settled || armed) return;
      armed = true;
      if (forceKill) {
        forceKillTimer = setTimeout(() => {
          forceKillTimer = null;
          if (!settled) forceKill();
        }, forceKillDelayMs);
        forceKillTimer.unref?.();
      }
      settlementTimer = setTimeout(() => {
        settlementTimer = null;
        if (settled) return;
        settled = true;
        cleanup();
        rejectSettlement(new Error(timeoutMessage));
      }, timeoutMs);
      settlementTimer.unref?.();
    },
  };
}
