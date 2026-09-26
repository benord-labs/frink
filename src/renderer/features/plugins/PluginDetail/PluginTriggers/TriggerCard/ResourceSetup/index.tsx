import { Button, Input } from '@benord-labs/frink-primitives';
import { useId, useState } from 'react';
import { Checkbox } from '@/components/ui/checkbox';
import { trpc } from '@/lib/trpc';
import type { Provider } from '../../../../../../../shared/integrations/types';

/** The vendor choices that affect which events start a Flow. */
export function ResourceSetup({
  integrationId,
  webhookId,
  provider,
}: {
  integrationId: string;
  webhookId: string;
  provider?: Provider;
}) {
  const id = useId();
  const [resourceType, setResourceType] = useState('');
  const [resourceName, setResourceName] = useState('');
  const types = provider?.registrar?.resourceTypes;
  const type = resourceType || types?.[0]?.id;
  const [selected, setSelected] = useState<string[]>([]);
  const utils = trpc.useUtils();
  const options = trpc.triggerSetup.options.useQuery(
    { integrationId, webhookId },
    { retry: false },
  );
  const configure = trpc.triggerSetup.configure.useMutation({
    onSuccess: () => utils.integrations.listWebhookEndpoints.invalidate({ integrationId }),
  });
  const refreshButton = (
    <Button
      size="sm"
      variant="ghost"
      disabled={options.isFetching}
      onClick={() => void options.refetch()}
    >
      Refresh
    </Button>
  );
  if (options.error) {
    return (
      <div className="space-y-3">
        <p className="text-xs text-destructive" role="alert">
          {options.error.message}
        </p>
        {types ? null : refreshButton}
      </div>
    );
  }
  const problem = configure.error?.message;
  const selection = types
    ? resourceName.trim()
      ? [type + ':' + resourceName.trim()]
      : []
    : selected;
  return (
    <fieldset className="min-w-0 space-y-3">
      <legend className="text-sm font-medium">{types ? 'What to watch' : 'Choose alerts'}</legend>
      {types ? (
        <div className="grid gap-3 sm:grid-cols-[minmax(10rem,1fr)_3fr]">
          <label className="block space-y-1 text-xs">
            <span>Resource type</span>
            <select
              className="block h-9 w-full rounded-md border border-border bg-background px-2 text-sm focus-visible:outline-2 focus-visible:outline-ring"
              value={type}
              onChange={(event) => setResourceType(event.target.value)}
            >
              {types.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label htmlFor={id + '-name'} className="block space-y-1 text-xs">
            <span>Resource name</span>
            <Input
              id={id + '-name'}
              value={resourceName}
              onChange={(event) => setResourceName(event.target.value)}
              placeholder="User, organization, or owner/repository"
              required
            />
          </label>
        </div>
      ) : null}
      {options.isLoading ? (
        <p className="text-xs text-muted-fg" role="status">
          {types ? 'Checking access…' : 'Loading alerts…'}
        </p>
      ) : null}
      {options.data?.options.map((option) => (
        <label key={option.id} className="flex cursor-pointer items-start gap-2 text-sm">
          <Checkbox
            checked={selected.includes(option.id)}
            onCheckedChange={(checked) =>
              setSelected((current) =>
                checked
                  ? options.data.selection === 'one'
                    ? [option.id]
                    : [...current, option.id]
                  : current.filter((id) => id !== option.id),
              )
            }
          />
          <span>
            {option.label}
            {option.description ? (
              <span className="block text-xs text-muted-fg">{option.description}</span>
            ) : null}
          </span>
        </label>
      ))}
      {problem ? (
        <p className="text-xs text-destructive" role="alert">
          {problem}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button
          size="sm"
          loading={configure.isPending}
          disabled={!selection.length || options.isLoading}
          onClick={() => configure.mutate({ integrationId, webhookId, selection })}
        >
          {types ? 'Set up automatically' : 'Use these alerts'}
        </Button>
        {types ? null : refreshButton}
      </div>
    </fieldset>
  );
}
