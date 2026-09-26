import { Button, Input } from '@benord-labs/frink-primitives';
import { Loader2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { trpc } from '../../../../../../lib/trpc';

type Props = {
  accountId: string;
  onSave: () => void;
  onCancel: () => void;
};

export function ApiKeyEditForm({ accountId, onSave, onCancel }: Props) {
  const [key, setKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const updateMutation = trpc.claudeCode.updateAccountToken.useMutation({
    onSuccess: () => {
      toast.success('API key updated');
      onSave();
    },
    onError: (err) => toast.error(`Failed to update key: ${err.message}`),
  });

  const handleSave = () => {
    const trimmed = key.trim();
    if (!trimmed) {
      setError('Please enter an API key');
      return;
    }

    // Backend validates the token against the actual provider API
    setError(null);
    updateMutation.mutate({ id: accountId, token: trimmed });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onCancel();
    } else if (e.key === 'Enter' && !updateMutation.isPending) {
      handleSave();
    }
  };

  return (
    <div className="px-4 pb-4 pt-0 space-y-1">
      <div className="flex items-center gap-2">
        <Input
          ref={inputRef}
          type="password"
          value={key}
          onChange={(e) => {
            setKey(e.target.value);
            if (error) setError(null);
          }}
          onKeyDown={handleKeyDown}
          aria-label="Anthropic API key"
          aria-invalid={!!error}
          aria-describedby={error ? 'api-key-error' : undefined}
          placeholder="Paste API key (sk-ant-...)"
          size="sm"
          className="flex-1"
          disabled={updateMutation.isPending}
        />
        <Button
          size="sm"
          className="h-8"
          onClick={handleSave}
          disabled={updateMutation.isPending || !key.trim()}
        >
          {updateMutation.isPending ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" aria-hidden="true" />
              Verifying…
            </>
          ) : (
            'Save'
          )}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-8"
          onClick={onCancel}
          disabled={updateMutation.isPending}
        >
          Cancel
        </Button>
      </div>
      <output className="sr-only" aria-live="polite">
        {updateMutation.isPending ? 'Verifying account credentials…' : ''}
      </output>
      {error && (
        <p id="api-key-error" className="text-xs text-destructive pl-0.5" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
