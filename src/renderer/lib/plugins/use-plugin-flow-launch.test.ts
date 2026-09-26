// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react';
import { getDefaultStore } from 'jotai';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginTrigger } from '../../../shared/integrations/plugins';
import { activeOverlayAtom, flowsSelectedFlowIdAtom } from '../atoms';
import { usePluginFlowLaunch } from './use-plugin-flow-launch';

const { useMutationMock, mutateMock, saveFlowDraftMock, toastErrorMock } = vi.hoisted(() => ({
  useMutationMock: vi.fn(),
  mutateMock: vi.fn(),
  saveFlowDraftMock: vi.fn(),
  toastErrorMock: vi.fn(),
}));

vi.mock('../trpc', () => ({
  trpc: { flows: { create: { useMutation: useMutationMock } } },
}));

vi.mock('../flow-drafts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../flow-drafts')>()),
  saveFlowDraft: saveFlowDraftMock,
}));

vi.mock('sonner', () => ({ toast: { error: toastErrorMock } }));

const TRIGGER: PluginTrigger = {
  id: 'shortcut.story_moved',
  label: 'Story moved',
  filterFieldIds: [],
  source: { type: 'provider_event', providerId: 'shortcut', eventId: 'story_moved' },
};

const LAUNCH = { pluginName: 'Shortcut', trigger: TRIGGER, connectionId: 'conn-1' };

const store = getDefaultStore();

function launch(input = LAUNCH) {
  const { result } = renderHook(() => usePluginFlowLaunch());
  result.current(input);
}

beforeEach(() => {
  vi.clearAllMocks();
  useMutationMock.mockReturnValue({ mutate: mutateMock, isPending: false });
  store.set(flowsSelectedFlowIdAtom, null);
  store.set(activeOverlayAtom, null);
});

describe('usePluginFlowLaunch', () => {
  it('creates the flow, seeds its draft, then navigates — in that order', () => {
    let flowIdAtDraftTime: string | null = 'unset';
    mutateMock.mockImplementation((_input, opts) => opts.onSuccess({ id: 'flow-1' }));
    saveFlowDraftMock.mockImplementation(() => {
      flowIdAtDraftTime = store.get(flowsSelectedFlowIdAtom);
    });

    launch();

    expect(mutateMock).toHaveBeenCalledWith({ name: 'Shortcut: Story moved' }, expect.anything());
    expect(saveFlowDraftMock).toHaveBeenCalledWith('flow-1', {
      graph: expect.objectContaining({ nodes: expect.anything() }),
      baselineVersion: 0,
      updatedAt: expect.any(Number),
    });
    // Draft after create (it needs the created id), navigation after draft (the
    // editor hydrates whatever is stored the moment the flow id lands).
    expect(mutateMock.mock.invocationCallOrder[0]).toBeLessThan(
      saveFlowDraftMock.mock.invocationCallOrder[0] as number,
    );
    expect(flowIdAtDraftTime).toBeNull();
    expect(store.get(flowsSelectedFlowIdAtom)).toBe('flow-1');
    expect(store.get(activeOverlayAtom)).toBe('flows');
  });

  it('drafts the 4-node graph bound to the trigger and connection', () => {
    mutateMock.mockImplementation((_input, opts) => opts.onSuccess({ id: 'flow-1' }));

    launch();

    const { graph } = saveFlowDraftMock.mock.calls[0]?.[1] ?? {};
    expect(graph.nodes.map((node: { blockType: string }) => node.blockType)).toEqual([
      'webhook_trigger',
      'start_task',
      'agent',
      'end',
    ]);
    expect(graph.nodes[0].config).toEqual({ integrationId: 'conn-1', eventType: 'story_moved' });
  });

  it('surfaces a failed create and never drafts or navigates', () => {
    mutateMock.mockImplementation((_input, opts) => opts.onError(new Error('offline')));

    launch();

    expect(toastErrorMock).toHaveBeenCalledTimes(1);
    expect(saveFlowDraftMock).not.toHaveBeenCalled();
    expect(store.get(flowsSelectedFlowIdAtom)).toBeNull();
    expect(store.get(activeOverlayAtom)).toBeNull();
  });

  it('ignores a click while a create is already pending', () => {
    useMutationMock.mockReturnValue({ mutate: mutateMock, isPending: true });

    launch();

    expect(mutateMock).not.toHaveBeenCalled();
  });
});
