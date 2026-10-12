import type { CodexAccountCatalog } from '../../../shared/lib/codex-cli-models';
import { trpc } from '../trpc';

/** The signed-in Codex account's models and paid speeds: `undefined` while loading, `null` once the
 *  read settles without a catalog (a failed read or query, or no Codex login). */
export function useCodexAccountCatalog(enabled: boolean): CodexAccountCatalog | null | undefined {
  const { data, isError } = trpc.usage.getCodexAccountCatalog.useQuery(undefined, {
    enabled,
    staleTime: 60_000,
  });
  return isError ? null : data;
}
