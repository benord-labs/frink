// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentsDebugTab } from './agents-debug-tab';

const openLogFolder = vi.fn();
const systemInfo = {
  version: '0.0.12',
  platform: 'darwin',
  arch: 'arm64',
  userDataPath: '/Users/sam/Library/Application Support/Frink',
  logFilePath: '/Users/sam/Library/Logs/Frink/main.log',
};

// oxlint-disable-next-line anti-slop/no-module-mocking -- the tRPC client needs Electron's preload; the tab reads system info and opens folders
vi.mock('@/lib/trpc', () => ({
  trpc: {
    debug: {
      getSystemInfo: { useQuery: () => ({ data: systemInfo }) },
      openLogFolder: { useMutation: () => ({ mutate: openLogFolder }) },
      openUserDataFolder: { useMutation: () => ({ mutate: vi.fn() }) },
    },
  },
}));

afterEach(cleanup);

describe('AgentsDebugTab', () => {
  it('names the version and platform in plain words', () => {
    render(<AgentsDebugTab />);
    expect(screen.getByText(/Frink 0\.0\.12 on macOS \(arm64\)/)).toBeInTheDocument();
  });

  it('copies the system details for a bug report', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(navigator.clipboard, 'writeText').mockImplementation(writeText);
    render(<AgentsDebugTab />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy details' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
    expect(JSON.parse(writeText.mock.calls[0][0])).toMatchObject(systemInfo);
  });

  it('opens the log folder from the Logs row', () => {
    render(<AgentsDebugTab />);
    expect(screen.getByText(systemInfo.logFilePath)).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: /^Show in / })[0]);
    expect(openLogFolder).toHaveBeenCalledOnce();
  });
});
