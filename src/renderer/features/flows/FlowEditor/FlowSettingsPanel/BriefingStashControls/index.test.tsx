// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import type { Mock } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FlowSettings } from '../../../../../../shared/types/flow';

// ---------------------------------------------------------------------------
// Stable mock state (vi.hoisted runs before vi.mock factories and imports)
// ---------------------------------------------------------------------------

const snap = vi.hoisted(() => ({
  createStashMutateAsync: vi.fn(),
  createStashIsPending: false,
  deleteStashMutate: vi.fn(),
  listStashesData: [] as Array<{
    id: string;
    name: string;
    content: string;
    content_preview: string;
    source_flow_id: string | null;
    source_flow_name: string | null;
    created_at: string;
  }>,
  listStashesIsFetching: false,
  invalidateListStashes: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('../../../../../lib/trpc', () => ({
  trpc: {
    flows: {
      createStash: {
        useMutation: () => ({
          mutateAsync: snap.createStashMutateAsync,
          isPending: snap.createStashIsPending,
        }),
      },
      deleteStash: {
        useMutation: () => ({
          mutate: snap.deleteStashMutate,
        }),
      },
      listStashes: {
        useQuery: () => ({
          data: snap.listStashesData,
          isFetching: snap.listStashesIsFetching,
        }),
      },
    },
    useUtils: () => ({
      flows: {
        listStashes: { invalidate: snap.invalidateListStashes },
      },
    }),
  },
}));

vi.mock('sonner', () => ({
  toast: {
    error: (...args: unknown[]) => snap.toastError(...args),
    success: (...args: unknown[]) => snap.toastSuccess(...args),
  },
}));

vi.mock('../../../../../lib/utils/format-time', () => ({
  formatRelativeTime: () => '2 hours ago',
}));

// Transparent Popover mock: content is always rendered so tests focus on
// business logic rather than Radix portal mechanics.
vi.mock('../../../../../components/ui/popover', () => ({
  Popover: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock('../../../../../components/ui/alert-dialog', () => ({
  AlertDialog: ({ children, open }: { children: ReactNode; open?: boolean }) =>
    open ? children : null,
  AlertDialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  AlertDialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  AlertDialogCancel: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
  AlertDialogAction: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
}));

// Dynamic import AFTER mocks are registered.
const { BriefingStashControls } = await import('./index');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const activeSettings: FlowSettings = { briefing: 'Current briefing text' };

function renderControls({
  settings = activeSettings,
  onSettingsChange = vi.fn<(settings: FlowSettings) => void>(),
  onAfterStash = vi.fn<() => void>(),
}: {
  settings?: FlowSettings;
  onSettingsChange?: Mock<(settings: FlowSettings) => void>;
  onAfterStash?: Mock<() => void>;
} = {}) {
  render(
    <BriefingStashControls
      flowId="flow-123"
      flowName="My Test Flow"
      settings={settings}
      onSettingsChange={onSettingsChange}
      onAfterStash={onAfterStash}
    />,
  );
  return { onSettingsChange, onAfterStash };
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

afterEach(() => {
  cleanup();
  snap.createStashMutateAsync.mockReset();
  snap.deleteStashMutate.mockReset();
  snap.invalidateListStashes.mockReset();
  snap.toastError.mockReset();
  snap.toastSuccess.mockReset();
  snap.createStashIsPending = false;
  snap.listStashesData = [];
  snap.listStashesIsFetching = false;
});

beforeEach(() => {
  // Satisfy the stash name input's "Save" button enabled-check by ensuring
  // the popover trigger/content are rendered (transparent mock handles this).
});

// ---------------------------------------------------------------------------
// EC-A: stash success triggers onAfterStash (signals parent to auto-save)
// ---------------------------------------------------------------------------

describe('BriefingStashControls — successful stash (EC-A)', () => {
  it('calls onSettingsChange and onAfterStash after a successful stash', async () => {
    snap.createStashMutateAsync.mockResolvedValue({ id: 'stash-1' });
    const { onSettingsChange, onAfterStash } = renderControls();
    const user = userEvent.setup();

    await user.type(screen.getByRole('textbox'), 'Epic 579');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(onSettingsChange).toHaveBeenCalled();
    });
    expect(onAfterStash).toHaveBeenCalled();
    const [updatedSettings] = onSettingsChange.mock.lastCall as [FlowSettings];
    expect(updatedSettings.briefing).toBeUndefined();
  });

  it('clears the stash name input after a successful stash', async () => {
    snap.createStashMutateAsync.mockResolvedValue({ id: 'stash-1' });
    renderControls();
    const user = userEvent.setup();

    const input = screen.getByRole('textbox');
    await user.type(input, 'Epic 579');
    expect(input).toHaveValue('Epic 579');

    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(input).toHaveValue('');
    });
  });
});

// ---------------------------------------------------------------------------
// EC-B: mutation failure — no clearing, popover stays open for retry
// ---------------------------------------------------------------------------

describe('BriefingStashControls — failed stash (EC-B)', () => {
  it('does not call onSettingsChange or onAfterStash when the mutation fails', async () => {
    snap.createStashMutateAsync.mockRejectedValue(new Error('Server error'));
    const { onSettingsChange, onAfterStash } = renderControls();
    const user = userEvent.setup();

    await user.type(screen.getByRole('textbox'), 'Epic 579');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(snap.toastError).toHaveBeenCalledWith('Server error');
    });
    expect(onSettingsChange).not.toHaveBeenCalled();
    expect(onAfterStash).not.toHaveBeenCalled();
  });

  it('keeps the stash name input visible with its value after a failed stash so the user can retry (EC-B)', async () => {
    snap.createStashMutateAsync.mockRejectedValue(new Error('Server error'));
    renderControls();
    const user = userEvent.setup();

    const input = screen.getByRole('textbox');
    await user.type(input, 'My Stash');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(snap.toastError).toHaveBeenCalled();
    });
    // Name is preserved so user can retry without re-typing
    expect(input).toHaveValue('My Stash');
  });

  it('shows an error toast using the server message when the mutation fails', async () => {
    snap.createStashMutateAsync.mockRejectedValue(new Error('Stash limit reached'));
    renderControls();
    const user = userEvent.setup();

    await user.type(screen.getByRole('textbox'), 'Any Name');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(snap.toastError).toHaveBeenCalledWith('Stash limit reached');
    });
  });

  it('falls back to a generic error toast when the rejection has no message', async () => {
    snap.createStashMutateAsync.mockRejectedValue('non-error');
    renderControls();
    const user = userEvent.setup();

    await user.type(screen.getByRole('textbox'), 'Any Name');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(snap.toastError).toHaveBeenCalledWith('Could not save stash');
    });
  });
});

// ---------------------------------------------------------------------------
// EC-C: loading state in restore dropdown
// ---------------------------------------------------------------------------

describe('BriefingStashControls — restore loading state (EC-C)', () => {
  it('shows a loading indicator (not empty state) while the stash list is fetching', () => {
    snap.listStashesIsFetching = true;
    snap.listStashesData = [];
    renderControls();

    expect(screen.getByText(/loading/i)).toBeTruthy();
    expect(screen.queryByText(/no stashes yet/i)).toBeNull();
  });

  it('shows the empty state message only after fetching completes with no results', () => {
    snap.listStashesIsFetching = false;
    snap.listStashesData = [];
    renderControls();

    expect(screen.getByText(/no stashes yet/i)).toBeTruthy();
    expect(screen.queryByText(/loading/i)).toBeNull();
  });

  it('renders stash items when the list is populated', () => {
    snap.listStashesData = [
      {
        id: 'stash-1',
        name: 'Epic 579 briefing',
        content: 'Full briefing content here',
        content_preview: 'Full briefing...',
        source_flow_id: 'flow-123',
        source_flow_name: 'My Test Flow',
        created_at: new Date().toISOString(),
      },
    ];
    renderControls();

    expect(screen.getByText('Epic 579 briefing')).toBeTruthy();
    expect(screen.getByText('Full briefing...')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Stash button visibility
// ---------------------------------------------------------------------------

describe('BriefingStashControls — stash button visibility', () => {
  it('shows the stash button only when a briefing is active', () => {
    renderControls({ settings: { briefing: 'some content' } });
    expect(screen.getByRole('button', { name: 'Stash briefing' })).toBeTruthy();
  });

  it('hides the stash button when the briefing is empty', () => {
    renderControls({ settings: {} });
    expect(screen.queryByRole('button', { name: 'Stash briefing' })).toBeNull();
  });

  it('hides the stash button when the briefing is whitespace-only', () => {
    renderControls({ settings: { briefing: '   ' } });
    expect(screen.queryByRole('button', { name: 'Stash briefing' })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Restore: apply stash to empty briefing (no confirmation needed)
// ---------------------------------------------------------------------------

describe('BriefingStashControls — restore to empty briefing', () => {
  it('applies the stash immediately when no active briefing is present', async () => {
    const stashContent = 'Restored briefing text';
    snap.listStashesData = [
      {
        id: 'stash-1',
        name: 'My Saved Stash',
        content: stashContent,
        content_preview: 'Restored briefing...',
        source_flow_id: null,
        source_flow_name: null,
        created_at: new Date().toISOString(),
      },
    ];

    const onSettingsChange = vi.fn<(settings: FlowSettings) => void>();
    renderControls({ settings: {}, onSettingsChange });
    const user = userEvent.setup();

    // The button's accessible name includes the timestamp and preview text,
    // so match on the leading stash name portion only.
    await user.click(screen.getByRole('button', { name: /^My Saved Stash/ }));

    expect(onSettingsChange).toHaveBeenCalledWith(
      expect.objectContaining({ briefing: stashContent }),
    );
    expect(snap.toastSuccess).toHaveBeenCalledWith('Restored "My Saved Stash"');
  });
});

// ---------------------------------------------------------------------------
// Delete stash: confirmation dialog → deleteStash.mutate
// ---------------------------------------------------------------------------

describe('BriefingStashControls — delete stash (destructive)', () => {
  it('shows the delete confirmation dialog and calls deleteStash mutate on confirm', async () => {
    snap.listStashesData = [
      {
        id: 'stash-del-1',
        name: 'Epic 579 briefing',
        content: 'full content',
        content_preview: 'full content…',
        source_flow_id: 'flow-123',
        source_flow_name: 'My Test Flow',
        created_at: new Date().toISOString(),
      },
    ];
    renderControls();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Restore a stashed briefing' }));
    await user.click(screen.getByRole('button', { name: 'Delete stash "Epic 579 briefing"' }));

    expect(screen.getByRole('heading', { name: 'Delete stash?' })).toBeTruthy();
    expect(screen.getByText(/will be permanently deleted/i)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect(snap.deleteStashMutate).toHaveBeenCalledWith(
        { id: 'stash-del-1' },
        expect.objectContaining({
          onSuccess: expect.any(Function),
          onError: expect.any(Function),
        }),
      );
    });

    const mutateOpts = snap.deleteStashMutate.mock.calls[0]?.[1] as {
      onSuccess?: () => void;
    };
    mutateOpts.onSuccess?.();
    expect(snap.toastSuccess).toHaveBeenCalledWith('Stash deleted');
  });
});

// ---------------------------------------------------------------------------
// Restore with active briefing: overwrite confirmation → apply
// ---------------------------------------------------------------------------

describe('BriefingStashControls — restore with overwrite (confirmation)', () => {
  it('shows replace confirmation and applies stash via onSettingsChange when Replace is confirmed', async () => {
    const stashContent = 'Stashed briefing from vault';
    snap.listStashesData = [
      {
        id: 'stash-overwrite-1',
        name: 'Vault briefing',
        content: stashContent,
        content_preview: 'Stashed briefing…',
        source_flow_id: null,
        source_flow_name: null,
        created_at: new Date().toISOString(),
      },
    ];

    const onSettingsChange = vi.fn<(settings: FlowSettings) => void>();
    renderControls({ settings: activeSettings, onSettingsChange });
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Restore a stashed briefing' }));
    await user.click(screen.getByRole('button', { name: /^Vault briefing/ }));

    expect(screen.getByRole('heading', { name: 'Replace current briefing?' })).toBeTruthy();
    expect(screen.getByText(/This will replace your current briefing with/i)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Replace' }));

    await waitFor(() => {
      expect(onSettingsChange).toHaveBeenCalledWith(
        expect.objectContaining({ briefing: stashContent }),
      );
    });
    expect(snap.toastSuccess).toHaveBeenCalledWith('Restored "Vault briefing"');
  });
});
