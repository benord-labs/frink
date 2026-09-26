// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

type MutateOpts = {
  onSuccess?: (data: { stdout: string }) => void;
  onError?: (err: unknown) => void;
  onSettled?: () => void;
};

const { resetMock, mutationCallOpts, mutationInputs, stableMutate } = vi.hoisted(() => {
  const opts: MutateOpts[] = [];
  const inputs: unknown[] = [];
  const reset = vi.fn();
  const mutate = vi.fn((input: unknown, callOpts?: MutateOpts) => {
    inputs.push(input);
    opts.push({
      onSuccess: callOpts?.onSuccess,
      onError: callOpts?.onError,
      onSettled: callOpts?.onSettled,
    });
  });
  return {
    resetMock: reset,
    mutationCallOpts: opts,
    mutationInputs: inputs,
    stableMutate: mutate,
  };
});

vi.mock('../../../../../../lib/trpc', () => ({
  trpc: {
    customNodes: {
      runNodeScript: {
        useMutation: () => ({
          mutate: stableMutate,
          reset: resetMock,
        }),
      },
    },
  },
}));

const { DynamicSelectField } = await import('./index');

function mutationOptsForListOptionsField(
  field: string,
  which: 'first' | 'last',
): MutateOpts | undefined {
  const indices: number[] = [];
  mutationInputs.forEach((inp, i) => {
    const args = (inp as { args?: string[] }).args;
    if (args?.[0] === '--list-options' && args[1] === field) {
      indices.push(i);
    }
  });
  const idx = which === 'first' ? indices[0] : indices[indices.length - 1];
  return idx !== undefined ? mutationCallOpts[idx] : undefined;
}

function completeAllListOptionsMutationsForField(field: string, stdout: string): void {
  mutationInputs.forEach((inp, i) => {
    const args = (inp as { args?: string[] }).args;
    if (args?.[0] !== '--list-options' || args[1] !== field) return;
    const opts = mutationCallOpts[i];
    opts?.onSuccess?.({ stdout });
    opts?.onSettled?.();
  });
}

afterEach(() => {
  cleanup();
  mutationCallOpts.length = 0;
  mutationInputs.length = 0;
  resetMock.mockClear();
  stableMutate.mockClear();
});

describe('DynamicSelectField', () => {
  const baseProps = () => ({
    fieldId: 'f1',
    nodeName: 'my-node',
    fieldName: 'repo',
    label: 'Repository',
    value: '',
    credentialsReady: true,
    onChange: vi.fn(),
  });

  it('shows credential hint and text input when credentialsReady is false', () => {
    render(<DynamicSelectField {...baseProps()} credentialsReady={false} />);

    expect(screen.getByText(/Configure credentials above/i)).toBeInTheDocument();
    expect(screen.getByRole('textbox')).toBeInTheDocument();
    expect(resetMock).toHaveBeenCalled();
  });

  it('calls mutate with --list-options and field name when credentials are ready', () => {
    render(<DynamicSelectField {...baseProps()} fieldName="branch" />);

    expect(mutationCallOpts.length).toBeGreaterThanOrEqual(1);
    expect(mutationOptsForListOptionsField('branch', 'last')).toBeDefined();
    expect(
      mutationInputs.filter((inp) => {
        const args = (inp as { args?: string[] }).args;
        return args?.[0] === '--list-options' && args[1] === 'branch';
      })[0],
    ).toEqual({
      nodeName: 'my-node',
      args: ['--list-options', 'branch'],
    });
    expect(resetMock).not.toHaveBeenCalled();
  });

  it('ignores stale onSuccess when fieldName changes before the slow response returns', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<DynamicSelectField {...baseProps()} fieldName="repo" />);

    const optsRepo = mutationOptsForListOptionsField('repo', 'first');
    expect(optsRepo).toBeDefined();

    rerender(<DynamicSelectField {...baseProps()} fieldName="branch" />);

    expect(mutationOptsForListOptionsField('branch', 'last')).toBeDefined();

    await act(async () => {
      completeAllListOptionsMutationsForField('branch', '[{"name":"Branch","value":"b"}]');
    });

    await waitFor(() => {
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
      expect(screen.getByRole('combobox')).not.toBeDisabled();
    });

    await act(async () => {
      completeAllListOptionsMutationsForField('repo', '[{"name":"Repo","value":"r"}]');
    });

    const trigger = screen.getByRole('combobox');
    expect(trigger).not.toBeDisabled();
    await user.click(trigger);

    expect(await screen.findByText('Branch')).toBeInTheDocument();
    expect(screen.queryByText('Repo')).not.toBeInTheDocument();
  });
});
