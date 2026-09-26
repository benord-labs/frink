/** The database owns the lease; async context merely carries it to existing request boundaries. */
import { AsyncLocalStorage } from 'node:async_hooks';

/** Which database holds the lease is the holder's business; renewing it is all this needs. */
type Operation = { operationId: string; renew: () => Promise<void> };
const currentOperation = new AsyncLocalStorage<Operation>();

/** An unconfirmed operation must never be treated as an ordinary vendor refusal. */
export class TriggerOperationError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'TriggerOperationError';
  }
}

export function triggerOperationRequiresRetry(error: Error | string): boolean {
  return error instanceof TriggerOperationError;
}

/** Renew immediately before each vendor request. A stale holder cannot start another request. */
export async function beforeTriggerVendorRequest(): Promise<void> {
  const operation = currentOperation.getStore();
  if (!operation) return; // Direct adapter unit tests and read-only setup discovery hold no lease.
  await operation.renew().catch((error) => {
    throw new TriggerOperationError(error);
  });
}

/** Run the vendor exchange inside the lease every request underneath it renews against. */
export function withOperationScope<T>(operation: Operation, run: () => Promise<T>): Promise<T> {
  return currentOperation.run(operation, run);
}
