import { useAtomValue } from 'jotai';
import { useEffect, useMemo } from 'react';
import { aiProvider, isInstalledAgent } from '../../../shared/lib/ai-providers';
import { hiddenModelsAtom } from '../atoms';
import { useCodexAccountCatalog } from '../codex/use-codex-account-catalog';
import { trpc } from '../trpc';
import { providerModels } from './chat-options';

/** Poll an agent's empty list until its first turn fills it; later turns and focus refresh it. */
const AGENT_MODELS_POLL_MS = 3000;

/** The model picker for a chat on `providerId`, with `modelId` saved; also the Codex catalog. */
export function useProviderModels(
  providerId: string | null | undefined,
  modelId: string,
  { keepUnavailable = false }: { keepUnavailable?: boolean } = {},
) {
  const row = aiProvider(providerId);
  const hiddenFamilies = useAtomValue(hiddenModelsAtom);
  const codexCatalog = useCodexAccountCatalog(row?.runtime === 'codex');
  const { data: agentModels } = trpc.agentAccounts.models.useQuery(
    { type: row?.id ?? '' },
    {
      enabled: isInstalledAgent(row),
      refetchOnWindowFocus: true,
      refetchInterval: (query) => (query.state.data?.length ? false : AGENT_MODELS_POLL_MS),
    },
  );
  const agentId = isInstalledAgent(row) ? row.id : undefined;
  const utils = trpc.useUtils();
  useEffect(() => {
    const api = window.desktopApi;
    if (!agentId || !api) return;
    // Each turn re-reads and stores the agent's models, so show the stored list after it ends.
    const refresh = () => void utils.agentAccounts.models.invalidate({ type: agentId });
    const cleanups = [api.onSocketExecuteComplete(refresh), api.onSocketError(refresh)];
    return () => cleanups.forEach((cleanup) => cleanup());
  }, [agentId, utils]);
  const models = useMemo(
    () =>
      providerModels(providerId, {
        modelId,
        hiddenFamilies,
        codexCatalog,
        agentModels,
        keepUnavailable,
      }),
    [providerId, modelId, hiddenFamilies, codexCatalog, agentModels, keepUnavailable],
  );
  return { ...models, codexCatalog };
}
