// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FlowExecutionEvent } from '../../shared/types/flow';

// --- Hoisted mocks (must be declared before vi.mock calls) ---

const mockIsDesktopApp = vi.hoisted(() => vi.fn(() => true));

const mockToastSuccess = vi.hoisted(() => vi.fn());
const mockToastError = vi.hoisted(() => vi.fn());
const mockToastInfo = vi.hoisted(() => vi.fn());

const mockAppStoreSet = vi.hoisted(() => vi.fn());
const mockAppStoreGet = vi.hoisted(() => vi.fn((_atom: unknown) => false));
const mockPlaySound = vi.hoisted(() => vi.fn());

vi.mock('../lib/utils/platform', () => ({
  isDesktopApp: mockIsDesktopApp,
}));

vi.mock('sonner', () => ({
  toast: {
    success: mockToastSuccess,
    error: mockToastError,
    info: mockToastInfo,
  },
}));

vi.mock('../lib/jotai-store', () => ({
  // `get` serves the sound away-rule (flowEventSound reads sound/overlay atoms);
  // defaulting to false keeps sounds a no-op so toast assertions are unaffected.
  appStore: { set: mockAppStoreSet, get: mockAppStoreGet },
}));

vi.mock('../lib/audio/play-chime', () => ({
  playSound: mockPlaySound,
}));

// Imported after mocks so the module picks up the mocked dependencies.
import { navigateToFlow, useFlowExecutionEvents } from './use-flow-execution-events';

// --- Desktop API helpers ---

let onExecutionEventCallback: ((event: FlowExecutionEvent) => void) | null = null;
const onSocketFlowExecutionEventCleanup = vi.fn();

function setupDesktopApi() {
  Object.defineProperty(window, 'desktopApi', {
    writable: true,
    configurable: true,
    value: {
      onSocketFlowExecutionEvent: (cb: (event: FlowExecutionEvent) => void) => {
        onExecutionEventCallback = cb;
        return onSocketFlowExecutionEventCleanup;
      },
    },
  });
}

function makeEvent(
  overrides: Partial<FlowExecutionEvent> & { eventType: FlowExecutionEvent['eventType'] },
): FlowExecutionEvent {
  return {
    flowId: 'flow-1',
    flowRunId: 'run-1',
    flowName: 'My Flow',
    runStatus: 'completed',
    ...overrides,
  };
}

function injectEvent(
  overrides: Partial<FlowExecutionEvent> & { eventType: FlowExecutionEvent['eventType'] },
) {
  act(() => {
    onExecutionEventCallback?.(makeEvent(overrides));
  });
}

// --- Tests ---

describe('useFlowExecutionEvents', () => {
  beforeEach(() => {
    onExecutionEventCallback = null;
    mockIsDesktopApp.mockReturnValue(true);
    onSocketFlowExecutionEventCleanup.mockReset();
    mockToastSuccess.mockReset();
    mockToastError.mockReset();
    mockToastInfo.mockReset();
    mockAppStoreSet.mockReset();
    setupDesktopApi();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('registers listener via onSocketFlowExecutionEvent on mount', () => {
    renderHook(() => useFlowExecutionEvents());
    expect(onExecutionEventCallback).toBeTypeOf('function');
  });

  it('run_completed fires toast.success with flowName as title', () => {
    renderHook(() => useFlowExecutionEvents());
    injectEvent({ eventType: 'run_completed', flowName: 'My Flow', summary: 'Done in 2.1s' });
    expect(mockToastSuccess).toHaveBeenCalledOnce();
    expect(mockToastSuccess).toHaveBeenCalledWith(
      'My Flow',
      expect.objectContaining({ description: 'Done in 2.1s' }),
    );
  });

  it('run_completed uses fallback description when summary is absent', () => {
    renderHook(() => useFlowExecutionEvents());
    injectEvent({ eventType: 'run_completed', flowName: 'My Flow' });
    expect(mockToastSuccess).toHaveBeenCalledWith(
      'My Flow',
      expect.objectContaining({ description: 'Flow run completed.' }),
    );
  });

  it('run_failed fires toast.error with flowName as title', () => {
    renderHook(() => useFlowExecutionEvents());
    injectEvent({
      eventType: 'run_failed',
      flowName: 'Failing Flow',
      summary: 'Failed at Agent Task',
      runStatus: 'failed',
    });
    expect(mockToastError).toHaveBeenCalledOnce();
    expect(mockToastError).toHaveBeenCalledWith(
      'Failing Flow',
      expect.objectContaining({ description: 'Failed at Agent Task' }),
    );
  });

  it('run_failed uses fallback description when summary is absent', () => {
    renderHook(() => useFlowExecutionEvents());
    injectEvent({ eventType: 'run_failed', runStatus: 'failed' });
    expect(mockToastError).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ description: 'Flow run failed.' }),
    );
  });

  it('run_cancelled fires toast.info with "Run was cancelled." description', () => {
    renderHook(() => useFlowExecutionEvents());
    injectEvent({ eventType: 'run_cancelled', runStatus: 'cancelled' });
    expect(mockToastInfo).toHaveBeenCalledOnce();
    expect(mockToastInfo).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ description: 'Run was cancelled.' }),
    );
  });

  it('run_started fires no toast (start events are intentionally silent)', () => {
    renderHook(() => useFlowExecutionEvents());
    injectEvent({ eventType: 'run_started', runStatus: 'running' });
    expect(mockToastSuccess).not.toHaveBeenCalled();
    expect(mockToastError).not.toHaveBeenCalled();
    expect(mockToastInfo).not.toHaveBeenCalled();
  });

  it('node_completed fires no toast (node events are Phase 2)', () => {
    renderHook(() => useFlowExecutionEvents());
    injectEvent({ eventType: 'node_completed', runStatus: 'running' });
    expect(mockToastSuccess).not.toHaveBeenCalled();
    expect(mockToastError).not.toHaveBeenCalled();
    expect(mockToastInfo).not.toHaveBeenCalled();
  });

  it('toast action has label "View"', () => {
    renderHook(() => useFlowExecutionEvents());
    injectEvent({ eventType: 'run_completed' });
    const opts = mockToastSuccess.mock.calls[0]?.[1] as Record<string, unknown>;
    expect((opts?.action as { label: string })?.label).toBe('View');
  });

  it('toast action onClick does not throw', () => {
    renderHook(() => useFlowExecutionEvents());
    injectEvent({ eventType: 'run_completed' });
    const opts = mockToastSuccess.mock.calls[0]?.[1] as Record<string, unknown>;
    const action = opts?.action as { onClick: () => void };
    expect(() => action.onClick()).not.toThrow();
  });

  it('cleanup function is called when the hook unmounts', () => {
    const { unmount } = renderHook(() => useFlowExecutionEvents());
    unmount();
    expect(onSocketFlowExecutionEventCleanup).toHaveBeenCalledOnce();
  });

  it('events for different flowIds both fire toasts (no per-flow filter in global hook)', () => {
    renderHook(() => useFlowExecutionEvents());
    injectEvent({ eventType: 'run_completed', flowId: 'flow-1', flowName: 'Flow A' });
    injectEvent({ eventType: 'run_completed', flowId: 'flow-2', flowName: 'Flow B' });
    expect(mockToastSuccess).toHaveBeenCalledTimes(2);
    expect(mockToastSuccess.mock.calls[0]?.[0]).toBe('Flow A');
    expect(mockToastSuccess.mock.calls[1]?.[0]).toBe('Flow B');
  });

  it('does nothing when not in a desktop app', () => {
    mockIsDesktopApp.mockReturnValue(false);
    renderHook(() => useFlowExecutionEvents());
    // Effect returns early — listener is never registered
    expect(onExecutionEventCallback).toBeNull();
    injectEvent({ eventType: 'run_completed' });
    expect(mockToastSuccess).not.toHaveBeenCalled();
  });

  it('does not throw when onSocketFlowExecutionEvent is undefined', () => {
    Object.defineProperty(window, 'desktopApi', {
      writable: true,
      configurable: true,
      value: {},
    });
    expect(() => renderHook(() => useFlowExecutionEvents())).not.toThrow();
  });
});

describe('sound dispatch', () => {
  beforeEach(async () => {
    onExecutionEventCallback = null;
    mockIsDesktopApp.mockReturnValue(true);
    setupDesktopApi();
    const { soundNotificationsEnabledAtom } = await import('../lib/atoms');
    // Sound on; overlay atoms keep returning false → user is "away".
    mockAppStoreGet.mockImplementation((atom: unknown) => atom === soundNotificationsEnabledAtom);
    mockPlaySound.mockReset();
    mockToastInfo.mockReset();
  });

  afterEach(() => {
    mockAppStoreGet.mockImplementation(() => false);
  });

  it('run_failed plays the failed sound — never the success chime', () => {
    renderHook(() => useFlowExecutionEvents());
    injectEvent({ eventType: 'run_failed', runStatus: 'failed' });
    expect(mockPlaySound).toHaveBeenCalledExactlyOnceWith('failed');
  });

  it('run_completed plays flowComplete', () => {
    renderHook(() => useFlowExecutionEvents());
    injectEvent({ eventType: 'run_completed' });
    expect(mockPlaySound).toHaveBeenCalledExactlyOnceWith('flowComplete');
  });

  it('batch_completed plays the batch landing; a member run stays silent', () => {
    renderHook(() => useFlowExecutionEvents());
    injectEvent({ eventType: 'run_completed', batchId: 'b1' });
    expect(mockPlaySound).not.toHaveBeenCalled();
    injectEvent({ eventType: 'batch_completed', batchId: 'b1', flowRunId: undefined });
    expect(mockPlaySound).toHaveBeenCalledExactlyOnceWith('batchDone');
  });

  it('run_cancelled stays silent (toast only)', () => {
    renderHook(() => useFlowExecutionEvents());
    injectEvent({ eventType: 'run_cancelled', runStatus: 'cancelled' });
    expect(mockPlaySound).not.toHaveBeenCalled();
    expect(mockToastInfo).toHaveBeenCalledOnce();
  });
});

describe('navigateToFlow', () => {
  beforeEach(() => {
    mockAppStoreSet.mockReset();
  });

  it('calls appStore.set with flowsSelectedFlowIdAtom and the flowId', async () => {
    const { flowsSelectedFlowIdAtom } = await import('../lib/atoms/index');
    navigateToFlow('flow-abc');
    expect(mockAppStoreSet).toHaveBeenCalledWith(flowsSelectedFlowIdAtom, 'flow-abc');
  });

  it('calls appStore.set with activeOverlayAtom and "flows"', async () => {
    const { activeOverlayAtom } = await import('../lib/atoms/index');
    navigateToFlow('flow-abc');
    expect(mockAppStoreSet).toHaveBeenCalledWith(activeOverlayAtom, 'flows');
  });
});
