import { useAtomValue } from 'jotai';
import { useMemo } from 'react';
import { aiProvider } from '../../../shared/lib/ai-providers';
import { hiddenModelsAtom } from '../atoms';
import { useCodexAccountCatalog } from '../codex/use-codex-account-catalog';
import { trpc } from '../trpc';
import { providerModels } from './chat-options';

/** Before an agent's first turn its list is empty; poll until it arrives, then refresh on focus. */
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
      enabled: row?.runtime === 'acp',
      refetchOnWindowFocus: true,
      refetchInterval: (query) => (query.state.data?.length ? false : AGENT_MODELS_POLL_MS),
    },
  );
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
