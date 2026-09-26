import { Button, Input } from '@benord-labs/frink-primitives';
import { useId, useState } from 'react';
import type { Provider } from '../../../../../../../shared/integrations/types';
import { trpc } from '@/lib/trpc';

/** One credential-and-scope form for every API-token registrar; vendor differences are catalog data. */
export function ApiTokenSetup({
  integrationId,
  webhookId,
  provider,
}: {
  integrationId: string;
  webhookId: string;
  provider: Provider;
}) {
  const [apiKey, setApiKey] = useState('');
  const [selected, setSelected] = useState('');
  const id = useId();
  const utils = trpc.useUtils();
  const configure = trpc.triggerSetup.configureApiToken.useMutation({
    onSuccess: (result) => {
      if (!result.success) return;
      setApiKey('');
      void utils.integrations.listWebhookEndpoints.invalidate({ integrationId });
      void utils.integrations.list.invalidate();
    },
  });
  const setup = provider.registrar?.tokenSetup;
  if (!setup) return null;
  const options = configure.data?.options ?? [];
  const selection = selected ? [selected] : undefined;
  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        configure.mutate({
          integrationId,
          webhookId,
          ...(apiKey.trim() && { apiKey: apiKey.trim() }),
          ...(selection && { selection }),
        });
      }}
    >
      <p className="text-xs text-muted-fg">
        Frink uses your {provider.display_name} {setup.label} to create and manage this webhook. The
        webhook secret is generated separately and managed for you.
      </p>
      <label className="block space-y-1 text-xs" htmlFor={id}>
        <span>
          {provider.display_name} {setup.label}
        </span>
        <Input
          id={id}
          type="password"
          autoComplete="off"
          value={apiKey}
          onChange={(event) => {
            setApiKey(event.target.value);
            setSelected('');
            configure.reset();
          }}
        />
      </label>
      <p className="text-xs text-muted-fg">
        Leave blank to reuse a credential you already saved.{' '}
        <a
          href={setup.url}
          target="_blank"
          rel="noopener noreferrer"
          className="underline underline-offset-4"
        >
          Find your {provider.display_name} {setup.label}
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
      </p>
      {options.length ? (
        <fieldset className="space-y-2">
          <legend className="text-xs font-medium">
            Choose a {provider.display_name} {setup.resourceLabel}
          </legend>
          {options.map((option) => (
            <label key={option.id} className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name={id + '-resource'}
                checked={selected === option.id}
                onChange={() => setSelected(option.id)}
              />
              {option.label}
            </label>
          ))}
        </fieldset>
      ) : configure.data?.success === false ? (
        <p role="status" className="text-xs text-muted-fg">
          No resources are available for this credential. Check its access and try again.
        </p>
      ) : null}
      {configure.error ? (
        <p role="alert" className="text-xs text-destructive">
          {configure.error.message}
        </p>
      ) : null}
      <Button
        type="submit"
        size="sm"
        loading={configure.isPending}
        disabled={Boolean(options.length && !selected)}
      >
        Set up automatically
      </Button>
    </form>
  );
}
