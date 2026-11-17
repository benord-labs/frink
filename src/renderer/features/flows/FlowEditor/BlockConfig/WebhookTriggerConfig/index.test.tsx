// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ComponentProps, type ReactElement, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithTrpc } from '@/lib/test-utils/render-with-trpc';
import type { FlowNode } from '../../../../../../shared/lib/validate-flow-graph';
import type { StoredWebhookConditions } from '../../../../../lib/flows/webhook-trigger/parse-conditions';
import { WebhookTriggerConfig } from '.';

// `lib/trpc` wires its ipc client at import time, so the preload bridge must exist first.
vi.hoisted(() => {
  Object.assign(globalThis, {
    electronTRPC: { onMessage: () => () => undefined, sendMessage: () => undefined },
  });
});

afterEach(cleanup);

const TITLE_FILTER = { field: 'storyName', operator: 'contains', value: 'Retry' };

function answer({ path }: { path: string }) {
  return path === 'integrations.list'
    ? Promise.resolve([
        { id: 'shortcut-1', provider: 'shortcut', accountIdentifier: 'acme' },
        { id: 'hook-1', provider: 'generic_webhook', accountIdentifier: 'inbox' },
      ])
    : new Promise(() => {});
}

/** Keeps the node the panel saves and renders it from that again, as the flow editor does. */
function SavedNode(props: {
  conditions: StoredWebhookConditions;
  onSave: ComponentProps<typeof WebhookTriggerConfig>['onPatchConfig'];
  /** Conditions written from outside the panel, as an agent's flow patch does. */
  outsideEdit?: StoredWebhookConditions;
}): ReactElement {
  const [node, setNode] = useState<FlowNode>({
    id: 'trigger',
    blockType: 'webhook_trigger',
    config: {
      integrationId: 'shortcut-1',
      eventType: 'story_assigned',
      conditions: props.conditions,
    },
  });
  const { outsideEdit } = props;
  return (
    <>
      {outsideEdit ? (
        <button
          type="button"
          onClick={() =>
            setNode((n) => ({ ...n, config: { ...n.config, conditions: outsideEdit } }))
          }
        >
          Edit from outside
        </button>
      ) : null}
      <WebhookTriggerConfig
        node={node}
        onPatchLabel={() => undefined}
        onPatchConfig={(config) => {
          props.onSave(config);
          setNode((n) => ({ ...n, config: { ...n.config, ...config } }));
        }}
      />
    </>
  );
}

/** Two triggers sharing one panel, as the editor reuses it when another node is selected. */
function TwoTriggers(): ReactElement {
  const [nodes, setNodes] = useState<FlowNode[]>([
    {
      id: 'a',
      blockType: 'webhook_trigger',
      config: {
        integrationId: 'shortcut-1',
        eventType: 'story_assigned',
        conditions: { assignee: 'anyone', filters: [TITLE_FILTER] },
      },
    },
    {
      id: 'b',
      blockType: 'webhook_trigger',
      config: {
        integrationId: 'shortcut-1',
        eventType: 'story_assigned',
        conditions: { assignee: 'anyone' },
      },
    },
  ]);
  const [activeId, setActiveId] = useState('a');
  const active = nodes.find((n) => n.id === activeId) ?? nodes[0];
  if (!active) throw new Error('No trigger to show');
  return (
    <>
      <button type="button" onClick={() => setActiveId(activeId === 'a' ? 'b' : 'a')}>
        Other trigger
      </button>
      <WebhookTriggerConfig
        node={active}
        onPatchLabel={() => undefined}
        onPatchConfig={(config) =>
          setNodes((all) =>
            all.map((n) => (n.id === activeId ? { ...n, config: { ...n.config, ...config } } : n)),
          )
        }
      />
    </>
  );
}

const filtersSwitch = () => screen.findByRole('switch', { name: 'Advanced filters' });

describe('WebhookTriggerConfig advanced filters', () => {
  it('starts on and shows the rows when filters are stored', async () => {
    renderWithTrpc(
      <SavedNode conditions={{ assignee: 'anyone', filters: [TITLE_FILTER] }} onSave={vi.fn()} />,
      answer,
    );

    expect(await filtersSwitch()).toBeChecked();
    expect(screen.getByDisplayValue('Retry')).toBeInTheDocument();
  });

  it('starts off when no filters are stored', async () => {
    renderWithTrpc(<SavedNode conditions={{ assignee: 'anyone' }} onSave={vi.fn()} />, answer);

    expect(await filtersSwitch()).not.toBeChecked();
    expect(screen.queryByPlaceholderText('Value...')).toBeNull();
  });

  it('removes the stored filters when switched off, keeping the other conditions', async () => {
    const onSave = vi.fn();
    const user = userEvent.setup();
    renderWithTrpc(
      <SavedNode conditions={{ assignee: 'anyone', filters: [TITLE_FILTER] }} onSave={onSave} />,
      answer,
    );

    await user.click(await filtersSwitch());

    expect(onSave.mock.lastCall?.[0].conditions).toEqual({ assignee: 'anyone' });
    expect(await filtersSwitch()).not.toBeChecked();
    expect(screen.queryByDisplayValue('Retry')).toBeNull();
  });

  it('keeps a new blank row on screen and the switch on after Add filter', async () => {
    const user = userEvent.setup();
    renderWithTrpc(<SavedNode conditions={{ assignee: 'anyone' }} onSave={vi.fn()} />, answer);

    await user.click(await filtersSwitch());
    await user.click(screen.getByRole('button', { name: 'Add filter' }));

    expect(screen.getAllByPlaceholderText('Value...')).toHaveLength(1);
    expect(await filtersSwitch()).toBeChecked();
  });

  it('keeps the same focused input while a value is typed', async () => {
    const onSave = vi.fn();
    renderWithTrpc(
      <SavedNode conditions={{ assignee: 'anyone', filters: [TITLE_FILTER] }} onSave={onSave} />,
      answer,
    );
    await filtersSwitch();
    const input = screen.getByDisplayValue('Retry');
    input.focus();

    fireEvent.change(input, { target: { value: 'Retry now' } });

    expect(onSave.mock.lastCall?.[0].conditions.filters).toEqual([
      { ...TITLE_FILTER, value: 'Retry now' },
    ]);
    expect(screen.getByDisplayValue('Retry now')).toBe(input);
    expect(input).toHaveFocus();
  });

  it('drops the old conditions and saves the only event when another integration is picked', async () => {
    const onSave = vi.fn();
    const user = userEvent.setup();
    renderWithTrpc(
      <SavedNode conditions={{ assignee: 'anyone', filters: [TITLE_FILTER] }} onSave={onSave} />,
      answer,
    );
    await filtersSwitch();

    await user.click(screen.getByRole('combobox', { name: 'Integration' }));
    await user.click(await screen.findByRole('option', { name: /Generic Webhook/ }));

    expect(onSave).toHaveBeenLastCalledWith(
      expect.objectContaining({ integrationId: 'hook-1', eventType: 'received', conditions: {} }),
    );
    expect(screen.queryByRole('switch', { name: 'Advanced filters' })).toBeNull();
    expect(screen.queryByDisplayValue('Retry')).toBeNull();
  });

  it("shows a trigger's own filters again after another trigger was shown", async () => {
    const user = userEvent.setup();
    renderWithTrpc(<TwoTriggers />, answer);
    await filtersSwitch();
    fireEvent.change(screen.getByDisplayValue('Retry'), { target: { value: 'Retry now' } });

    await user.click(screen.getByRole('button', { name: 'Other trigger' }));
    expect(await filtersSwitch()).not.toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Other trigger' }));

    expect(await filtersSwitch()).toBeChecked();
    expect(screen.getByDisplayValue('Retry now')).toBeInTheDocument();
  });

  it('reads on for a stored filter it cannot show, which blocks every event, and off removes it', async () => {
    const onSave = vi.fn();
    const user = userEvent.setup();
    const unreadable = { field: 'storyName', operator: 'regex', value: 'Retry' };
    renderWithTrpc(
      <SavedNode conditions={{ assignee: 'anyone', filters: [unreadable] }} onSave={onSave} />,
      answer,
    );

    expect(await filtersSwitch()).toBeChecked();
    await user.click(await filtersSwitch());

    expect(onSave.mock.lastCall?.[0].conditions).toEqual({ assignee: 'anyone' });
  });

  it('shows conditions changed from outside the panel after its own save', async () => {
    const user = userEvent.setup();
    renderWithTrpc(
      <SavedNode
        conditions={{ assignee: 'anyone', filters: [TITLE_FILTER] }}
        outsideEdit={{ assignee: 'anyone', filters: [TITLE_FILTER] }}
        onSave={vi.fn()}
      />,
      answer,
    );
    await filtersSwitch();
    fireEvent.change(screen.getByDisplayValue('Retry'), { target: { value: 'Retry now' } });

    await user.click(screen.getByRole('button', { name: 'Edit from outside' }));

    expect(screen.getByDisplayValue('Retry')).toBeInTheDocument();
  });
});
