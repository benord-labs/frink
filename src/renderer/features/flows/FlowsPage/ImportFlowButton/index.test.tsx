// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast, Toaster } from 'sonner';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_FLOW_FILE_BYTES } from '../../../../../shared/lib/flows/flow-file';
import { ImportFlowButton } from '.';

// `lib/trpc` wires its ipc client at import time, so the preload bridge must exist first.
vi.hoisted(() => {
  Object.assign(globalThis, {
    electronTRPC: { onMessage: () => () => undefined, sendMessage: () => undefined },
  });
});

afterEach(() => {
  cleanup();
  toast.dismiss();
});

type ImportResult = { id: string; name: string; needsSetup: string[] };

function renderButton(importFile: (contents: string) => Promise<ImportResult>) {
  const onImported = vi.fn();
  render(
    <>
      <ImportFlowButton onImported={onImported} importFile={importFile} />
      <Toaster />
    </>,
  );
  return { onImported };
}

async function pick(text: string) {
  const file = new File([text], 'Release.json', { type: 'application/json' });
  await userEvent.setup().upload(screen.getByLabelText('Flow file'), file);
}

describe('ImportFlowButton', () => {
  it('saves the picked file as a flow, opens it and lists what to set up', async () => {
    const importFile = vi.fn(async () => ({ id: 'f1', name: 'Release', needsSetup: ['Build'] }));
    const { onImported } = renderButton(importFile);

    await pick('{"kind":"frink-flow"}');

    expect(await screen.findByText('Imported “Release”')).toBeInTheDocument();
    expect(
      screen.getByText("It's turned off until you turn it on. First finish setting up: Build."),
    ).toBeInTheDocument();
    expect(importFile).toHaveBeenCalledWith('{"kind":"frink-flow"}');
    expect(onImported).toHaveBeenCalledWith('f1');
  });

  it('shows why a file was refused and opens nothing', async () => {
    const importFile = vi.fn(async () => {
      throw new Error("This file isn't a Frink flow.");
    });
    const { onImported } = renderButton(importFile);

    await pick('{}');

    expect(await screen.findByText("This file isn't a Frink flow.")).toBeInTheDocument();
    expect(onImported).not.toHaveBeenCalled();
  });

  it('refuses a file too big to be a flow without sending it', async () => {
    const importFile = vi.fn(async () => ({ id: 'f1', name: 'Huge', needsSetup: [] }));
    renderButton(importFile);

    await pick('x'.repeat(MAX_FLOW_FILE_BYTES + 1));

    expect(await screen.findByText('This file is too big to be a Frink flow.')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Import flow' })).toBeEnabled());
    expect(importFile).not.toHaveBeenCalled();
  });
});
