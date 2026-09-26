// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Isolate from the React/tRPC/dialog import chain — we exercise dismissal wiring, not those deps.
vi.mock('sonner', () => ({ toast: vi.fn() }));
vi.mock('@/lib/trpc', () => ({
  trpc: {
    projects: { list: { useQuery: () => ({ data: [] }) } },
    skills: { copyAcross: { useMutation: () => ({ mutate: vi.fn() }) } },
  },
}));
vi.mock('@/lib/copy-across-toast', () => ({ showCopyResultToast: vi.fn() }));
vi.mock('@/components/ui/copy-across-dialog', () => ({ CopyAcrossDialog: () => null }));
vi.mock('@/lib/stores/unbridged-dismissals', () => ({
  isDismissed: vi.fn(() => false),
  snooze: vi.fn(),
  snoozeOrEscalate: vi.fn(),
  dismissForever: vi.fn(),
}));

import { toast } from 'sonner';
import {
  dismissForever,
  isDismissed,
  snooze,
  snoozeOrEscalate,
} from '@/lib/stores/unbridged-dismissals';
import { CopyAcrossPrompt, showUnbridgedToast } from './index';

const DATA = {
  projectId: 'p1',
  providerKind: 'cursor' as const,
  skills: [{ name: 'agent-memory', sourcePath: '/x' }],
};
const ARGS = ['p1', 'cursor', ['agent-memory']];

// The toast options object sonner received — every dismissal gesture routes through here.
// biome-ignore lint/suspicious/noExplicitAny: test reaches into sonner's loosely-typed options.
function optionsFor(onCopy: () => void): any {
  showUnbridgedToast(DATA, onCopy);
  return vi.mocked(toast).mock.calls[0][1];
}

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isDismissed).mockReturnValue(false);
});

describe('showUnbridgedToast wiring', () => {
  it('an ignored toast (auto-close) snoozes and never escalates toward permanent', () => {
    optionsFor(vi.fn()).onAutoClose();
    expect(snooze).toHaveBeenCalledWith(...ARGS);
    expect(snoozeOrEscalate).not.toHaveBeenCalled();
  });

  it('an active dismiss (close button / swipe) escalates', () => {
    optionsFor(vi.fn()).onDismiss();
    expect(snoozeOrEscalate).toHaveBeenCalledWith(...ARGS);
    expect(snooze).not.toHaveBeenCalled();
  });

  it('"Don\'t ask again" dismisses the skill permanently', () => {
    optionsFor(vi.fn()).cancel.onClick();
    expect(dismissForever).toHaveBeenCalledWith(...ARGS);
  });

  it('"Copy across" triggers the copy and records no dismissal', () => {
    const onCopy = vi.fn();
    optionsFor(onCopy).action.onClick();
    expect(onCopy).toHaveBeenCalledOnce();
    expect(snooze).not.toHaveBeenCalled();
    expect(snoozeOrEscalate).not.toHaveBeenCalled();
    expect(dismissForever).not.toHaveBeenCalled();
  });
});

describe('CopyAcrossPrompt signal filter', () => {
  // Capture the handler the component registers with the desktop bridge so we can fire signals.
  let fire: (data: typeof DATA) => void;
  beforeEach(() => {
    // biome-ignore lint/suspicious/noExplicitAny: minimal desktop-bridge stub for this test.
    (window as any).desktopApi = {
      onProviderUnbridged: (handler: (data: typeof DATA) => void) => {
        fire = handler;
        return () => {};
      },
    };
    render(<CopyAcrossPrompt />);
  });

  it('toasts when an un-bridged skill is still live', () => {
    fire(DATA);
    expect(toast).toHaveBeenCalledOnce();
  });

  it('stays silent when every un-bridged skill is already dismissed (the no-relaunch-nag fix)', () => {
    vi.mocked(isDismissed).mockReturnValue(true);
    fire(DATA);
    expect(toast).not.toHaveBeenCalled();
  });

  it('toasts only the live skills, dropping dismissed ones from a mixed batch', () => {
    vi.mocked(isDismissed).mockImplementation((_p, _t, skill) => skill === 'declined');
    fire({
      ...DATA,
      skills: [
        { name: 'live', sourcePath: '/a' },
        { name: 'declined', sourcePath: '/b' },
      ],
    });
    expect(toast).toHaveBeenCalledOnce();
    const message = vi.mocked(toast).mock.calls[0][0];
    expect(message).toContain('live');
    expect(message).not.toContain('declined');
  });
});
