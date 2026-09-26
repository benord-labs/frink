import { Button } from '@benord-labs/frink-primitives';
import { useEffect, useState } from 'react';
import type { ResolvedPlugin } from '../../../../../shared/integrations/plugins';
import { getProviderById } from '../../../../../shared/integrations/selectors';
import { setupCtaLabel } from '@/lib/plugins/triggers/delivery-state';
import type { WebhookEndpointSetup } from '@/lib/plugins/use-webhook-endpoint-setup';
import { TriggerCard } from './TriggerCard';
import { REFERENCE_HEADING } from '../../PluginCapabilitySection';

/** How the vendor reaches Frink: the same card per live account whichever way the subscription is made.
 * Nothing renders without a live account, except the offer to mint one where the provider has none. */
export function PluginTriggers({
  plugin,
  endpointSetup,
  onRetrySetup,
  retryingSetup,
}: {
  plugin: ResolvedPlugin;
  endpointSetup?: WebhookEndpointSetup;
  onRetrySetup?: () => void;
  retryingSetup?: boolean;
}) {
  const [startedPlugin, setStartedPlugin] = useState<string | null>(null);
  const provider = getProviderById(plugin.definition.id);
  const accounts = plugin.connections.filter((connection) => connection.isActive);
  const offerEndpoint = accounts.length === 0 && endpointSetup?.offered === true;
  // The click is carried to the account it creates, and no further: the first card to mount
  // reads the latch while it renders, so every account added later opens closed.
  useEffect(() => {
    if (accounts.length > 0) setStartedPlugin(null);
  }, [accounts.length]);
  if (!provider) return null;
  if (accounts.length === 0 && !offerEndpoint) return null;

  const name = plugin.definition.name;
  return (
    <section className="mt-7">
      <h2 className={REFERENCE_HEADING}>Triggers</h2>
      {offerEndpoint && endpointSetup ? (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-md border border-border/70 glass-card px-4 py-3">
          <p className="max-w-[52ch] text-muted-fg text-sm">
            {provider.subscription === 'paste_url'
              ? `Let ${name} tell Frink when something happens: Frink makes a secret address for you to paste into ${name}.`
              : `Let ${name} tell Frink when something happens — Frink can set that up in ${name} for you.`}
          </p>
          <Button
            size="sm"
            loading={endpointSetup.isPending}
            onClick={() => {
              setStartedPlugin(plugin.definition.id);
              void endpointSetup.create();
            }}
          >
            {setupCtaLabel(provider)}
          </Button>
        </div>
      ) : (
        <div className="mt-3 space-y-4">
          {accounts.map((account) => (
            <div key={account.id}>
              {accounts.length > 1 ? (
                <p className="mb-2 text-muted-fg text-xs">
                  {account.accountIdentifier ?? account.accountName}
                </p>
              ) : null}
              <TriggerCard
                integrationId={account.id}
                provider={plugin.definition.id}
                initialSetupOpen={
                  startedPlugin === plugin.definition.id && provider.subscription === 'paste_url'
                }
                enabled={plugin.installationState !== 'disabled'}
                onRetrySetup={onRetrySetup}
                retryingSetup={retryingSetup}
              />
            </div>
          ))}
        </div>
      )}
      <p className="mt-3 text-dim text-xs">Frink must be open for triggers to run.</p>
    </section>
  );
}
