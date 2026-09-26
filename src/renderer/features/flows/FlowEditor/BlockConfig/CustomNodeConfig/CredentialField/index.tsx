/**
 * Renders a single credential field for a custom node.
 * All credentials are generic secrets: masked text input + Save button + optional help link.
 */

import { Button, Input } from '@benord-labs/frink-primitives';
import { type ReactElement, useState } from 'react';
import { StatusDot } from '../../../../../../components/ui/status-dot';
import { trpc } from '../../../../../../lib/trpc';
import { FieldRow } from '../../shared';

type CredentialStatus = {
  key: string;
  label: string;
  configured: boolean;
};

type ManifestCredentialMeta = {
  required?: boolean;
  label?: string;
  helpUrl?: string;
};

type Props = {
  nodeName: string;
  credKey: string;
  meta: ManifestCredentialMeta;
  status: CredentialStatus | undefined;
  onSaved: () => void;
};

function isSafeUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export function CredentialField({ nodeName, credKey, meta, status, onSaved }: Props): ReactElement {
  const fieldId = `cred-${nodeName}-${credKey}`;
  const label = meta.label ?? credKey;
  const isConfigured = status?.configured ?? false;

  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const setCredential = trpc.customNodes.setCredential.useMutation({
    onSuccess: () => {
      setValue('');
      setError(null);
      onSaved();
    },
    onError: (err) => setError(err.message),
  });
  const clearCredential = trpc.customNodes.clearCredential.useMutation({
    onSuccess: () => {
      setError(null);
      onSaved();
    },
    onError: (err) => setError(err.message),
  });

  const safeHelpUrl = meta.helpUrl && isSafeUrl(meta.helpUrl) ? meta.helpUrl : null;

  return (
    <FieldRow htmlFor={fieldId} label={label} error={error ?? undefined}>
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <StatusDot
            status={isConfigured ? 'connected' : 'needs_auth'}
            aria-label={isConfigured ? 'Credential configured' : 'Credential not set'}
          />
          <Input
            id={fieldId}
            type="password"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              if (error) setError(null);
            }}
            placeholder={isConfigured ? '••••••••  (saved)' : 'Enter secret…'}
            className="flex-1"
          />
          <Button
            size="sm"
            variant="secondary"
            disabled={value.trim().length === 0 || setCredential.isPending}
            onClick={() =>
              setCredential.mutate({
                nodeName,
                key: credKey,
                value: value.trim(),
              })
            }
          >
            Save
          </Button>
        </div>
        {safeHelpUrl && (
          <p className="text-xs text-muted-foreground">
            Need a key?{' '}
            <a href={safeHelpUrl} target="_blank" rel="noopener noreferrer" className="underline">
              Get one here
              <span className="sr-only"> (opens in new tab)</span>
            </a>
          </p>
        )}
        {isConfigured && (
          <Button
            variant="link"
            disabled={clearCredential.isPending}
            className="h-auto self-start p-0 text-xs font-normal text-muted-foreground underline"
            onClick={() => clearCredential.mutate({ nodeName, key: credKey })}
          >
            Remove saved credential
          </Button>
        )}
      </div>
    </FieldRow>
  );
}
