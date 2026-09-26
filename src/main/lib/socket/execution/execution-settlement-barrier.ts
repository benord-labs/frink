interface ExecutionSettlementParticipant {
  wait: () => Promise<void>;
  finish: (error?: unknown) => void;
}

/** One outer execution plus any wake hold it transfers resources into. */
export interface ExecutionSettlementBarrier extends ExecutionSettlementParticipant {
  retain: () => ExecutionSettlementParticipant;
}

/**
 * Join cleanup owners without resolving early. Each retained participant receives an idempotent
 * finish callback, so competing teardown paths cannot underflow the barrier.
 */
export function createExecutionSettlementBarrier(): ExecutionSettlementBarrier {
  let participants = 1;
  let finished = false;
  const errors: unknown[] = [];
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  // A parking coordinator normally awaits this. Register immediately as well so a cleanup failure
  // outside that path cannot become an unhandled rejection.
  void promise.catch(() => {});
  let outerPending = true;

  const finishParticipant = (error?: unknown): void => {
    if (finished) return;
    if (error !== undefined) errors.push(error);
    participants -= 1;
    if (participants > 0) return;
    finished = true;
    if (errors.length > 1) reject(new AggregateError(errors, 'Execution cleanup failed'));
    else if (errors.length === 1) reject(errors[0]);
    else resolve();
  };
  const wait = (): Promise<void> => promise;

  return {
    wait,
    retain: () => {
      if (finished) throw new Error('Cannot retain a settled execution cleanup barrier');
      participants += 1;
      let retained = true;
      return {
        wait,
        finish: (error?: unknown) => {
          if (!retained) return;
          retained = false;
          finishParticipant(error);
        },
      };
    },
    finish: (error?: unknown) => {
      if (!outerPending) return;
      outerPending = false;
      finishParticipant(error);
    },
  };
}
