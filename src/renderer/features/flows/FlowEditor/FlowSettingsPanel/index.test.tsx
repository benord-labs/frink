// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
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

describe('FlowSettingsPanel priority queue toggle', () => {
  it('saves Priority queue as runFirst and clears it when switched off', () => {
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

    fireEvent.click(screen.getByRole('switch', { name: 'Priority queue' }));
    expect(onSettingsChange).toHaveBeenLastCalledWith(expect.objectContaining({ runFirst: true }));

    rerender(<FlowSettingsPanel {...props} settings={{ runFirst: true }} />);
    const toggle = screen.getByRole('switch', { name: 'Priority queue' });
    expect(toggle).toBeChecked();
    fireEvent.click(toggle);
    expect(onSettingsChange.mock.lastCall?.[0]).not.toHaveProperty('runFirst', true);
  });
});
