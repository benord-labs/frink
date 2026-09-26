import { Button, Input } from '@benord-labs/frink-primitives';
import { ChevronDown, ExternalLink, Eye, EyeOff } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { ClickupManualSetup } from '../ClickupSetup';
import { VendorSecretSetup } from '../VendorSecretSetup';
import { isImportedWebhookSecret } from '../../../../../../../shared/integrations/webhook-secret';
import { isTriggerRegistrationComplete } from '../../../../../../../shared/integrations/selectors';
import type { Provider } from '../../../../../../../shared/integrations/types';
import { CopyableInput } from '@/components/CopyableInput';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  vendorReference,
  vendorSecret,
  verifiesSecret,
  type TriggerEndpoint,
} from '@/lib/plugins/triggers/delivery-state';

type Props = {
  integrationId?: string;
  provider: Provider;
  endpoint: TriggerEndpoint;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children?: ReactNode;
  withManualSetup: boolean;
  /** A trigger a beginner still has to paste: the panel becomes the setup steps themselves. */
  setupMode?: boolean;
  rotating: boolean;
  deactivating: boolean;
  onRotate: () => void;
  onDeactivate: () => void;
};

/** Everything a working trigger folds away: its address, its secret, and how to take it down. */
export function AdvancedPanel({
  integrationId,
  provider,
  endpoint,
  open,
  onOpenChange,
  children,
  withManualSetup,
  setupMode = false,
  ...props
}: Props) {
  const clickup = provider.id === 'clickup';
  const importedSecret = provider.webhook_setup?.secret;
  const manualClickup = clickup && endpoint.vendorRef?.startsWith('manual:clickup:');
  const hasSecret =
    verifiesSecret(provider) &&
    !provider.webhook_verification &&
    (!clickup || isTriggerRegistrationComplete(endpoint.vendorRef)) &&
    (!importedSecret || isImportedWebhookSecret(provider, endpoint.vendorRef));
  const registered = isTriggerRegistrationComplete(endpoint.vendorRef);
  const awaitingAutomaticSetup = provider.subscription === 'auto' && !registered;
  const reference = registered ? vendorReference(provider, endpoint) : undefined;
  // Only a subscription Frink registered gets the rotated secret pushed; an auto row on its paste fallback is pasted like any other.
  const rotateNote = clickup
    ? manualClickup
      ? 'ClickUp generated this secret. Update it here if you replace the subscription in ClickUp.'
      : 'ClickUp generated this secret. Frink recreates the webhook in ClickUp when you rotate it.'
    : awaitingAutomaticSetup
      ? `Frink will set this secret in ${provider.display_name} when setup finishes.`
      : registered
        ? `Frink made this secret and updates it in ${provider.display_name} for you.`
        : `Frink made this secret. After rotating, paste the new one into ${provider.display_name}.`;
  // Rotating and deactivating are the only ways out of a wrong paste, so setup folds them away
  // rather than dropping them: they sit one click deeper until an event proves the setup worked.
  const maintenance = (
    <>
      {hasSecret && !importedSecret ? (
        <p className="text-muted-fg text-xs leading-relaxed">{rotateNote}</p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2 border-t border-border/60 pt-3">
        {hasSecret && !importedSecret && !manualClickup && !awaitingAutomaticSetup ? (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={props.onRotate}
            disabled={props.rotating}
          >
            Rotate secret
          </Button>
        ) : null}
        <Button
          type="button"
          variant="destructive"
          size="sm"
          onClick={props.onDeactivate}
          disabled={props.deactivating}
        >
          Deactivate trigger
        </Button>
      </div>
    </>
  );

  return (
    <Collapsible open={open} onOpenChange={onOpenChange} className="border-t border-border/60 pt-3">
      <CollapsibleTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="group h-8 w-full justify-between px-0 text-sm"
        >
          {/* The card heading above already says "Set up <Service> events"; this names what is inside. */}
          {setupMode ? 'Setup steps' : 'Advanced'}
          <ChevronDown
            className="size-4 text-muted-fg group-data-[state=open]:rotate-180"
            aria-hidden="true"
          />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-4 pb-1 pt-3">
        {withManualSetup && provider.webhook_setup ? (
          <div className="space-y-2">
            {setupMode ? null : <p className="text-sm font-medium">Manual setup</p>}
            <WebhookSetupInstructions provider={provider} />
          </div>
        ) : null}
        <CopyableInput
          value={endpoint.webhookUrl}
          label={setupMode ? 'Frink address' : 'Webhook address'}
        />
        {hasSecret ? (
          <EndpointSecret
            secret={vendorSecret(provider, endpoint.webhookSecret)}
            label={importedSecret?.label ?? 'Secret'}
          />
        ) : null}
        {children}
        {provider.webhook_payload?.signature === 'frink_hmac' ? (
          <p className="text-muted-fg text-xs">
            Sign the raw request body with HMAC-SHA256 using this secret and send X-Frink-Signature:
            sha256=&lt;hex&gt;. Unsigned requests are refused.
          </p>
        ) : null}
        {clickup && integrationId && (!endpoint.vendorRef || manualClickup) ? (
          <ClickupManualSetup
            integrationId={integrationId}
            webhookId={endpoint.id}
            vendorRef={endpoint.vendorRef}
          />
        ) : null}
        {importedSecret && integrationId ? (
          <VendorSecretSetup
            integrationId={integrationId}
            webhookId={endpoint.id}
            provider={provider}
            vendorRef={endpoint.vendorRef}
          />
        ) : null}
        {manualClickup ? (
          <p className="text-xs text-muted-fg">
            Deactivating stops events in Frink. Delete the webhook in ClickUp yourself.
          </p>
        ) : null}
        {reference ? (
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-fg text-xs">
            <span className="min-w-0 break-all">{reference.label}</span>
            {reference.url ? (
              <a
                className="shrink-0 underline underline-offset-4"
                href={reference.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open in {provider.display_name}
                <ExternalLink className="ml-1 inline h-3 w-3" aria-hidden="true" />
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
            ) : null}
          </p>
        ) : null}
        {setupMode ? (
          <Collapsible className="border-t border-border/60 pt-3">
            <CollapsibleTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="group h-8 w-full justify-between px-0 text-sm"
              >
                Advanced
                <ChevronDown
                  className="size-4 text-muted-fg group-data-[state=open]:rotate-180"
                  aria-hidden="true"
                />
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="space-y-4 pt-3">{maintenance}</CollapsibleContent>
          </Collapsible>
        ) : (
          maintenance
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

/** Provider instructions are shared by manual setup and the optional Advanced path. */
function WebhookSetupInstructions({ provider }: { provider: Provider }) {
  const setup = provider.webhook_setup;
  if (!setup) return null;
  return (
    <>
      <ol className="list-decimal space-y-1 pl-5 text-muted-fg text-xs">
        {setup.steps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      <Button variant="secondary" size="sm" asChild>
        <a href={setup.url} target="_blank" rel="noopener noreferrer">
          <ExternalLink className="mr-2 h-3 w-3" aria-hidden="true" />
          Open {provider.display_name}
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
      </Button>
    </>
  );
}

/** The endpoint's signing secret, masked until revealed. */
export function EndpointSecret({ secret, label = 'Secret' }: { secret: string; label?: string }) {
  const [revealed, setRevealed] = useState(false);
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <p className="text-muted-fg text-xs">{label}</p>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs"
          onClick={() => setRevealed((previous) => !previous)}
        >
          {revealed ? (
            <>
              <EyeOff className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
              Hide
            </>
          ) : (
            <>
              <Eye className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
              Reveal
            </>
          )}
        </Button>
      </div>
      {revealed ? (
        <CopyableInput value={secret} aria-label={label} />
      ) : (
        <Input
          value={'*'.repeat(12)}
          readOnly
          aria-label={`${label}, hidden`}
          className="font-mono text-xs"
        />
      )}
    </div>
  );
}
