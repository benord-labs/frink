import { Button, Input } from '@benord-labs/frink-primitives';
import { SettingsCard } from '@/components/settings/SettingsCard';
import { SettingsSection } from '@/components/settings/SettingsSection';
import { Switch } from '@/components/ui/switch';
import { trpc } from '@/lib/trpc';
import { useConcurrencySettings } from '@/lib/flows/admission/use-concurrency-settings';
import {
  MAX_CONCURRENT_RUNS_LIMIT,
  MIN_CONCURRENT_RUNS_LIMIT,
} from '../../../../../shared/lib/flow-admission/constants';

// biome-ignore-start lint/style/useNamingConvention: Flows keep their snake_case IPC contract.
type AdmissionSettings = {
  concurrency_limit_enabled: boolean;
  max_concurrent_runs: number;
  occupied_runs: number;
  queued_runs: number;
  draining: boolean;
};
// biome-ignore-end lint/style/useNamingConvention: Flows keep their snake_case IPC contract.

function formatCapacity(settings: AdmissionSettings): string {
  if (!settings.concurrency_limit_enabled) return `${settings.occupied_runs} active · Unlimited`;
  return `${settings.occupied_runs} / ${settings.max_concurrent_runs}${settings.draining ? ' · draining' : ''}`;
}

function FlowConcurrencyControls({ settings }: { settings: AdmissionSettings }) {
  const {
    enabled,
    maximum,
    hasChanges,
    validationError,
    error,
    mutation,
    canDiscard,
    editDraft,
    save,
    discard,
  } = useConcurrencySettings(settings);

  return (
    <SettingsSection title="Flows">
      <SettingsCard>
        <fieldset>
          <legend className="sr-only">Flow concurrency</legend>
          <div className="flex items-start justify-between gap-4 px-4 py-3">
            <div className="min-w-0 space-y-1">
              <label
                htmlFor="flow-concurrency-enabled"
                className="text-sm font-medium text-foreground"
              >
                Limit parallel Flow runs
              </label>
              <p
                id="flow-concurrency-limit-description"
                className="max-w-prose text-xs leading-relaxed text-muted-foreground"
              >
                Applies to this machine only. Regular chats do not count, and each Flow&apos;s batch
                limit still applies separately. Paused Flows and questions keep their slot until the
                run finishes or is cancelled.
              </p>
            </div>
            <Switch
              id="flow-concurrency-enabled"
              checked={enabled}
              aria-describedby="flow-concurrency-limit-description"
              aria-busy={mutation.isPending}
              aria-disabled={mutation.isPending}
              onCheckedChange={(checked) => editDraft({ enabled: checked })}
              className="shrink-0 data-[state=unchecked]:border-muted-foreground"
            />
          </div>

          <div className="flex items-start justify-between gap-4 border-t border-border/60 px-4 py-3">
            <div className="min-w-0 space-y-1">
              <label
                htmlFor="flow-concurrency-maximum"
                className="text-sm font-medium text-foreground"
              >
                Maximum parallel runs
              </label>
              <p
                id="flow-concurrency-maximum-description"
                className="text-xs text-muted-foreground"
              >
                Choose from {MIN_CONCURRENT_RUNS_LIMIT} to {MAX_CONCURRENT_RUNS_LIMIT}. Disabling
                the limit keeps this value for later.
              </p>
              <p className="text-xs text-muted-foreground" aria-live="polite">
                {formatCapacity(settings)}
                {settings.queued_runs > 0 ? ` · ${settings.queued_runs} queued` : ''}
              </p>
              {error ? (
                <p id="flow-concurrency-error" className="text-xs text-destructive" role="alert">
                  {error}
                </p>
              ) : null}
            </div>
            <Input
              id="flow-concurrency-maximum"
              type="number"
              min={MIN_CONCURRENT_RUNS_LIMIT}
              max={MAX_CONCURRENT_RUNS_LIMIT}
              step={1}
              disabled={mutation.isPending}
              value={maximum}
              aria-invalid={Boolean(validationError)}
              aria-describedby={`flow-concurrency-maximum-description${error ? ' flow-concurrency-error' : ''}`}
              onChange={(event) => editDraft({ maximum: event.target.value })}
              className="w-20 shrink-0 border-muted-foreground"
            />
          </div>
          <div className="flex items-center justify-end gap-2 border-t border-border/60 px-4 py-3">
            <p className="mr-auto text-xs text-muted-foreground" role="status">
              {hasChanges ? 'Unsaved changes' : 'Changes apply when you save.'}
            </p>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={mutation.isPending || !canDiscard}
              onClick={discard}
            >
              Discard
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={mutation.isPending || !hasChanges}
              onClick={save}
            >
              {mutation.isPending ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </fieldset>
      </SettingsCard>
    </SettingsSection>
  );
}

export function FlowConcurrencySettings() {
  const query = trpc.flows.getAdmissionSettings.useQuery(undefined, { refetchInterval: 5_000 });

  if (query.isLoading) {
    return (
      <SettingsSection title="Flows">
        <SettingsCard>
          <p className="px-4 py-3 text-sm text-muted-foreground" role="status">
            Loading Flow limits…
          </p>
        </SettingsCard>
      </SettingsSection>
    );
  }

  if (!query.data) {
    return (
      <SettingsSection title="Flows">
        <SettingsCard>
          <div className="flex items-center justify-between gap-4 px-4 py-3">
            <p className="text-sm text-destructive" role="alert">
              Could not load Flow concurrency settings.
            </p>
            <Button size="sm" variant="secondary" onClick={() => void query.refetch()}>
              Retry
            </Button>
          </div>
        </SettingsCard>
      </SettingsSection>
    );
  }

  return <FlowConcurrencyControls settings={query.data} />;
}
