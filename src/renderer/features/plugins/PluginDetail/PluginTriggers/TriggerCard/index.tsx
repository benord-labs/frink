import { Button } from '@benord-labs/frink-primitives';
import { useState } from 'react';
import { isWebhookPluginId } from '../../../../../../shared/integrations/installable-plugins';
import { getProviderById } from '../../../../../../shared/integrations/selectors';
import type { EventSpec, Provider } from '../../../../../../shared/integrations/types';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  relayProblem,
  setupCtaLabel,
  triggerDelivery,
  type TriggerDelivery,
} from '@/lib/plugins/triggers/delivery-state';
import { useTriggerEndpoints } from '@/lib/plugins/triggers/use-trigger-endpoints';
import { useTriggerTest } from '@/lib/plugins/triggers/use-trigger-test';
import { trpc } from '@/lib/trpc';
import { AdvancedPanel } from './AdvancedPanel';
import { ApiTokenSetup } from './ApiTokenSetup';
import { NotionSetup } from './NotionSetup';
import { ResourceSetup } from './ResourceSetup';

type Props = {
  integrationId: string;
  provider: string;
  /** False while the plugin is turned off: the vendor still delivers and the machine drops it. */
  enabled: boolean;
  /** MCP-backed automatic setup reuses the page's consent lifecycle, including reconnect. */
  onRetrySetup?: () => void;
  retryingSetup?: boolean;
  /** Carry the first setup click across account/endpoint creation. */
  initialSetupOpen?: boolean;
};

/** One account's trigger in one card: whether the vendor can reach Frink, what it can start a Flow for,
 * a real test event, and under Advanced the address, secret and subscription. Same for every provider. */
export function TriggerCard({
  integrationId,
  provider,
  enabled,
  onRetrySetup,
  retryingSetup,
  initialSetupOpen = false,
}: Props) {
  const [setupView, setSetupView] = useState<{ integrationId: string; open: boolean } | null>(
    initialSetupOpen ? { integrationId, open: true } : null,
  );
  const meta = getProviderById(provider);
  const endpoints = useTriggerEndpoints(integrationId);
  // Polled: a relay can go down, or come back, while this page stays open, and the line below is
  // the only place either shows. One key, so every card on the page shares the one request.
  const relay = trpc.integrations.getTriggerRelay.useQuery(undefined, { refetchInterval: 10_000 });

  if (!meta) return null;
  if (endpoints.isLoading) {
    return <p className="text-muted-fg text-sm">Checking how {meta.display_name} reaches Frink…</p>;
  }

  const delivery = triggerDelivery({ provider: meta, endpoints: endpoints.endpoints, enabled });
  const active = delivery.endpoint;
  const endpointKey = `${integrationId}:${active?.id}`;
  const manual =
    (meta.subscription === 'paste_url' && !meta.webhook_verification) ||
    active?.vendorRef?.startsWith('manual:');
  // Setup stays unproved until an event lands: a pasted address is already "listening" without one.
  const setupMode =
    enabled && !!manual && (delivery.state === 'not_set_up' || !active?.lastReceivedAt);
  // A sample event runs matching Flows through Frink's own receiver, so it needs a working
  // endpoint, not proof that the vendor has the address yet.
  const canTest = enabled && delivery.state !== 'not_set_up';
  const ready = canTest && (!manual || !!active?.lastReceivedAt || !!meta.webhook_setup?.secret);
  const needsResources = meta.registrar?.setup === 'resources';
  const choosingResources =
    enabled && needsResources && active !== undefined && delivery.state === 'not_set_up' && !manual;
  const notion = meta.webhook_verification === 'notion';
  const tokenSetup = meta.registrar?.setup === 'api_token';
  // Connect mints the trigger account for webhook-only plugins and for any provider with a registrar
  // or owner verification; elsewhere only Set up events does, so an endpoint means setup started.
  const setupCreatesEndpoint =
    !meta.registrar && !meta.webhook_verification && !isWebhookPluginId(meta.id);
  const setupStarted =
    setupView?.integrationId === integrationId || (active !== undefined && setupCreatesEndpoint);
  const manualSetup = enabled && !ready && (manual || notion);
  const showDetails = !manualSetup || setupStarted || !!active?.vendorRef;
  const problem =
    (delivery.state === 'not_set_up'
      ? (endpoints.createError ?? endpoints.retryError)
      : undefined) ?? delivery.problem;
  const unreachable = enabled && relay.data ? relayProblem(relay.data) : undefined;

  return (
    <div className="min-w-0 space-y-4 rounded-md border border-border/70 glass-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
          <p className="font-medium text-ink text-sm">
            {enabled ? cardTitle(meta, delivery) : 'Paused — turn the plugin on to receive events'}
          </p>
          {delivery.state === 'last_event' ? (
            <p className="text-muted-fg text-xs">{delivery.headline}</p>
          ) : null}
        </div>
        {active === undefined && enabled ? (
          <Button
            size="sm"
            loading={endpoints.creating || retryingSetup}
            onClick={() => {
              setSetupView({ integrationId, open: meta.subscription === 'paste_url' });
              (onRetrySetup ?? endpoints.create)();
            }}
          >
            {setupCtaLabel(meta)}
          </Button>
        ) : active &&
          enabled &&
          !choosingResources &&
          !tokenSetup &&
          meta.subscription === 'auto' &&
          delivery.state === 'not_set_up' ? (
          <Button
            size="sm"
            loading={endpoints.retrying || retryingSetup}
            onClick={onRetrySetup ?? (() => endpoints.retry(active.id))}
          >
            Try again
          </Button>
        ) : active && manualSetup && !setupStarted ? (
          <Button size="sm" onClick={() => setSetupView({ integrationId, open: true })}>
            Set up events
          </Button>
        ) : null}
      </div>
      {problem && (!choosingResources || active?.vendorRef) ? (
        <p className="text-destructive text-xs" role="alert">
          {problem}
        </p>
      ) : null}
      {unreachable ? (
        <p className="text-warning-fg text-xs" role="status">
          {unreachable}
        </p>
      ) : null}

      {active &&
      enabled &&
      tokenSetup &&
      delivery.state === 'not_set_up' &&
      !active.vendorRef?.startsWith('manual:') ? (
        <ApiTokenSetup integrationId={integrationId} webhookId={active.id} provider={meta} />
      ) : null}
      {choosingResources ? (
        <ResourceSetup integrationId={integrationId} webhookId={active.id} provider={meta} />
      ) : null}

      {active ? (
        <>
          {canTest ? (
            <TestEventPicker
              key={endpointKey}
              events={meta.events}
              integrationId={integrationId}
              endpointId={active.id}
            />
          ) : null}
          {showDetails ? (
            <AdvancedPanel
              integrationId={integrationId}
              provider={meta}
              endpoint={active}
              key={endpointKey}
              open={setupView?.integrationId === integrationId && setupView.open}
              onOpenChange={(open) => setSetupView({ integrationId, open })}
              setupMode={setupMode}
              withManualSetup={
                !notion &&
                (meta.subscription === 'paste_url' ||
                  (!needsResources && delivery.state === 'not_set_up'))
              }
              rotating={endpoints.rotating}
              deactivating={endpoints.deactivating}
              onRotate={() => endpoints.rotate(active.id)}
              onDeactivate={() => endpoints.deactivate(active.id)}
            >
              {enabled && notion ? (
                <NotionSetup integrationId={integrationId} endpoint={active} />
              ) : null}
            </AdvancedPanel>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/** Current delivery status stays distinct from the last event timestamp. */
function cardTitle(provider: Provider, delivery: TriggerDelivery): string {
  if (delivery.state === 'not_set_up' && delivery.headline === 'Not set up')
    return `Set up ${provider.display_name} events`;
  return delivery.state === 'last_event'
    ? `Listening for ${provider.display_name} events`
    : delivery.headline;
}

/** Pick one of the events this account can raise and send a real sample of it. */
function TestEventPicker({
  events,
  integrationId,
  endpointId,
}: {
  events: ReadonlyArray<EventSpec>;
  integrationId: string;
  endpointId: string;
}) {
  const mutation = trpc.integrations.testWebhookEndpoint.useMutation();
  const test = useTriggerTest(mutation.mutateAsync);
  const [pickedEventId, setPickedEventId] = useState('');
  const pickedEvent = events.find((event) => event.id === pickedEventId) ?? events[0];
  if (!pickedEvent) return null;
  return (
    <details className="min-w-0 text-sm">
      <summary className="cursor-pointer rounded-sm font-medium focus-visible:outline-2 focus-visible:outline-ring">
        Test a Flow
      </summary>
      <fieldset className="mt-3 min-w-0 space-y-2">
        <legend className="sr-only">Send a sample event</legend>
        <p className="text-xs text-muted-fg">
          Send a sample event to run matching Flows. This does not test the connection to the
          provider.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Select value={pickedEvent.id} onValueChange={setPickedEventId}>
            <SelectTrigger
              className="h-8 min-w-0 flex-1 basis-56 text-xs"
              aria-label="Event to test"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {events.map((event) => (
                <SelectItem key={event.id} value={event.id}>
                  {event.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            loading={test.isSending}
            onClick={() => void test.sendTest({ integrationId, endpointId, event: pickedEvent })}
          >
            Send test event
          </Button>
        </div>
        {test.message ? (
          <output className="block text-muted-fg text-xs" aria-live="polite">
            {test.message}
          </output>
        ) : null}
      </fieldset>
    </details>
  );
}
