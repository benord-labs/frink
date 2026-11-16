import { type Operation, type TRPCLink, TRPCClientError } from '@trpc/client';
import type { AnyRouter } from '@trpc/server';
import { observable } from '@trpc/server/observable';

/** A tRPC link answered in-process: `answer` resolves each operation the way the main-process router would. */
export function inProcessTrpcLink<TRouter extends AnyRouter, TResult>(
  answer: (op: Operation) => Promise<TResult>,
): TRPCLink<TRouter> {
  return () =>
    ({ op }) =>
      observable((observer) => {
        answer(op).then(
          (data) => {
            observer.next({ result: { data } });
            observer.complete();
          },
          (err) => observer.error(TRPCClientError.from(err)),
        );
      });
}
