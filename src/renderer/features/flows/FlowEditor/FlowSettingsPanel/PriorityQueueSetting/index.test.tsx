// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ReactElement, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithTrpc } from '@/lib/test-utils/render-with-trpc';
import type { FlowNode } from '../../../../../../shared/lib/validate-flow-graph';
import type { FlowSettings } from '../../../../../../shared/types/flow';
import { PriorityQueueSetting } from '.';

// `lib/trpc` wires its ipc client at import time, so the preload bridge must exist first.
vi.hoisted(() => {
  Object.assign(globalThis, {
    electronTRPC: { onMessage: () => () => undefined, sendMessage: () => undefined },
  });
});

afterEach(cleanup);

const WEBHOOK_TRIGGER: FlowNode = {
  id: 'trigger',
  blockType: 'webhook_trigger',
  config: { integrationId: 'shortcut-1', eventType: 'story_assigned' },
};
const BLANK = { detail: '', operator: 'contains' as const, value: '' };

function answer({ path }: { path: string }) {
  return path === 'integrations.list'
    ? Promise.resolve([{ id: 'shortcut-1', provider: 'shortcut' }])
    : new Promise(() => {});
}

/** Keeps the settings the control saves and renders it from them again, as the panel does. */
function SavedSettings(props: {
  initial?: FlowSettings;
  triggerBlockType?: string;
  onSave: (settings: FlowSettings) => void;
}): ReactElement {
  const [settings, setSettings] = useState(props.initial);
  return (
    <PriorityQueueSetting
      settings={settings}
      nodes={[WEBHOOK_TRIGGER]}
      triggerBlockType={props.triggerBlockType ?? 'webhook_trigger'}
      onSettingsChange={(next) => {
        props.onSave(next);
        setSettings(next);
      }}
    />
  );
}

async function choose(user: ReturnType<typeof userEvent.setup>, option: string) {
  await user.click(screen.getByRole('combobox', { name: 'Priority queue' }));
  await user.click(await screen.findByRole('option', { name: option }));
}

describe('PriorityQueueSetting', () => {
  it('writes only the setting the chosen mode needs', async () => {
    const onSave = vi.fn();
    const user = userEvent.setup();
    renderWithTrpc(<SavedSettings onSave={onSave} />, answer);

    await choose(user, 'Every new run');
    expect(onSave).toHaveBeenLastCalledWith({ runFirst: true, runFirstWhen: undefined });
    await choose(user, 'Only runs that match');
    expect(onSave).toHaveBeenLastCalledWith({ runFirst: undefined, runFirstWhen: [BLANK] });
    expect(screen.getByText(/This rule isn't active yet/)).toBeInTheDocument();
    await choose(user, 'Off');
    expect(onSave).toHaveBeenLastCalledWith({ runFirst: undefined, runFirstWhen: undefined });
  });

  it('saves rows as typed, and switches off when the last row is removed', () => {
    const onSave = vi.fn();
    renderWithTrpc(<SavedSettings initial={{ runFirstWhen: [BLANK] }} onSave={onSave} />, answer);

    fireEvent.change(screen.getByRole('combobox', { name: 'Detail' }), {
      target: { value: '{{trigger.story.title}}' },
    });
    fireEvent.change(screen.getByPlaceholderText('Value...'), { target: { value: 'Retry ' } });

    expect(onSave).toHaveBeenLastCalledWith({
      runFirstWhen: [{ detail: '{{trigger.story.title}}', operator: 'contains', value: 'Retry ' }],
    });
    expect(screen.getByText(/Runs whose details match every row/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(onSave).toHaveBeenLastCalledWith({ runFirstWhen: undefined });
    expect(screen.getByRole('combobox', { name: 'Priority queue' })).toHaveTextContent('Off');
  });

  it('stops at ten rows and trims a long paste to what settings accept', () => {
    const onSave = vi.fn();
    const rows = Array.from({ length: 10 }, () => ({ ...BLANK, detail: 'trigger.story.title' }));
    renderWithTrpc(<SavedSettings initial={{ runFirstWhen: rows }} onSave={onSave} />, answer);

    expect(screen.queryByRole('button', { name: 'Add row' })).toBeNull();
    const [firstValue] = screen.getAllByPlaceholderText('Value...');
    if (!firstValue) throw new Error('The first row has no value input');
    fireEvent.change(firstValue, { target: { value: 'x'.repeat(600) } });
    expect(onSave.mock.lastCall?.[0].runFirstWhen[0].value).toHaveLength(500);
  });

  it('keeps a saved rule visible on a scheduled flow and explains why it cannot be chosen', async () => {
    const user = userEvent.setup();
    renderWithTrpc(
      <SavedSettings
        initial={{ runFirstWhen: [BLANK] }}
        triggerBlockType="schedule_trigger"
        onSave={vi.fn()}
      />,
      answer,
    );

    expect(screen.getByText(/Every run of this flow looks the same/)).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Value...')).toBeInTheDocument();
    await user.click(screen.getByRole('combobox', { name: 'Priority queue' }));
    expect(await screen.findByRole('option', { name: 'Only runs that match' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  it("adds a row, and suggests a batch flow's declared inputs", () => {
    const onSave = vi.fn();
    const batchTriggerSchema = [{ key: 'ticketId', type: 'string' as const }];
    renderWithTrpc(
      <SavedSettings
        initial={{ runFirstWhen: [BLANK], batchTriggerSchema }}
        triggerBlockType="manual_trigger"
        onSave={onSave}
      />,
      answer,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Add row' }));

    expect(onSave.mock.lastCall?.[0].runFirstWhen).toEqual([BLANK, BLANK]);
    expect(document.querySelector('option[value="trigger.ticketId"]')).not.toBeNull();
  });

  it("suggests the trigger's details", async () => {
    renderWithTrpc(<SavedSettings initial={{ runFirstWhen: [BLANK] }} onSave={vi.fn()} />, answer);

    await waitFor(() =>
      expect(document.querySelector('option[value="trigger.story.title"]')).not.toBeNull(),
    );
    expect(screen.getByRole('combobox', { name: 'Detail' })).toHaveAttribute(
      'placeholder',
      'e.g. trigger.story.title',
    );
  });
});
