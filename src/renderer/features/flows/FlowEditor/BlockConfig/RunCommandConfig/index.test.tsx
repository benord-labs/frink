// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithTrpc } from '@/lib/test-utils/render-with-trpc';
import { TooltipProvider } from '@/components/ui/tooltip';
import { RunCommandConfig } from '.';

// `lib/trpc` wires its ipc client at import time, so the preload bridge must exist first.
vi.hoisted(() => {
  Object.assign(globalThis, {
    electronTRPC: { onMessage: () => () => undefined, sendMessage: () => undefined },
  });
});

afterEach(cleanup);

describe('RunCommandConfig project', () => {
  it("says when the step's project isn't on this computer", async () => {
    renderWithTrpc(
      <TooltipProvider>
        <RunCommandConfig
          node={{
            id: 'cmd-1',
            blockType: 'run_command',
            config: { command: 'npm test', projectId: 'gone' },
          }}
          onPatchLabel={() => {}}
          onConfigPatch={() => {}}
        />
      </TooltipProvider>,
      ({ path }) =>
        path === 'projects.list'
          ? Promise.resolve([{ id: 'p-api', name: 'api', path: '/code/api' }])
          : new Promise(() => {}),
    );

    expect(
      await screen.findByText("The project “gone” isn't on this computer. Pick a project."),
    ).toBeInTheDocument();
  });
});
