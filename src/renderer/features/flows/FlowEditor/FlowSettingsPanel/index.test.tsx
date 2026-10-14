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

describe('FlowSettingsPanel Auto Mode row', () => {
  const renderPanel = (autoReviewTools: boolean | undefined, asked: string[] = []) =>
    renderWithTrpc(
      <FlowSettingsPanel
        flowId="flow-1"
        flowName="Nightly"
        flowDescription={null}
        isEnabled
        agentInvocable={false}
        settings={{ autoReviewTools }}
        nodes={[]}
        onSettingsChange={() => {}}
        onClose={() => {}}
      />,
      ({ path }) => {
        asked.push(path);
        return path === 'claudeSettings.autoModeRules'
          ? Promise.resolve({ allow: 0, block: 3, environment: 0 })
          : new Promise(() => {});
      },
    );

  // A Flow with Auto Mode off has no reviewer, so claiming the user's rules apply would mislead.
  it("names the user's own rules only while the Flow's Auto Mode is on", async () => {
    const { unmount } = renderPanel(undefined);
    expect(await screen.findByText(/3 blocked\.$/)).toBeInTheDocument();
    unmount();

    const asked: string[] = [];
    renderPanel(false, asked);
    expect(screen.getByRole('switch', { name: 'Auto Mode' })).not.toBeChecked();
    // The panel's other queries have gone out, so the rules query would have too.
    await waitFor(() => expect(asked.length).toBeGreaterThan(0));
    expect(asked).not.toContain('claudeSettings.autoModeRules');
    expect(screen.queryByText(/Auto Mode rules you set/)).toBeNull();
  });
});
