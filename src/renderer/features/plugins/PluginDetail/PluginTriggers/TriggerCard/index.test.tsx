// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { standardWebhooksSecret } from '../../../../../../shared/integrations/webhook-secret';
import { getProviderById } from '../../../../../../shared/integrations/selectors';
import type { TriggerEndpoint } from '@/lib/plugins/triggers/delivery-state';
import { TriggerCard } from './index';

type EndpointsQueryResult = {
  data: { success: true; endpoints: TriggerEndpoint[] } | undefined;
  isLoading: boolean;
  refetch: () => Promise<void>;
};

type RetryState = { isPending: boolean; error: { message: string } | null };

type RelayQueryResult = { data: { baseUrl: string | null; reachable: boolean } | undefined };

const {
  endpointsQuery,
  relayQuery,
  generateMutate,
  rotateEndpointMutate,
  deactivateMutate,
  sendTestEvent,
  retryMutate,
  retryState,
  createState,
  resourceOptions,
  configureApiToken,
  configureResources,
} = vi.hoisted(() => {
  const retryState: RetryState = {
    isPending: false,
    error: null,
  };
  return {
    endpointsQuery: vi.fn<() => EndpointsQueryResult>(),
    relayQuery: vi.fn<() => RelayQueryResult>(),
    resourceOptions: vi.fn(),
    configureApiToken: vi.fn(),
    configureResources: vi.fn(),
    generateMutate: vi.fn(),
    retryMutate: vi.fn(),
    retryState,
    // SAFETY: the card reads only the pending flag, the error message and the result payload.
    createState: {
      isPending: false,
      error: null as { message: string } | null,
      data: undefined as { success: false; error: string } | undefined,
    },
    rotateEndpointMutate: vi.fn(),
    deactivateMutate: vi.fn(),
    sendTestEvent: vi.fn<() => Promise<{ success: boolean }>>(),
  };
});

// oxlint-disable-next-line anti-slop/no-module-mocking -- the tRPC client is the card's only collaborator; moved with the card from the webhook setup guide
vi.mock('@/lib/trpc', () => {
  const mutation = (mutate: () => void) => ({
    useMutation: () => ({ mutate, mutateAsync: vi.fn(), reset: vi.fn(), isPending: false }),
  });
  return {
    trpc: {
      useUtils: () => ({ integrations: { listWebhookEndpoints: { invalidate: vi.fn() } } }),
      triggerSetup: {
        options: { useQuery: resourceOptions },
        configure: mutation(configureResources),
        configureApiToken: mutation(configureApiToken),
        importClickupWebhook: mutation(vi.fn()),
        importVendorWebhook: mutation(vi.fn()),
        confirmNotion: mutation(vi.fn()),
        restartNotion: mutation(vi.fn()),
      },
      integrations: {
        listWebhookEndpoints: { useQuery: endpointsQuery },
        getTriggerRelay: { useQuery: relayQuery },
        generateWebhookEndpoint: {
          useMutation: () => ({ mutate: generateMutate, ...createState }),
        },
        retryWebhookEndpoint: {
          useMutation: () => ({ mutate: retryMutate, ...retryState }),
        },
        rotateWebhookEndpoint: mutation(rotateEndpointMutate),
        deactivateWebhookEndpoint: mutation(deactivateMutate),
        testWebhookEndpoint: {
          useMutation: () => ({ mutate: vi.fn(), mutateAsync: sendTestEvent, isPending: false }),
        },
      },
    },
  };
});

/** What a minted endpoint carries: 32 random bytes as hex. */
const HEX_SECRET = 'ab'.repeat(32);
const RELAY = 'https://relay.example.com';

function endpoints(overrides: Partial<TriggerEndpoint> = {}): EndpointsQueryResult {
  return {
    data: {
      success: true,
      endpoints: [
        {
          id: 'endpoint-1',
          webhookUrl: 'http://127.0.0.1:49238/api/triggers/shortcut/token-1',
          webhookSecret: HEX_SECRET,
          isActive: true,
          lastReceivedAt: null,
          lastError: null,
          ...overrides,
        },
      ],
    },
    isLoading: false,
    refetch: async () => {},
  };
}

const NO_ENDPOINTS: EndpointsQueryResult = {
  data: { success: true, endpoints: [] },
  isLoading: false,
  refetch: async () => {},
};

/** The address label follows the panel: setup calls it Frink's, a proved trigger the webhook's. */
const ADDRESS = /^(Webhook|Frink) address$/;

/** The panel's own disclosure: "Advanced" once delivery is proved, "Setup steps" before it. */
function panelTrigger(): HTMLElement | null {
  return (
    screen.queryByRole('button', { name: 'Setup steps' }) ??
    screen.queryByRole('button', { name: 'Advanced' })
  );
}

function openAdvanced() {
  const setup = screen.queryByRole('button', { name: 'Set up events' });
  if (setup) fireEvent.click(setup);
  else fireEvent.click(panelTrigger()!);
}

/** Rotate and deactivate sit one disclosure deeper while setup is still unproved. */
function openMaintenance() {
  const nested = screen.queryByRole('button', { name: 'Advanced' });
  if (nested?.getAttribute('aria-expanded') === 'false') fireEvent.click(nested);
}

describe('TriggerCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    retryState.isPending = false;
    retryState.error = null;
    createState.error = null;
    createState.data = undefined;
    createState.isPending = false;
    endpointsQuery.mockReturnValue(endpoints());
    relayQuery.mockReturnValue({ data: { baseUrl: RELAY, reachable: true } });
    sendTestEvent.mockResolvedValue({ success: true });
    resourceOptions.mockReturnValue({
      error: { message: 'This account cannot send webhook notifications.' },
      refetch: vi.fn(),
      isLoading: false,
      isFetching: false,
    });
  });

  afterEach(cleanup);

  it('says in plain words that the address is unreachable, and stays quiet once it answers', () => {
    relayQuery.mockReturnValue({ data: { baseUrl: RELAY, reachable: false } });
    render(<TriggerCard integrationId="integration-1" provider="shortcut" enabled />);
    expect(screen.getByRole('status')).toHaveTextContent(
      "Frink can't receive events right now. Anything sent before it reconnects will be missed.",
    );

    cleanup();
    relayQuery.mockReturnValue({ data: { baseUrl: RELAY, reachable: true } });
    render(<TriggerCard integrationId="integration-1" provider="shortcut" enabled />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  // `text-warning` is the amber fill shade, 2.5:1 on the light card; `text-warning-fg` is its
  // text shade and passes WCAG AA.
  it('writes the unreachable warning in the amber text shade', () => {
    relayQuery.mockReturnValue({ data: { baseUrl: RELAY, reachable: false } });
    render(<TriggerCard integrationId="integration-1" provider="shortcut" enabled />);
    expect(screen.getByRole('status')).toHaveClass('text-warning-fg');
  });

  it('offers ClickUp API key setup after an endpoint is created and hides the placeholder secret', () => {
    endpointsQuery.mockReturnValue(endpoints({ vendorRef: null }));
    render(<TriggerCard integrationId="integration-1" provider="clickup" enabled />);
    expect(screen.getByLabelText('ClickUp API key')).toHaveAttribute('type', 'password');
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send test event' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('ClickUp API key'), { target: { value: 'pk-example' } });
    fireEvent.click(screen.getByRole('button', { name: 'Set up automatically' }));
    expect(configureApiToken).toHaveBeenCalledWith({
      integrationId: 'integration-1',
      webhookId: 'endpoint-1',
      apiKey: 'pk-example',
    });
    openAdvanced();
    expect(screen.queryByLabelText('Secret, hidden')).not.toBeInTheDocument();
    expect(screen.getByLabelText('ClickUp signing secret')).toBeInTheDocument();
  });

  it('waits for a real event before claiming a manually imported ClickUp webhook is listening, and titles its panel as setup', () => {
    endpointsQuery.mockReturnValue(endpoints({ vendorRef: 'manual:clickup:hook-1' }));
    render(<TriggerCard integrationId="integration-1" provider="clickup" enabled />);
    expect(screen.getByText('Waiting for the first ClickUp event')).toBeInTheDocument();
    expect(screen.queryByText('Listening for ClickUp events')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('ClickUp API key')).not.toBeInTheDocument();
    // A `manual:` row is a beginner paste like any other, so setup mode has to reach it too.
    fireEvent.click(screen.getByRole('button', { name: 'Setup steps' }));
    expect(screen.getByText('Frink address')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Deactivate trigger' })).not.toBeInTheDocument();
    openMaintenance();
    expect(screen.getByRole('button', { name: 'Deactivate trigger' })).toBeInTheDocument();
  });

  it('does not offer ClickUp manual import while automatic setup is pending', () => {
    endpointsQuery.mockReturnValue(endpoints({ vendorRef: 'pending:clickup:workspace' }));
    render(<TriggerCard integrationId="integration-1" provider="clickup" enabled />);
    openAdvanced();
    expect(screen.queryByLabelText('ClickUp signing secret')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Secret, hidden')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Rotate secret' })).not.toBeInTheDocument();
  });

  it.each([
    'shortcut',
    'huggingface',
    'supabase',
    'vercel',
    'generic_webhook',
    'linear',
    'sentry',
    'posthog',
  ])('keeps %s address and secret exclusively behind its panel', (provider) => {
    render(<TriggerCard integrationId="integration-1" provider={provider} enabled />);
    expect(screen.queryByText(ADDRESS)).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue(HEX_SECRET)).not.toBeInTheDocument();
    openAdvanced();
    expect(screen.getAllByText(ADDRESS)).toHaveLength(1);
    if (['shortcut', 'huggingface', 'generic_webhook', 'posthog'].includes(provider))
      expect(screen.getByLabelText('Secret, hidden')).toBeInTheDocument();
  });

  it('keeps Notion verification and its single address under Advanced', () => {
    render(<TriggerCard integrationId="integration-1" provider="notion" enabled />);
    expect(screen.queryByText(ADDRESS)).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Check for verification code' }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Set up events' }));
    expect(screen.getAllByText(ADDRESS)).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Check for verification code' })).toBeInTheDocument();
  });

  it('opens manual setup through the shared Set up events action', () => {
    // generic_webhook has no vendor to connect through, so only the click — never an
    // already-existing endpoint — can mark its setup as started.
    render(<TriggerCard integrationId="integration-1" provider="generic_webhook" enabled />);
    fireEvent.click(screen.getByRole('button', { name: 'Set up events' }));
    expect(screen.getAllByText(ADDRESS)).toHaveLength(1);
    expect(screen.queryByDisplayValue(HEX_SECRET)).not.toBeInTheDocument();
  });

  it('does not ask to redo Set up events after leaving and returning to the page', () => {
    render(<TriggerCard integrationId="integration-1" provider="shortcut" enabled />);
    expect(screen.getByText('Waiting for the first Shortcut event')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Set up events' })).not.toBeInTheDocument();
    expect(screen.queryByText(ADDRESS)).not.toBeInTheDocument();
    openAdvanced();
    expect(screen.getAllByText(ADDRESS)).toHaveLength(1);
  });

  it('shows a received event without asking to repeat manual setup', () => {
    endpointsQuery.mockReturnValue(
      endpoints({ lastReceivedAt: new Date(Date.now() - 120_000).toISOString() }),
    );

    render(<TriggerCard integrationId="integration-1" provider="shortcut" enabled />);

    expect(screen.getByText('Listening for Shortcut events')).toBeInTheDocument();
    expect(screen.getByText('Last event 2m ago')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Set up events' })).not.toBeInTheDocument();
  });

  it('keeps retry primary after automatic setup fails and manual instructions inside Advanced', () => {
    endpointsQuery.mockReturnValue(NO_ENDPOINTS);
    const { rerender } = render(
      <TriggerCard integrationId="integration-1" provider="posthog" enabled />,
    );

    expect(screen.getByText('Set up PostHog events')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Set up automatically' }));
    expect(generateMutate).toHaveBeenCalledWith({ integrationId: 'integration-1' });

    endpointsQuery.mockReturnValue(endpoints({ lastError: 'HTTP 401 Unauthorized' }));
    rerender(<TriggerCard integrationId="integration-1" provider="posthog" enabled />);

    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(screen.queryByText(/Paste it in yourself/)).not.toBeInTheDocument();
    expect(screen.queryByText(ADDRESS)).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Open PostHog/ })).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Frink is no longer allowed to do this in PostHog.',
    );
    openAdvanced();
    expect(screen.getByText('Manual setup')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open PostHog/ })).toBeInTheDocument();
    expect(screen.getByText(ADDRESS)).toBeInTheDocument();
    expect(screen.getByLabelText('Secret, hidden')).toBeInTheDocument();
    expect(screen.queryByDisplayValue(HEX_SECRET)).not.toBeInTheDocument();
  });

  it('lets resource discovery own the initial setup error and refresh action', () => {
    endpointsQuery.mockReturnValue(
      endpoints({
        vendorRef: null,
        lastError: 'Choose the Cloudflare alerts that should start your Flows.',
      }),
    );
    render(<TriggerCard integrationId="integration-1" provider="cloudflare" enabled />);
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.getByRole('alert')).toHaveTextContent(
      'This account cannot send webhook notifications.',
    );
    expect(
      screen.queryByText('Choose the Cloudflare alerts that should start your Flows.'),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Use these alerts' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled();
  });

  it('lets users correct a resource after a failed setup survives a reload', () => {
    endpointsQuery.mockReturnValue(
      endpoints({
        vendorRef: 'pending:owned-resources',
        lastError: 'Hugging Face could not find the watched resource.',
      }),
    );
    resourceOptions.mockReturnValue({ data: { options: [], selection: 'many' }, isLoading: false });
    render(<TriggerCard integrationId="integration-1" provider="huggingface" enabled />);
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Hugging Face could not find the watched resource.',
    );
    fireEvent.change(screen.getByLabelText('Resource name'), {
      target: { value: 'existing-user' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Set up automatically' }));
    expect(configureResources).toHaveBeenCalledWith({
      integrationId: 'integration-1',
      webhookId: 'endpoint-1',
      selection: ['user:existing-user'],
    });
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send test event' })).not.toBeInTheDocument();
    expect(screen.queryByText(ADDRESS)).not.toBeInTheDocument();
  });

  it('keeps a failed Webflow subscription retryable without exposing manual setup or an unused secret', () => {
    endpointsQuery.mockReturnValue(
      endpoints({ lastError: 'Webflow could not complete webhook setup.' }),
    );
    render(<TriggerCard integrationId="integration-1" provider="webflow" enabled />);

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Webflow could not complete webhook setup.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(retryMutate).toHaveBeenCalledWith({
      integrationId: 'integration-1',
      webhookId: 'endpoint-1',
    });
    expect(screen.queryByText(ADDRESS)).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Open Webflow/ })).not.toBeInTheDocument();
    openAdvanced();
    expect(screen.getByText('Manual setup')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open Webflow/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Rotate secret' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Secret, hidden')).not.toBeInTheDocument();
  });

  it('retries an unregistered address and clears its failure display when registration recovers', () => {
    const { rerender } = render(
      <TriggerCard integrationId="integration-1" provider="posthog" enabled />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(retryMutate).toHaveBeenCalledExactlyOnceWith({
      integrationId: 'integration-1',
      webhookId: 'endpoint-1',
    });
    expect(generateMutate).not.toHaveBeenCalled();
    expect(rotateEndpointMutate).not.toHaveBeenCalled();
    retryState.isPending = true;
    rerender(<TriggerCard integrationId="integration-1" provider="posthog" enabled />);
    expect(screen.getByRole('button', { name: 'Try again' })).toBeDisabled();
    retryState.isPending = false;
    retryState.error = { message: 'PostHog is not connected. Reconnect it first.' };
    rerender(<TriggerCard integrationId="integration-1" provider="posthog" enabled />);
    expect(screen.getByRole('alert')).toHaveTextContent(
      'PostHog is not connected. Reconnect it first.',
    );

    // Another action can register the endpoint while this card and its failed mutation stay mounted.
    endpointsQuery.mockReturnValue(endpoints({ vendorRef: 'destination-1' }));
    rerender(<TriggerCard integrationId="integration-1" provider="posthog" enabled />);
    expect(screen.getByText('Listening for PostHog events')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it.each(['webflow', 'posthog'])(
    'retries %s through the supplied connection lifecycle without a raw endpoint mutation',
    (provider) => {
      const reconnect = vi.fn();
      const { rerender } = render(
        <TriggerCard
          integrationId="integration-1"
          provider={provider}
          enabled
          onRetrySetup={reconnect}
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
      expect(reconnect).toHaveBeenCalledTimes(1);
      expect(retryMutate).not.toHaveBeenCalled();
      expect(generateMutate).not.toHaveBeenCalled();
      rerender(
        <TriggerCard
          integrationId="integration-1"
          provider={provider}
          enabled
          onRetrySetup={reconnect}
          retryingSetup
        />,
      );
      expect(screen.getByRole('button', { name: 'Try again' })).toBeDisabled();
      endpointsQuery.mockReturnValue(NO_ENDPOINTS);
      rerender(
        <TriggerCard
          integrationId="integration-1"
          provider={provider}
          enabled
          onRetrySetup={reconnect}
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: 'Set up automatically' }));
      expect(reconnect).toHaveBeenCalledTimes(2);
      expect(generateMutate).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['posthog', false, null],
    ['posthog', true, 'destination-1'],
    ['shortcut', true, null],
    ['gmail', true, null],
  ])('does not retry %s when enabled=%s and vendorRef=%s', (provider, enabled, vendorRef) => {
    endpointsQuery.mockReturnValue(endpoints({ vendorRef }));
    render(<TriggerCard integrationId="integration-1" provider={provider} enabled={enabled} />);
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });

  it('shows a registered auto row no paste steps and no clear-text secret; Advanced holds the address, the masked secret and the subscription', () => {
    endpointsQuery.mockReturnValue(endpoints({ vendorRef: 'us:1:fn_1' }));

    render(<TriggerCard integrationId="integration-1" provider="posthog" enabled />);

    expect(screen.getByText('Listening for PostHog events')).toBeInTheDocument();
    expect(
      screen.queryByRole('list', { name: 'Events that can start a Flow' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/Paste this into PostHog|Paste it in yourself/)).toBeNull();
    expect(screen.queryByText(ADDRESS)).toBeNull();
    expect(screen.queryByDisplayValue(HEX_SECRET)).toBeNull();

    openAdvanced();
    expect(screen.getByText(ADDRESS)).toBeInTheDocument();
    expect(screen.getByLabelText('Secret, hidden')).toBeInTheDocument();
    expect(screen.queryByDisplayValue(HEX_SECRET)).toBeNull();
    expect(
      screen.getByText('Frink made this secret and updates it in PostHog for you.'),
    ).toBeInTheDocument();
    expect(screen.getByText(/PostHog destination/)).toBeInTheDocument();
  });

  it('tells the user to re-paste the vendor secret on signing failures without revealing it', () => {
    endpointsQuery.mockReturnValue(
      endpoints({ vendorRef: 'us:1:fn_1', lastError: 'Invalid signature' }),
    );

    render(<TriggerCard integrationId="integration-1" provider="posthog" enabled />);

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Paste the current signing secret from your PostHog webhook settings into Frink again.',
    );
    expect(screen.queryByDisplayValue(HEX_SECRET)).toBeNull();
  });

  it('says the plugin is paused instead of reporting an event it will drop', () => {
    endpointsQuery.mockReturnValue(
      endpoints({ lastReceivedAt: new Date().toISOString(), vendorRef: 'hook-1' }),
    );

    const { rerender } = render(
      <TriggerCard integrationId="integration-1" provider="posthog" enabled={false} />,
    );

    expect(screen.getByText('Paused — turn the plugin on to receive events')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send test event' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'Event to test' })).toBeNull();
    expect(screen.getByRole('button', { name: /Advanced/ })).toBeInTheDocument();

    rerender(<TriggerCard integrationId="integration-1" provider="posthog" enabled />);
    fireEvent.click(screen.getByText('Test a Flow'));
    expect(screen.getByRole('button', { name: 'Send test event' })).toBeEnabled();
  });

  it('shows no secret for a row whose secret nothing verifies, and deactivates a row that has one', () => {
    render(<TriggerCard integrationId="integration-1" provider="sentry" enabled />);
    openAdvanced();

    expect(screen.queryByText('Secret')).toBeNull();
    openMaintenance();
    expect(screen.queryByRole('button', { name: 'Rotate secret' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Deactivate trigger' }));
    expect(deactivateMutate).toHaveBeenCalledWith({
      integrationId: 'integration-1',
      webhookId: 'endpoint-1',
    });
  });

  it('hands a Standard Webhooks vendor the secret in the form its Signing secret field takes', () => {
    render(<TriggerCard integrationId="integration-1" provider="posthog" enabled />);

    openAdvanced();
    fireEvent.click(screen.getByRole('button', { name: /Reveal/ }));
    expect(screen.getByDisplayValue(standardWebhooksSecret(HEX_SECRET))).toBeInTheDocument();
    expect(screen.queryByDisplayValue(HEX_SECRET)).toBeNull();
  });

  it('states the signing contract beside the address of a row nothing but Frink verifies', () => {
    render(<TriggerCard integrationId="integration-1" provider="generic_webhook" enabled />);

    openAdvanced();
    expect(screen.getByText(/X-Frink-Signature/)).toBeInTheDocument();
    expect(screen.getByLabelText('Secret, hidden')).toBeInTheDocument();
  });

  it('explains that a sample runs Flows without verifying the provider connection', async () => {
    endpointsQuery.mockReturnValue(endpoints({ lastReceivedAt: new Date().toISOString() }));
    render(<TriggerCard integrationId="integration-1" provider="shortcut" enabled />);

    fireEvent.click(screen.getByText('Test a Flow'));
    expect(screen.getByRole('group', { name: 'Send a sample event' })).toHaveTextContent(
      'This does not test the connection to the provider.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Send test event' }));

    await waitFor(() =>
      expect(screen.getByText(/Sample .* sent\./)).toHaveTextContent(
        'Sample “Story assigned” sent. Matching Flows will run.',
      ),
    );
    expect(sendTestEvent).toHaveBeenCalledWith({
      integrationId: 'integration-1',
      endpointId: 'endpoint-1',
      eventId: 'story_assigned',
    });
  });

  it.each([
    'huggingface',
    'linear',
    'posthog',
    'cloudflare',
    'clickup',
    'notion',
    'shortcut',
    'supabase',
    'generic_webhook',
  ])('keeps %s setup separate from testing and Advanced closed for a new endpoint', (provider) => {
    const { rerender } = render(<TriggerCard integrationId="one" provider={provider} enabled />);
    // A pasted address is a working endpoint from the start; one awaiting a vendor's own secret,
    // an automatic row and a verified row are not until that step lands.
    const meta = getProviderById(provider);
    const pasted =
      meta?.subscription === 'paste_url' && !meta.webhook_setup?.secret && provider !== 'notion';
    expect(screen.queryByText('Test a Flow') !== null).toBe(pasted);
    expect(screen.queryByRole('button', { name: 'Send test event' }) !== null).toBe(pasted);
    const advanced = panelTrigger();
    if (screen.queryByRole('button', { name: 'Set up events' })) expect(advanced).toBeNull();
    else expect(advanced).toHaveAttribute('aria-expanded', 'false');
    openAdvanced();
    if (provider === 'huggingface') {
      expect(screen.queryByRole('button', { name: 'Rotate secret' })).not.toBeInTheDocument();
      expect(
        screen.getByText('Frink will set this secret in Hugging Face when setup finishes.'),
      ).toBeInTheDocument();
    }
    rerender(<TriggerCard integrationId="two" provider={provider} enabled />);
    const nextAdvanced = panelTrigger();
    if (screen.queryByRole('button', { name: 'Set up events' })) expect(nextAdvanced).toBeNull();
    else expect(nextAdvanced).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText(ADDRESS)).not.toBeInTheDocument();
  });

  it.each(['huggingface', 'posthog', 'cloudflare', 'clickup', 'notion'])(
    'offers a collapsed Flow test after %s registration completes',
    (provider) => {
      endpointsQuery.mockReturnValue(
        endpoints({ vendorRef: provider === 'notion' ? 'notion:verified:code' : 'hook-1' }),
      );
      render(<TriggerCard integrationId="one" provider={provider} enabled />);
      expect(screen.getByText('Test a Flow').closest('details')).not.toHaveAttribute('open');
      expect(screen.queryByRole('button', { name: 'Set up events' })).not.toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: 'Set up automatically' }),
      ).not.toBeInTheDocument();
    },
  );

  it('renders nothing for a plugin with no trigger-capable provider row', () => {
    const { container } = render(
      <TriggerCard integrationId="integration-1" provider="neon" enabled />,
    );

    expect(container).toBeEmptyDOMElement();
  });
  it.each(['notion', 'generic_webhook'])(
    'reveals %s setup only after starting and removes the redundant setup button',
    (provider) => {
      render(<TriggerCard integrationId="one" provider={provider} enabled />);
      expect(panelTrigger()).toBeNull();
      expect(screen.queryByText(ADDRESS)).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Set up events' }));
      expect(screen.getByText(ADDRESS)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Set up events' })).not.toBeInTheDocument();
      fireEvent.click(panelTrigger()!);
      expect(screen.queryByText(ADDRESS)).not.toBeInTheDocument();
      fireEvent.click(panelTrigger()!);
      expect(screen.getByText(ADDRESS)).toBeInTheDocument();
    },
  );

  it.each(['square', 'vercel', 'sentry', 'shortcut', 'linear'])(
    'keeps %s setup reachable under a closed panel once its endpoint exists, since only Set up events creates it',
    (provider) => {
      render(<TriggerCard integrationId="one" provider={provider} enabled />);
      expect(screen.queryByRole('button', { name: 'Set up events' })).not.toBeInTheDocument();
      expect(panelTrigger()).toHaveAttribute('aria-expanded', 'false');
      expect(screen.queryByText(ADDRESS)).not.toBeInTheDocument();
      openAdvanced();
      expect(screen.getByText(ADDRESS)).toBeInTheDocument();
    },
  );

  // The step text is the whole of the paste instruction, so it is asserted literally: a revert to
  // the old "from step 1" / "save it under Advanced" wording points the user at nothing.
  it.each([
    [
      'shortcut',
      'Copy the Frink address below and paste it into "Webhook URL".',
      'Copy the Frink secret below and paste it into "Secret".',
    ],
    [
      'linear',
      'Copy the Frink address below and paste it into "URL".',
      'Copy Linear’s signing secret and paste it into "Signing secret" below.',
    ],
  ])(
    'titles %s setup for a beginner and keeps maintenance one click deeper until an event proves it',
    (provider, addressStep, secretStep) => {
      const meta = getProviderById(provider)!;
      render(<TriggerCard integrationId="one" provider={provider} enabled />);

      fireEvent.click(screen.getByRole('button', { name: 'Setup steps' }));
      // Only a row still waiting on a vendor secret is headed "Set up <Service> events"; either way
      // the disclosure inside it must not print that sentence a second time.
      expect(screen.queryAllByText(/^Set up .* events$/)).toHaveLength(
        meta.webhook_setup?.secret ? 1 : 0,
      );
      expect(screen.getByText('Frink address')).toBeInTheDocument();
      expect(screen.getByText(addressStep)).toBeInTheDocument();
      expect(screen.getByText(secretStep)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Deactivate trigger' })).not.toBeInTheDocument();
      openMaintenance();
      expect(screen.getByRole('button', { name: 'Deactivate trigger' })).toBeInTheDocument();

      cleanup();
      endpointsQuery.mockReturnValue(
        endpoints({
          lastReceivedAt: new Date().toISOString(),
          vendorRef: `manual:${provider}:https://frink.example.com/webhook`,
        }),
      );
      render(<TriggerCard integrationId="one" provider={provider} enabled />);
      fireEvent.click(screen.getByRole('button', { name: 'Advanced' }));
      expect(screen.getByText('Webhook address')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Deactivate trigger' })).toBeInTheDocument();
    },
  );

  it('opens manual instructions after the first setup click creates an endpoint', () => {
    endpointsQuery.mockReturnValue(NO_ENDPOINTS);
    const { rerender } = render(<TriggerCard integrationId="one" provider="notion" enabled />);
    fireEvent.click(screen.getByRole('button', { name: 'Set up events' }));
    expect(generateMutate).toHaveBeenCalledExactlyOnceWith({ integrationId: 'one' });
    endpointsQuery.mockReturnValue(endpoints());
    rerender(<TriggerCard integrationId="one" provider="notion" enabled />);
    expect(screen.getByText(ADDRESS)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open Notion connections/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Set up events' })).not.toBeInTheDocument();
  });

  it.each(['transport', 'response'])(
    'shows %s endpoint-creation errors and keeps setup retryable',
    (kind) => {
      endpointsQuery.mockReturnValue(NO_ENDPOINTS);
      const { rerender } = render(<TriggerCard integrationId="one" provider="notion" enabled />);
      fireEvent.click(screen.getByRole('button', { name: 'Set up events' }));
      if (kind === 'transport') createState.error = { message: 'Could not create endpoint' };
      else createState.data = { success: false, error: 'Could not create endpoint' };
      rerender(<TriggerCard integrationId="one" provider="notion" enabled />);
      expect(screen.getByRole('alert')).toHaveTextContent('Could not create endpoint');
      fireEvent.click(screen.getByRole('button', { name: 'Set up events' }));
      expect(generateMutate).toHaveBeenCalledTimes(2);
    },
  );
  it.each(['square', 'vercel', 'sentry'])(
    'requires %s’s signing key before testing and never offers local secret rotation',
    (provider) => {
      const meta = getProviderById(provider)!;
      const label = meta.webhook_setup!.secret!.label;
      const { rerender } = render(<TriggerCard integrationId="one" provider={provider} enabled />);
      openAdvanced();
      expect(screen.getByLabelText(`${meta.display_name} ${label.toLowerCase()}`)).toHaveAttribute(
        'type',
        'password',
      );
      expect(screen.queryByText('Test a Flow')).not.toBeInTheDocument();
      expect(screen.queryByLabelText(`${label}, hidden`)).not.toBeInTheDocument();
      endpointsQuery.mockReturnValue(
        endpoints({ vendorRef: `manual:${provider}:https://frink.example.com/webhook` }),
      );
      rerender(<TriggerCard integrationId="one" provider={provider} enabled />);
      expect(screen.getByText('Test a Flow')).toBeInTheDocument();
      expect(screen.getByLabelText(`${label}, hidden`)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Update/i })).toBeDisabled();
      expect(screen.queryByRole('button', { name: 'Rotate secret' })).not.toBeInTheDocument();
    },
  );
});
