// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithTrpc } from '@/lib/test-utils/render-with-trpc';
import { FlowSettingsPanel } from '.';

// `lib/trpc` wires its ipc client at import time, so the preload bridge must exist first.
vi.hoisted(() => {
  Object.assign(globalThis, {
    electronTRPC: { onMessage: () => () => undefined, sendMessage: () => undefined },
  });
});

afterEach(cleanup);

/** A free ChatGPT login's model list: no GPT-6 Astra. */
const freeCatalog = { tiers: { 'gpt-6-luna': [], 'gpt-5.5': [] }, defaultSlug: 'gpt-6-luna' };
const codexAccount = { type: 'codex', label: 'Codex', isAuthenticated: true };

describe('FlowSettingsPanel on a free Codex project', () => {
  it('offers the flow default only the models the account can use', async () => {
    renderWithTrpc(
      <FlowSettingsPanel
        flowId="flow-1"
        flowName="Nightly"
        flowDescription={null}
        isEnabled
        agentInvocable={false}
        settings={{ defaultProjectId: 'project-1', defaultModel: 'codex-gpt-5.5-medium' }}
        nodes={[]}
        onSettingsChange={() => {}}
        onClose={() => {}}
      />,
      ({ path }) => {
        if (path === 'claudeCode.getResolvedAccount') return Promise.resolve(codexAccount);
        if (path === 'usage.getCodexAccountCatalog') return Promise.resolve(freeCatalog);
        return new Promise(() => {});
      },
    );

    const trigger = screen.getByRole('button', { name: 'Default model' });
    // The Codex rows appear once the project resolves to the Codex account.
    await waitFor(() => expect(trigger).toHaveTextContent('GPT-5.5'));
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('button', { name: /Change model/ }));

    // Wait for the account's list itself: before it lands, every model is offered.
    await waitFor(() => expect(screen.queryByRole('option', { name: 'GPT-6 Astra' })).toBeNull());
    expect(screen.getByRole('option', { name: 'GPT-6 Luna' })).toBeInTheDocument();
  });
});

describe('FlowSettingsPanel on an OpenCode project', () => {
  it('says Flows run on Claude or OpenAI, with no picker or step-override hint', async () => {
    renderWithTrpc(
      <FlowSettingsPanel
        flowId="flow-1"
        flowName="Nightly"
        flowDescription={null}
        isEnabled
        agentInvocable={false}
        settings={{ defaultProjectId: 'project-1' }}
        nodes={[]}
        onSettingsChange={() => {}}
        onClose={() => {}}
      />,
      ({ path }) =>
        path === 'claudeCode.getResolvedAccount'
          ? Promise.resolve({ type: 'opencode', label: 'OpenCode', isAuthenticated: true })
          : new Promise(() => {}),
    );

    await waitFor(() =>
      expect(
        screen.getByText('This project uses OpenCode. Flows run on Claude or OpenAI for now.'),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByRole('button', { name: 'Default model' })).toBeNull();
    expect(screen.queryByText('Individual steps can override this.')).toBeNull();
  });
});

const panelProps = {
  flowId: 'flow-1',
  flowName: 'Daily digest',
  flowDescription: null,
  isEnabled: true,
  agentInvocable: false,
  settings: {},
  nodes: [],
  onSettingsChange: () => {},
  onClose: () => {},
};

describe('FlowSettingsPanel toggles', () => {
  it('names every switch by its setting', () => {
    renderWithTrpc(<FlowSettingsPanel {...panelProps} />, () => new Promise(() => {}));

    for (const name of [
      'Flow enabled',
      'Allow agents to run this flow',
      'Pause on failure',
      'Auto-accept completed runs',
      'Auto Mode',
    ]) {
      expect(screen.getByRole('switch', { name })).toBeInTheDocument();
    }
  });

  it('holds Flow enabled while the save is pending, then reverts it when the save fails', async () => {
    let rejectSave: (err: Error) => void = () => {};
    renderWithTrpc(<FlowSettingsPanel {...panelProps} />, ({ path }) =>
      path === 'flows.update'
        ? new Promise((_, reject) => {
            rejectSave = reject;
          })
        : new Promise(() => {}),
    );

    const toggle = screen.getByRole('switch', { name: 'Flow enabled' });
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle).toBeDisabled());
    expect(toggle).not.toBeChecked();

    rejectSave(new Error('save failed'));
    await waitFor(() => expect(toggle).toBeEnabled());
    expect(toggle).toBeChecked();
  });

  it('saves Allow agents as agent_invocable and holds Flow enabled until that save lands', async () => {
    const saves: unknown[] = [];
    renderWithTrpc(<FlowSettingsPanel {...panelProps} />, ({ path, input }) => {
      if (path === 'flows.update') saves.push(input);
      return new Promise(() => {});
    });

    fireEvent.click(screen.getByRole('switch', { name: 'Allow agents to run this flow' }));
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: 'Flow enabled' })).toBeDisabled(),
    );
    // biome-ignore lint/style/useNamingConvention: DB field name
    expect(saves).toEqual([{ id: 'flow-1', agent_invocable: true }]);
  });

  it.each([
    ['Pause on failure', { pauseOnFailure: true }],
    ['Auto-accept completed runs', { autoAcceptCompletedRuns: true }],
    ['Auto Mode', { autoReviewTools: false }],
  ])('saves %s to its own setting', (name, expected) => {
    const onSettingsChange = vi.fn();
    renderWithTrpc(
      <FlowSettingsPanel {...panelProps} onSettingsChange={onSettingsChange} />,
      () => new Promise(() => {}),
    );

    fireEvent.click(screen.getByRole('switch', { name }));
    expect(onSettingsChange).toHaveBeenLastCalledWith(expected);
  });
});

describe('FlowSettingsPanel briefing counter', () => {
  it.each([
    [500, false],
    [499, true],
  ])('with %i chars left, warns: %s', (left, warns) => {
    renderWithTrpc(
      <FlowSettingsPanel {...panelProps} settings={{ briefing: 'x'.repeat(10000 - left) }} />,
      () => new Promise(() => {}),
    );

    const counter = screen.getByText(`${left} chars left`);
    expect(counter.classList.contains('text-warning')).toBe(warns);
  });
});

describe('FlowSettingsPanel priority queue toggle', () => {
  it('saves Priority queue as runFirst and clears it when turned off', async () => {
    const onSettingsChange = vi.fn();
    const props = {
      flowId: 'flow-1',
      flowName: 'Daily digest',
      flowDescription: null,
      isEnabled: true,
      agentInvocable: false,
      nodes: [],
      onSettingsChange,
      onClose: () => {},
    };
    const { rerender } = renderWithTrpc(
      <FlowSettingsPanel {...props} settings={{}} />,
      () => new Promise(() => {}),
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole('combobox', { name: 'Priority queue' }));
    await user.click(await screen.findByRole('option', { name: 'Every new run' }));
    expect(onSettingsChange).toHaveBeenLastCalledWith(expect.objectContaining({ runFirst: true }));

    rerender(<FlowSettingsPanel {...props} settings={{ runFirst: true }} />);
    expect(screen.getByRole('combobox', { name: 'Priority queue' })).toHaveTextContent(
      'Every new run',
    );
    await user.click(screen.getByRole('combobox', { name: 'Priority queue' }));
    await user.click(await screen.findByRole('option', { name: 'Off' }));
    expect(onSettingsChange.mock.lastCall?.[0]).not.toHaveProperty('runFirst', true);
  });
});
