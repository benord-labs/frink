import { Button } from '@benord-labs/frink-primitives';
import type { TriggerEndpoint } from '@/lib/plugins/triggers/delivery-state';
import { trpc } from '@/lib/trpc';
import { EndpointSecret } from '../AdvancedPanel';

/** Notion only lets a connection's owner create and verify its subscription. */
export function NotionSetup({
  integrationId,
  endpoint,
}: {
  integrationId: string;
  endpoint: TriggerEndpoint;
}) {
  const utils = trpc.useUtils();
  const refresh = () => utils.integrations.listWebhookEndpoints.invalidate({ integrationId });
  const confirm = trpc.triggerSetup.confirmNotion.useMutation({ onSuccess: refresh });
  const restart = trpc.triggerSetup.restartNotion.useMutation({ onSuccess: refresh });
  const generation = endpoint.webhookPathToken;
  const candidate = endpoint.vendorRef ?? null;
  const pending = candidate?.startsWith('notion:pending:');
  const verified = candidate?.startsWith('notion:verified:');
  const problem = confirm.error?.message ?? restart.error?.message;
  return (
    <div className="space-y-3">
      {!verified ? (
        <>
          <p className="text-xs text-muted-fg">
            Add a webhook subscription to a Notion connection you own. Signing in to Notion tools
            doesn’t grant this permission.
          </p>
          {!pending ? (
            <ol className="list-decimal space-y-1 pl-5 text-xs text-muted-fg">
              <li>Open Notion connections and select a connection you own, or create one.</li>
              <li>Open its Webhooks tab and choose Create a subscription.</li>
              <li>Paste the webhook address, choose your events, and create the subscription.</li>
              <li>
                Return here and check for the verification code, then paste it into Notion to
                verify.
              </li>
            </ol>
          ) : null}
          <Button size="sm" variant="secondary" asChild>
            <a
              href="https://www.notion.so/profile/integrations"
              target="_blank"
              rel="noopener noreferrer"
            >
              Open Notion connections<span className="sr-only"> (opens in a new tab)</span>
            </a>
          </Button>
          {pending ? (
            <>
              <p className="text-xs text-muted-fg">
                Copy this code into Notion and verify the subscription there. Frink also uses it as
                the signing secret to check incoming events.
              </p>
              <EndpointSecret secret={endpoint.webhookSecret} label="Verification code" />
              <Button
                size="sm"
                loading={confirm.isPending}
                disabled={!generation}
                onClick={() =>
                  generation &&
                  candidate &&
                  confirm.mutate({ integrationId, webhookId: endpoint.id, generation, candidate })
                }
              >
                I’ve verified in Notion
              </Button>
            </>
          ) : (
            <p className="text-xs text-muted-fg" role="status">
              No verification code received yet. Notion sends it after you create the subscription.
              This code becomes the signing secret; no separate API key is needed. If you already
              created it, choose Resend token in Notion’s verification window, then check again
              here.
            </p>
          )}
          <Button size="sm" variant="ghost" onClick={() => void refresh()}>
            Check for verification code
          </Button>
        </>
      ) : null}
      {verified ? (
        <>
          <EndpointSecret secret={endpoint.webhookSecret} label="Signing secret" />
          <p className="text-xs text-muted-fg">
            Notion provided this secret during verification. Frink uses it to check incoming events.
            To replace it, restart setup below.
          </p>
        </>
      ) : null}
      {candidate ? (
        <details className="text-xs text-muted-fg">
          <summary className="cursor-pointer">Restart setup</summary>
          <p className="py-2">
            This replaces the address. Delete the old subscription in Notion, then create a new one.
          </p>
          <Button
            size="sm"
            variant="secondary"
            disabled={!generation}
            loading={restart.isPending}
            onClick={() =>
              generation &&
              restart.mutate({ integrationId, webhookId: endpoint.id, generation, candidate })
            }
          >
            Create a new address
          </Button>
        </details>
      ) : null}
      {problem ? (
        <p role="alert" className="text-xs text-destructive">
          {problem}
        </p>
      ) : null}
    </div>
  );
}
