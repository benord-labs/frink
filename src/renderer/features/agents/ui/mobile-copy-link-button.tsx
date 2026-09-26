import { Button } from '@benord-labs/frink-primitives';
import { useState } from 'react';
import { Check, LinkIcon } from 'lucide-react';
import { cn } from '../../../lib/utils';
import { useHaptic } from '../hooks/use-haptic';

type MobileCopyLinkButtonProps = {
  url: string;
};

export function MobileCopyLinkButton({ url }: MobileCopyLinkButtonProps) {
  const [copied, setCopied] = useState(false);
  const { trigger: triggerHaptic } = useHaptic();

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      triggerHaptic('medium');
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (_error) {}
  };

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={handleCopy}
      className="h-7 w-7 p-0 transition-[background-color,transform] duration-150 ease-out active:scale-[0.97] shrink-0 rounded-md"
      iconOnly
    >
      <div className="relative w-3.5 h-3.5">
        <LinkIcon
          className={cn(
            'absolute inset-0 w-3.5 h-3.5 transition-[opacity,transform] duration-200 ease-out',
            copied ? 'opacity-0 scale-50' : 'opacity-100 scale-100',
          )}
        />
        <Check
          className={cn(
            'absolute inset-0 w-3.5 h-3.5 transition-[opacity,transform] duration-200 ease-out',
            copied ? 'opacity-100 scale-100' : 'opacity-0 scale-50',
          )}
        />
      </div>
      <span className="sr-only">{copied ? 'Copied!' : 'Copy link'}</span>
    </Button>
  );
}
