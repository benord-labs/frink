// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '../../../../../components/ui/tooltip';

const invalidate = vi.hoisted(() => vi.fn());

vi.mock('jotai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('jotai')>()),
  useSetAtom: () => vi.fn(),
}));
vi.mock('../../../../../features/code-editor', () => ({ openFileAtom: {} }));
vi.mock('../NodeProjectField', () => ({
  NodeProjectField: () => <div data-testid="node-project-field" />,
}));
vi.mock('./PluginConnectionField', () => ({
  PluginConnectionField: ({ provider }: { provider: string }) => (
    <div data-testid="plugin-connection-field">{provider}</div>
  ),
}));

vi.mock('../../../../../lib/trpc', () => ({
  trpc: {
    useUtils: () => ({ customNodes: { invalidate } }),
    customNodes: {
      list: {
        useQuery: () => ({
          data: [
            {
              name: 'example',
              inputs: { payload: { type: 'json' } },
              entrypoint: 'index.mjs',
              version: '1.0.0',
              timeout: 60,
            },
            {
              name: 'clickup_create_task',
              pluginId: 'clickup',
              icon: 'send',
              inputs: { filters: { type: 'json' } },
              unsupportedFields: ['blocks', 'metadata'],
              version: '1',
              timeout: 60,
            },
          ],
        }),
      },
      discoverLocal: { useQuery: () => ({ data: { valid: [] } }) },
      pluginServerTools: { useQuery: () => ({ data: undefined }) },
      health: { useQuery: () => ({ data: { errors: [], manifestWarnings: [] } }) },
      getCredentialStatus: { useQuery: () => ({ data: [] }) },
      sync: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
    },
    external: {
      openInFinder: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
    },
    projects: { list: { useQuery: () => ({ data: [] }) } },
    integrations: {
      list: {
        useQuery: () => ({
          data: [
            { id: 'webhook-1', provider: 'generic_webhook', accountName: 'test' },
            { id: 'linear-1', provider: 'linear', accountName: 'Benji' },
            { id: 'posthog-1', provider: 'posthog', accountIdentifier: 'PostHog account' },
          ],
          isLoading: false,
        }),
      },
      listWebhookEndpoints: { useQuery: () => ({ data: undefined }) },
    },
    triggerRules: { getEventTypes: { useQuery: () => ({ data: [] }) } },
  },
}));

const { CustomNodeConfig } = await import('./index');
const { BlockConfigPanel } = await import('../index');

afterEach(cleanup);

it('shows provider display names with unchanged account labels in webhook integration choices', async () => {
  const user = userEvent.setup();
  render(
    <TooltipProvider>
      <BlockConfigPanel
        flowId="flow-1"
        flowProjectId={null}
        flowSettings={undefined}
        selectedNode={{ id: 'n1', blockType: 'webhook_trigger', config: {} }}
        onClose={vi.fn()}
        onPatchNode={vi.fn()}
      />
    </TooltipProvider>,
  );

  await user.click(screen.getByRole('combobox', { name: 'Integration' }));

  expect(screen.getByRole('option', { name: 'Generic Webhook — test' })).toBeInTheDocument();
  expect(screen.getByRole('option', { name: 'Linear — Benji' })).toBeInTheDocument();
  expect(screen.getByRole('option', { name: 'PostHog — PostHog account' })).toBeInTheDocument();
});

describe('CustomNodeConfig template variables', () => {
  it('shows the variables available to top-level string inputs', async () => {
    const user = userEvent.setup();

    render(
      <TooltipProvider>
        <CustomNodeConfig
          node={{ id: 'custom-1', blockType: 'example', config: {} }}
          triggerBlockType="manual_trigger"
          predecessorBlockType="start_task"
          ancestorFanOut={{ fanOutNodeId: 'fan-out-1', fanOutSourceBlockType: 'start_task' }}
          onPatchLabel={vi.fn()}
          onConfigPatch={vi.fn()}
        />
      </TooltipProvider>,
    );

    await user.click(screen.getByRole('button', { name: 'Available variables' }));

    expect(screen.getByText('{{trigger.label}}')).toBeInTheDocument();
    expect(screen.getByText('{{previous.chatId}}')).toBeInTheDocument();
    expect(screen.getByText('{{loop.currentIndex}}')).toBeInTheDocument();
  });
});

describe('CustomNodeConfig node shapes', () => {
  it('uses the catalog action label for the plugin configuration heading and display name hint', () => {
    render(
      <TooltipProvider>
        <BlockConfigPanel
          flowId="flow-1"
          flowProjectId={null}
          flowSettings={undefined}
          selectedNode={{ id: 'n1', blockType: 'linear_save_issue', config: {} }}
          onClose={vi.fn()}
          onPatchNode={vi.fn()}
        />
      </TooltipProvider>,
    );

    expect(
      screen.getByRole('heading', { level: 2, name: 'Create or update a Linear issue' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Display name' })).toHaveAttribute(
      'placeholder',
      'Create or update a Linear issue',
    );
    expect(screen.queryByText('linear_save_issue')).not.toBeInTheDocument();
  });

  function renderNode(blockType: string) {
    return render(
      <TooltipProvider>
        <CustomNodeConfig
          node={{ id: 'n1', blockType, config: {} }}
          triggerBlockType="manual_trigger"
          onPatchLabel={vi.fn()}
          onConfigPatch={vi.fn()}
        />
      </TooltipProvider>,
    );
  }

  it('hides every custom-node developer affordance for a plugin step', () => {
    renderNode('clickup_create_task');

    expect(screen.queryByText('Node details')).toBeNull();
    expect(screen.queryByText('Entrypoint:')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Open manifest' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Sync to cloud' })).toBeNull();
    expect(screen.queryByTestId('node-project-field')).toBeNull();

    expect(screen.getByTestId('plugin-connection-field')).toHaveTextContent('clickup');
    expect(
      screen.getByText('Creates a task in a List with its description, assignees and due date.'),
    ).toBeInTheDocument();
    expect(screen.getByText(/Not editable here: blocks, metadata\./)).toBeInTheDocument();
  });

  it('gives the JSON editor to a plugin node only; a script node keeps a text field', () => {
    renderNode('clickup_create_task');
    expect(screen.getByRole('textbox', { name: /filters \(JSON\)/ }).tagName).toBe('TEXTAREA');
    cleanup();
    renderNode('example');
    expect(screen.getByRole('textbox', { name: 'payload' }).tagName).toBe('INPUT');
  });

  it('keeps the developer affordances for a user-authored node', () => {
    renderNode('example');

    expect(screen.getByRole('textbox', { name: 'Display name' })).toHaveAttribute(
      'placeholder',
      'example',
    );
    expect(screen.getByText('Node details')).toBeInTheDocument();
    expect(screen.getByText('Entrypoint:')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open manifest' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sync to cloud' })).toBeInTheDocument();
    expect(screen.getByTestId('node-project-field')).toBeInTheDocument();
    expect(screen.queryByTestId('plugin-connection-field')).toBeNull();
  });
});
