import type { ChildProcess } from 'node:child_process';
import type { Disposable, MessageConnection } from 'vscode-jsonrpc/node';

function describeExit(code: number | null, signal: NodeJS.Signals | null): string {
  if (signal) return `signal ${signal}`;
  if (code !== null) return `code ${code}`;
  return 'exit status unknown';
}

/**
 * Settle with `send()`, or reject as soon as the child errors, exits, closes stdout or breaks a
 * pipe: vscode-jsonrpc never rejects a pending request on close. Armed before `send` runs.
 */
export function rejectOnHandshakeFailure<T>(
  label: string,
  child: ChildProcess,
  connection: MessageConnection,
  send: () => Promise<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const subs: Disposable[] = [];
    const during = 'during the initialize handshake';
    const onChildError = (err: Error) =>
      fail(new Error(`${label} failed ${during}: ${err.message}`, { cause: err }));
    const onChildExit = (code: number | null, signal: NodeJS.Signals | null) =>
      fail(new Error(`${label} exited ${during} (${describeExit(code, signal)})`));

    function cleanup(): void {
      child.off('error', onChildError);
      child.off('exit', onChildExit);
      for (const sub of subs) sub.dispose();
    }
    function settle(apply: () => void): void {
      if (settled) return;
      settled = true;
      cleanup();
      apply();
    }
    function fail(err: Error): void {
      settle(() => reject(err));
    }

    child.on('error', onChildError);
    child.on('exit', onChildExit);
    subs.push(
      connection.onClose(() => {
        const status = describeExit(child.exitCode ?? null, child.signalCode ?? null);
        fail(new Error(`${label} closed its stdout ${during} (${status})`));
      }),
      connection.onError(([err]) =>
        fail(new Error(`${label} pipe failed ${during}: ${err.message}`, { cause: err })),
      ),
    );

    // A child that answers and then exits still rejects: it is dead either way.
    send().then(
      (value) => settle(() => resolve(value)),
      (err) => settle(() => reject(err)),
    );
  });
}
