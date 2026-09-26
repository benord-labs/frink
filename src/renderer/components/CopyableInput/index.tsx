import { Button, Input } from '@benord-labs/frink-primitives';
import { Check, Copy } from 'lucide-react';
import { useId, useState } from 'react';

type Props = {
  value: string;
  label?: string;
  'aria-label'?: string;
};

export function CopyableInput({ value, label, 'aria-label': ariaLabel }: Props) {
  const inputId = useId();
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback for older browsers
      const textarea = document.createElement('textarea');
      textarea.value = value;
      document.body.appendChild(textarea);
      textarea.select();
      const copied = document.execCommand('copy');
      document.body.removeChild(textarea);
      if (!copied) return;
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className="space-y-1">
      {label && (
        <label htmlFor={inputId} className="block text-xs text-muted-foreground">
          {label}
        </label>
      )}
      <div className="flex gap-2">
        <Input
          id={inputId}
          aria-label={ariaLabel ?? (label ? undefined : 'Value')}
          value={value}
          readOnly
          className="font-mono text-xs"
        />
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="size-9 shrink-0"
          onClick={handleCopy}
          aria-label={`${copied ? 'Copied' : 'Copy'} ${ariaLabel ?? label ?? 'value'}`}
          iconOnly
        >
          {copied ? (
            <Check className="h-4 w-4 text-[hsl(var(--status-online-text))]" />
          ) : (
            <Copy className="h-4 w-4" />
          )}
        </Button>
      </div>
    </div>
  );
}
