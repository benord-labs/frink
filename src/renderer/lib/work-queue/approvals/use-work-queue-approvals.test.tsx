// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { TRPCClientError } from '@trpc/client';
import { observable } from '@trpc/server/observable';
import type { ReactNode } from 'react';
import { toast } from 'sonner';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { activeOverlayAtom, flowsFocusRunAtom, flowsSelectedFlowIdAtom } from '../../atoms';
import { appStore } from '../../jotai-store';
import { trpc } from '../../trpc';
import {
  type AwaitingApproval,
  useApprovalActions,
  useAwaitingApprovals,
} from './use-work-queue-approvals';

// `lib/trpc` wires its ipc client at import time, so the preload bridge must exist first.
vi.hoisted(() => {
  Object.assign(globalThis, {
    electronTRPC: { onMessage: () => () => undefined, sendMessage: () => undefined },
  });
});

const gate = (flowRunId: string): AwaitingApproval => ({
  flowRunId,
  flowId: 'flow-1',
  flowName: 'Release train',
  projectName: 'frink-oss',
  gateCount: 1,
  nodeRunId: `gate-${flowRunId}`,
  message: 'Deploy the release branch to staging?',
  waitingSince: new Date('2026-10-14T14:41:00.000Z'),
});

type ProcedureCall = { path: string; input: unknown };

/** The main process, in-process: the approvals list plus a scripted answer to each action. */
type FakeMain = { listed: AwaitingApproval[]; calls: ProcedureCall[]; answer: () => Promise<null> };
const server: FakeMain = { listed: [], calls: [], answer: async () => null };

function createTestClient() {
  return trpc.createClient({
    links: [
      () =>
        ({ op }) =>
          observable((observer) => {
            server.calls.push({ path: op.path, input: op.input });
            const reply =
              op.path === 'flows.workQueueApprovals'
                ? Promise.resolve(server.listed)
                : server.answer();
            reply.then(
              (data) => {
                observer.next({ result: { data } });
                observer.complete();
              },
              (error: Error) => observer.error(TRPCClientError.from(error)),
            );
          }),
    ],
  });
}

function renderApprovals() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const client = createTestClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <trpc.Provider client={client} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </trpc.Provider>
  );
  return renderHook(() => ({ gates: useAwaitingApprovals(), actions: useApprovalActions() }), {
    wrapper,
  });
}

beforeEach(() => {
  server.listed = [gate('run-1'), gate('run-2')];
  server.calls = [];
  server.answer = async () => null;
  vi.restoreAllMocks();
});

describe('Work Queue approval actions', () => {
  it("approves with the Runs panel's resume and holds only that run until the queue refreshes", async () => {
    let release: () => void = () => undefined;
    server.answer = () =>
      new Promise<null>((resolve) => {
        release = () => resolve(null);
      });
    const { result } = renderApprovals();
    await waitFor(() => expect(result.current.gates).toHaveLength(2));

    act(() => result.current.actions.approve(result.current.gates[0]));

    expect(result.current.actions.pending).toEqual(new Map([['run-1', 'approve']]));
    await waitFor(() =>
      expect(server.calls).toContainEqual({
        path: 'flows.resumeRun',
        input: { runId: 'run-1', action: 'approve', nodeRunId: 'gate-run-1' },
      }),
    );
    server.listed = [gate('run-2')];
    act(() => release());
    await waitFor(() => expect(result.current.actions.pending.size).toBe(0));
    expect(result.current.gates.map((item) => item.flowRunId)).toEqual(['run-2']);
  });

  it('reads a refusal as already handled once the gate has left the queue', async () => {
    const info = vi.spyOn(toast, 'info');
    server.answer = async () => {
      server.listed = [];
      throw new Error('Flow run is cancelled; resume requires paused state.');
    };
    const { result } = renderApprovals();
    await waitFor(() => expect(result.current.gates).toHaveLength(2));

    act(() => result.current.actions.approve(result.current.gates[0]));

    await waitFor(() =>
      expect(info).toHaveBeenCalledWith('Already handled', {
        description: 'This approval was answered, or its run stopped, somewhere else.',
      }),
    );
  });

  it("shows the server's reason while the gate still waits", async () => {
    const error = vi.spyOn(toast, 'error');
    const lostSlot =
      'This paused Flow lost its place in the run queue. Cancel it and start it again.';
    server.answer = async () => {
      throw new Error(lostSlot);
    };
    const { result } = renderApprovals();
    await waitFor(() => expect(result.current.gates).toHaveLength(2));

    act(() => result.current.actions.approve(result.current.gates[0]));

    await waitFor(() =>
      expect(error).toHaveBeenCalledWith('Could not approve', { description: lostSlot }),
    );
    expect(result.current.gates).toHaveLength(2);
  });

  it('cancels the run, and opens the run in its Flow editor', async () => {
    const { result } = renderApprovals();
    await waitFor(() => expect(result.current.gates).toHaveLength(2));

    act(() => result.current.actions.cancel(result.current.gates[1]));
    act(() => result.current.actions.openRun(result.current.gates[0]));

    await waitFor(() =>
      expect(server.calls).toContainEqual({ path: 'flows.cancelRun', input: { runId: 'run-2' } }),
    );
    expect(appStore.get(flowsFocusRunAtom)).toEqual({ flowId: 'flow-1', runId: 'run-1' });
    expect(appStore.get(flowsSelectedFlowIdAtom)).toBe('flow-1');
    expect(appStore.get(activeOverlayAtom)).toBe('flows');
  });
});
