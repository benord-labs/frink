// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithTrpc } from '@/lib/test-utils/render-with-trpc';
import { NodeModelField } from '.';

// `lib/trpc` wires its ipc client at import time, so the preload bridge must exist first.
vi.hoisted(() => {
  Object.assign(globalThis, {
    electronTRPC: { onMessage: () => () => undefined, sendMessage: () => undefined },
  });
});

afterEach(cleanup);

/** A free ChatGPT login's model list: no GPT-6 Astra. */
const freeCatalog = { tiers: { 'gpt-6-luna': [], 'gpt-5.5': [] }, defaultSlug: 'gpt-6-luna' };

describe('NodeModelField on a free Codex account', () => {
  it("offers a step only the models the account can use, so an unattended run can't hit one it lacks", async () => {
    renderWithTrpc(
      <NodeModelField
        model="codex-gpt-5.5-medium"
        flowDefaultModel={undefined}
        modelOptions={[]}
        isCodexProject
        inheritOptionLabel="Flow default"
        onModelChange={() => {}}
      />,
      ({ path }) =>
        path === 'usage.getCodexAccountCatalog'
          ? Promise.resolve(freeCatalog)
          : new Promise(() => {}),
    );

    fireEvent.click(screen.getByRole('button', { name: /GPT-5\.5/ }));
    fireEvent.click(screen.getByRole('button', { name: /Change model/ }));

    // Wait for the account's list itself: before it lands, every model is offered.
    await waitFor(() => expect(screen.queryByRole('option', { name: 'GPT-6 Astra' })).toBeNull());
    expect(screen.getByRole('option', { name: 'GPT-6 Luna' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'GPT-5.5', selected: true })).toBeInTheDocument();
  });
});
