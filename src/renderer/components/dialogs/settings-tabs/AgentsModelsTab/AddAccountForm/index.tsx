import { Button, Input } from '@benord-labs/frink-primitives';
import { Loader2 } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { isClaudeOAuthToken } from '../../../../../../shared/lib/anthropic-token';

type Props = {
  /** Used when the name field is left blank; unique among existing accounts. */
  defaultName: string;
  onAddWithToken: (label: string, token: string) => void;
  onAddWithApiKey: (label: string, apiKey: string) => void;
  onCancel: () => void;
  isPending?: boolean;
};

/** Adds a Claude account from a pasted API key (or a Claude sign-in token). */
export function AddAccountForm({
  defaultName,
  onAddWithToken,
  onAddWithApiKey,
  onCancel,
  isPending,
}: Props) {
  const [name, setName] = useState('');
  const [token, setToken] = useState('');

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const key = token.trim();
    if (!key) return;
    const label = name.trim() || defaultName;
    // Sign-in tokens also start with `sk-`, so they are matched first; anything else unrecognised
    // goes to the backend to validate as a token.
    if (isClaudeOAuthToken(key) || !key.startsWith('sk-')) onAddWithToken(label, key);
    else onAddWithApiKey(label, key);
    // Drop the secret from React state; the mutation holds its own copy.
    setToken('');
  };

  return (
    <form
      onSubmit={submit}
      onKeyDown={(e) => e.key === 'Escape' && !isPending && onCancel()}
      className="space-y-3 border-t border-border/50 px-4 py-4"
    >
      <p className="text-sm text-muted-foreground">
        Paste an API key from your Anthropic console. It stays on this computer.
      </p>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          autoFocus
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="sk-ant-..."
          aria-label="API key"
          size="md"
          className="flex-1"
          disabled={isPending}
        />
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={defaultName}
          aria-label="Account name"
          size="md"
          className="sm:w-48"
          maxLength={100}
          disabled={isPending}
        />
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={isPending}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={isPending || !token.trim()}>
          {isPending ? (
            <>
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              Checking key…
            </>
          ) : (
            'Add account'
          )}
        </Button>
      </div>
      <output className="sr-only" aria-live="polite">
        {isPending ? 'Checking the key…' : ''}
      </output>
    </form>
  );
}
