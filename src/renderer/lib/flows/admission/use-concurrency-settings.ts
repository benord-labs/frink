import { useState } from 'react';
import { trpc } from '@/lib/trpc';
import {
  MAX_CONCURRENT_RUNS_LIMIT,
  MIN_CONCURRENT_RUNS_LIMIT,
} from '../../../../shared/lib/flow-admission/constants';

function parseMaximum(value: string): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) &&
    parsed >= MIN_CONCURRENT_RUNS_LIMIT &&
    parsed <= MAX_CONCURRENT_RUNS_LIMIT
    ? parsed
    : null;
}

type ConcurrencyDraft = { enabled?: boolean; maximum?: string };

export function useConcurrencySettings(settings: {
  concurrency_limit_enabled: boolean;
  max_concurrent_runs: number;
}) {
  const utils = trpc.useUtils();
  const [draft, setDraft] = useState<ConcurrencyDraft>({});
  const [validationError, setValidationError] = useState<string | null>(null);
  const enabled = draft.enabled ?? settings.concurrency_limit_enabled;
  const maximum = draft.maximum ?? String(settings.max_concurrent_runs);
  // Polls cannot acknowledge the user's draft, even when another client saves the same value.
  const hasChanges = Object.keys(draft).length > 0;
  const mutation = trpc.flows.updateAdmissionSettings.useMutation({
    onSuccess: async () => {
      // Refetch cancels older polls and preserves newer settings from other controls or windows.
      await utils.flows.getAdmissionSettings.refetch(undefined, undefined, { throwOnError: true });
      setDraft({});
    },
  });
  const error = validationError ?? mutation.error?.message ?? null;

  const editDraft = (change: typeof draft) => {
    if (mutation.isPending) return;
    const next = { ...draft, ...change };
    if (change.enabled === settings.concurrency_limit_enabled) delete next.enabled;
    if (change.maximum === String(settings.max_concurrent_runs)) delete next.maximum;
    setDraft(next);
    setValidationError(null);
    mutation.reset();
  };

  const save = () => {
    if (mutation.isPending || !hasChanges) return;
    const value = parseMaximum(maximum);
    if (value === null) {
      setValidationError(
        `Enter a whole number from ${MIN_CONCURRENT_RUNS_LIMIT} to ${MAX_CONCURRENT_RUNS_LIMIT}.`,
      );
      return;
    }
    setValidationError(null);
    mutation.mutate({
      ...(draft.enabled === undefined ? {} : { concurrency_limit_enabled: draft.enabled }),
      ...(draft.maximum === undefined ? {} : { max_concurrent_runs: value }),
    });
  };

  const discard = () => {
    setDraft({});
    setValidationError(null);
    mutation.reset();
  };
  return {
    enabled,
    maximum,
    hasChanges,
    validationError,
    error,
    mutation,
    canDiscard: hasChanges || Boolean(error),
    editDraft,
    save,
    discard,
  };
}
