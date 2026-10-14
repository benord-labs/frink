// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest';
import { cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { newTestQueryClient, renderWithTrpc } from '@/lib/test-utils/render-with-trpc';
import { AutoModeRulesNote, autoModeRulesSummary } from '.';

// `lib/trpc` wires its ipc client at import time, so the preload bridge must exist first.
vi.hoisted(() => {
  Object.assign(globalThis, {
    electronTRPC: { onMessage: () => () => undefined, sendMessage: () => undefined },
  });
});

afterEach(cleanup);

describe('autoModeRulesSummary', () => {
  it('names only the kinds of rule the user wrote', () => {
    expect(autoModeRulesSummary({ allow: 4, block: 5, environment: 42 })).toBe(
      'Claude steps also follow the Auto Mode rules you set in Claude Code: 4 allowed, 5 blocked, 42 about your setup.',
    );
    expect(autoModeRulesSummary({ allow: 0, block: 1, environment: 0 })).toBe(
      'Claude steps also follow the Auto Mode rules you set in Claude Code: 1 blocked.',
    );
    expect(autoModeRulesSummary({ allow: 0, block: 0, environment: 0 })).toBeNull();
  });
});

describe('AutoModeRulesNote', () => {
  it("shows the user's rules, and nothing when there are none", async () => {
    const { unmount } = renderWithTrpc(<AutoModeRulesNote settings={undefined} />, ({ path }) =>
      path === 'claudeSettings.autoModeRules'
        ? Promise.resolve({ allow: 2, block: 0, environment: 0 })
        : new Promise(() => {}),
    );
    expect(await screen.findByText(/2 allowed\.$/)).toBeInTheDocument();
    unmount();

    const queryClient = newTestQueryClient();
    const { container } = renderWithTrpc(
      <AutoModeRulesNote settings={undefined} />,
      () => Promise.resolve({ allow: 0, block: 0, environment: 0 }),
      queryClient,
    );
    await waitFor(() =>
      expect(queryClient.getQueryCache().getAll()[0]?.state.status).toBe('success'),
    );
    expect(container).toBeEmptyDOMElement();
  });
});
