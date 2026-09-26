/**
 * Type-level snake_case → camelCase key transform. Mirrors the runtime
 * behavior of `deepTransformKeys` so TypeScript can describe the shape
 * a payload has after passing through the tRPC `caseConvertOutput` middleware.
 *
 * Pattern:
 *   type RawDbFooRow = { user_id: string; created_at: string };
 *   export type DbFoo = CamelKeyed<RawDbFooRow>;
 *   //         ^? { userId: string; createdAt: string }
 *
 * Use at tRPC router return-type seams to give the renderer-facing client
 * camelCase types without writing parallel type defs or runtime mappers.
 *
 * Repos that build raw SQL keep their `RawX` snake-typed row signatures —
 * main-process internal consumers (executors, background flows) read the
 * honest snake shape. tRPC routers cast at the boundary:
 *
 *   .query(async (): Promise<DbFoo> => {
 *     const row = await getFoo();
 *     return row as unknown as DbFoo;
 *   })
 *
 * The `caseConvertOutput` middleware then rewrites keys at runtime.
 */

type CamelCase<S extends string> = S extends `${infer Head}_${infer Tail}`
  ? `${Head}${CamelCase<Capitalize<Tail>>}`
  : S;

type CamelKeyedObject<T> = {
  [K in keyof T as K extends string ? CamelCase<K> : K]: CamelKeyed<T[K]>;
};

export type CamelKeyed<T> = T extends Date | RegExp | Map<unknown, unknown> | Set<unknown>
  ? T
  : T extends Array<infer U>
    ? Array<CamelKeyed<U>>
    : T extends object
      ? CamelKeyedObject<T>
      : T;
