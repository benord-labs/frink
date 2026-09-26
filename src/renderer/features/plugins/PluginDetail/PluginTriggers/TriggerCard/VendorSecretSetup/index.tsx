import { Button, Input } from '@benord-labs/frink-primitives';
import { useId, useState } from 'react';
import type { Provider } from '../../../../../../../shared/integrations/types';
import { isImportedWebhookSecret } from '../../../../../../../shared/integrations/webhook-secret';
import { trpc } from '@/lib/trpc';

/** Import a vendor-issued signing key; every provider uses the same setup form. */
export function VendorSecretSetup({
  integrationId,
  webhookId,
  vendorRef,
  provider,
}: {
  provider: Provider;
  integrationId: string;
  webhookId: string;
  vendorRef?: string | null;
}) {
  const details = provider.webhook_setup?.secret;
  const label = details?.label ?? 'Secret';
  const [secret, setSecret] = useState('');
  const id = useId();
  const utils = trpc.useUtils();
  const save = trpc.triggerSetup.importVendorWebhook.useMutation({
    onSuccess: () => {
      setSecret('');
      void utils.integrations.listWebhookEndpoints.invalidate({
        integrationId,
      });
      void utils.integrations.list.invalidate();
    },
  });
  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate({ integrationId, webhookId, secret: secret.trim() });
      }}
    >
      <p className="text-xs text-muted-fg">{details?.instructions}</p>
      <label htmlFor={id} className="block space-y-1 text-xs">
        <span>
          {provider.display_name} {label.toLowerCase()}
        </span>
        <Input
          id={id}
          type="password"
          autoComplete="off"
          value={secret}
          disabled={save.isPending}
          onChange={(event) => setSecret(event.target.value)}
        />
      </label>
      {save.error ? (
        <p role="alert" className="text-xs text-destructive">
          {save.error.message}
        </p>
      ) : null}
      <Button
        type="submit"
        size="sm"
        variant="secondary"
        loading={save.isPending}
        disabled={!secret.trim()}
      >
        {isImportedWebhookSecret(provider, vendorRef) ? 'Update' : 'Save'} {label.toLowerCase()}
      </Button>
    </form>
  );
}
