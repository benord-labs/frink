import { describe, expect, it } from 'vitest';
import { getProviderById } from '../../../../shared/integrations/selectors';
import {
  plainProblem,
  relayProblem,
  setupCtaLabel,
  triggerDelivery,
  triggerDeliveryLine,
  vendorReference,
  type TriggerEndpoint,
} from './delivery-state';

function endpoint(overrides: Partial<TriggerEndpoint> = {}): TriggerEndpoint {
  return {
    id: 'endpoint-1',
    webhookUrl: 'https://frink.example.com/api/triggers/linear/token-1',
    webhookSecret: 'ab'.repeat(32),
    isActive: true,
    lastReceivedAt: null,
    lastError: null,
    ...overrides,
  };
}

const linear = getProviderById('linear');
const posthog = getProviderById('posthog');
const shortcut = getProviderById('shortcut');

describe('triggerDelivery', () => {
  it('is not set up while no endpoint is active', () => {
    expect(triggerDelivery({ provider: shortcut, endpoints: [] }).state).toBe('not_set_up');
    expect(
      triggerDelivery({ provider: shortcut, endpoints: [endpoint({ isActive: false })] }).state,
    ).toBe('not_set_up');
  });

  it('is not set up while an auto row has no vendor subscription, and listening once it has one', () => {
    expect(triggerDelivery({ provider: posthog, endpoints: [endpoint()] }).state).toBe(
      'not_set_up',
    );

    const armed = triggerDelivery({
      provider: posthog,
      endpoints: [endpoint({ vendorRef: 'hook-1' })],
    });
    expect(armed.state).toBe('listening');
    expect(armed.headline).toBe('Listening for PostHog events');
  });

  it('does not report partial Webflow setup as listening even if one subscribed event arrived', () => {
    expect(
      triggerDelivery({
        provider: getProviderById('webflow'),
        endpoints: [
          endpoint({
            vendorRef: 'pending:{"sites":["site-1"],"webhooks":[]}',
            lastReceivedAt: new Date().toISOString(),
          }),
        ],
      }).state,
    ).toBe('not_set_up');
  });

  it('waits for the first event on a pasted row rather than claiming it is listening', () => {
    const pasted = triggerDelivery({ provider: shortcut, endpoints: [endpoint()] });
    expect(pasted.state).toBe('listening');
    expect(pasted.headline).toBe('Waiting for the first Shortcut event');
  });

  it('says the plugin is paused rather than reporting a delivery it will drop', () => {
    const paused = triggerDelivery({
      provider: shortcut,
      endpoints: [endpoint({ lastReceivedAt: new Date().toISOString() })],
      enabled: false,
    });

    expect(paused.state).toBe('paused');
    expect(paused.headline).toBe('Paused — turn the plugin on to receive events');
  });

  it('reports the last event once one has arrived', () => {
    const delivery = triggerDelivery({
      provider: shortcut,
      endpoints: [endpoint({ lastReceivedAt: new Date(Date.now() - 120_000).toISOString() })],
    });

    expect(delivery.state).toBe('last_event');
    expect(delivery.headline).toBe('Last event 2m ago');
  });

  it('carries the last failure in plain words', () => {
    const delivery = triggerDelivery({
      provider: shortcut,
      endpoints: [endpoint({ lastError: 'Invalid signature' })],
    });

    expect(delivery.problem).toBe(
      'Frink could not verify the last message from Shortcut. Paste the current signing secret from your Shortcut webhook settings into Frink again.',
    );
  });
});

describe('plainProblem', () => {
  it('directs ClickUp recovery to its vendor-issued secret and separate trigger API token', () => {
    expect(plainProblem('Invalid signature', 'ClickUp')).toContain(
      'Copy the signing secret returned by ClickUp into Frink',
    );
    expect(plainProblem('HTTP 401 Unauthorized', 'ClickUp')).toBe(
      'Update your ClickUp API token in trigger setup, then try again.',
    );
  });

  it('turns the errors a user can act on into a cause and a fix, and passes anything else through', () => {
    expect(plainProblem('HTTP 401 Unauthorized', 'Linear')).toBe(
      'Frink is no longer allowed to do this in Linear. Reconnect Linear, then set it up again.',
    );
    expect(plainProblem('404 webhook not found', 'Linear')).toBe(
      'Frink could not find this in Linear any more. Set it up again.',
    );
    expect(plainProblem('ECONNRESET', 'Linear')).toBe('ECONNRESET');
    const setupHint =
      'No Webflow sites are available. Create a site in Webflow or reconnect and allow access to an existing site.';
    expect(plainProblem(setupHint, 'Webflow')).toBe(setupHint);
    expect(plainProblem(null, 'Linear')).toBeUndefined();
  });
});

describe('delivery kinds', () => {
  it('names the setup action after who does the work', () => {
    expect(setupCtaLabel(posthog)).toBe('Set up automatically');
    expect(setupCtaLabel(shortcut)).toBe('Set up events');
  });
});

describe('triggerDeliveryLine', () => {
  it('waits for evidence of delivery after a ClickUp secret is imported manually', () => {
    const clickup = getProviderById('clickup');
    const unconfigured = triggerDelivery({ provider: clickup, endpoints: [endpoint()] });
    expect(unconfigured.state).toBe('not_set_up');
    expect(unconfigured.problem).toBeUndefined();
    const delivery = triggerDelivery({
      provider: clickup,
      endpoints: [endpoint({ vendorRef: 'manual:clickup:hook-1' })],
    });
    expect(delivery.headline).toBe('Waiting for the first ClickUp event');
    expect(triggerDeliveryLine(clickup, delivery)).toBe('Waiting for the first ClickUp event');
    const received = triggerDelivery({
      provider: clickup,
      endpoints: [
        endpoint({ vendorRef: 'manual:clickup:hook-1', lastReceivedAt: new Date().toISOString() }),
      ],
    });
    expect(received.state).toBe('last_event');
  });

  it('gives a Flow one line per kind', () => {
    const armed = [endpoint({ vendorRef: 'hook-1' })];

    expect(
      triggerDeliveryLine(posthog, triggerDelivery({ provider: posthog, endpoints: armed })),
    ).toBe('PostHog notifies Frink automatically · Listening for PostHog events');
    expect(triggerDeliveryLine(linear, triggerDelivery({ provider: linear, endpoints: [] }))).toBe(
      'Not set up — open Linear in Settings → Plugins',
    );
    expect(
      triggerDeliveryLine(
        shortcut,
        triggerDelivery({ provider: shortcut, endpoints: [endpoint()] }),
      ),
    ).toBe('https://frink.example.com/api/triggers/linear/token-1');
  });
});

describe('vendorReference', () => {
  it('names the thing the vendor made and where to find it, never the private locator', () => {
    expect(vendorReference(linear, endpoint({ vendorRef: 'manual:linear:hook-1' }))).toEqual({
      label: 'Linear subscription',
      url: 'https://linear.app/settings/api',
    });
    expect(vendorReference(posthog, endpoint({ vendorRef: 'us:1:2' }))?.label).toBe(
      'PostHog destination',
    );
    expect(vendorReference(linear, endpoint())).toBeUndefined();
  });
});

it.each(['square', 'vercel', 'sentry', 'linear'])(
  'requires an imported %s key even if an event reached the old unsigned endpoint',
  (id) => {
    const provider = getProviderById(id);
    const lastReceivedAt = new Date().toISOString();
    expect(triggerDelivery({ provider, endpoints: [endpoint({ lastReceivedAt })] }).state).toBe(
      'not_set_up',
    );
    expect(
      triggerDelivery({
        provider,
        endpoints: [endpoint({ vendorRef: `manual:${id}:https://frink.example.com/webhook` })],
      }).state,
    ).toBe('listening');
    expect(plainProblem('Invalid signature', provider!.display_name)).toContain(
      'Paste the current signing secret',
    );
  },
);

describe('relayProblem', () => {
  it('says nothing while the front door is answering', () => {
    expect(relayProblem({ baseUrl: 'https://relay.example.com', reachable: true })).toBeUndefined();
  });

  it('names what a beginner loses, not the connection error or the address behind it', () => {
    const problem = relayProblem({ baseUrl: 'https://relay.example.com', reachable: false });
    expect(problem).toBe(
      "Frink can't receive events right now. Anything sent before it reconnects will be missed.",
    );
  });

  it('names what is missing when the machine has no address at all', () => {
    const expected = "Frink can't receive events on this computer yet.";
    expect(relayProblem({ baseUrl: null, reachable: false })).toBe(expected);
    // With no address there is no relay client either, and a client that never existed has lost
    // nothing; the missing address is still the reason nothing arrives.
    expect(relayProblem({ baseUrl: null, reachable: true })).toBe(expected);
  });
});
