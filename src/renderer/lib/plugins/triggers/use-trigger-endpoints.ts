import { trpc } from '../../trpc';
import type { TriggerEndpoint } from './delivery-state';

/** One account's endpoint rows and the actions the trigger card offers on them; every action refetches the rows. */
export function useTriggerEndpoints(integrationId: string) {
  const query = trpc.integrations.listWebhookEndpoints.useQuery(
    { integrationId },
    { enabled: integrationId !== '' },
  );
  const refresh = async () => {
    await query.refetch();
  };
  const retry = trpc.integrations.retryWebhookEndpoint.useMutation({ onSettled: refresh });
  const create = trpc.integrations.generateWebhookEndpoint.useMutation({ onSuccess: refresh });
  const rotateEndpoint = trpc.integrations.rotateWebhookEndpoint.useMutation({
    onSuccess: refresh,
  });
  const deactivate = trpc.integrations.deactivateWebhookEndpoint.useMutation({
    onSuccess: refresh,
  });

  const data = query.data?.success ? query.data : undefined;
  const endpoints: ReadonlyArray<TriggerEndpoint> = data?.endpoints ?? [];

  return {
    isLoading: query.isLoading,
    endpoints,
    create: () => create.mutate({ integrationId }),
    creating: create.isPending,
    createError:
      create.error?.message ?? (create.data?.success === false ? create.data.error : undefined),
    retry: (webhookId: string) => retry.mutate({ integrationId, webhookId }),
    retrying: retry.isPending,
    retryError: retry.error?.message,
    rotate: (webhookId: string) => rotateEndpoint.mutate({ integrationId, webhookId }),
    rotating: rotateEndpoint.isPending,
    deactivate: (webhookId: string) => deactivate.mutate({ integrationId, webhookId }),
    deactivating: deactivate.isPending,
  };
}
