import { deepTransformKeys, toCamelKey } from '../../../shared/lib/case-converter';

/**
 * Walks a tRPC procedure result's `data` field and rewrites snake_case keys
 * to camelCase before serialization to the renderer.
 *
 * Designed for use inside a `t.middleware(...)` wrapper in trpc/index.ts.
 *
 * Subscriptions BYPASS this transform — trpc-electron iterates emitted
 * observable values outside the procedure middleware chain. Current
 * subscriptions (`terminal.stream`) emit already-camelCase shapes today.
 * If a future subscription emits DB-row shapes, convert at the emit site.
 *
 * Adapted from axios-case-converter (MIT). See
 * `src/shared/lib/case-converter/NOTICE.md`.
 */
export function transformResultDataToCamelCase<T>(data: T): T {
  return deepTransformKeys(data, toCamelKey);
}
