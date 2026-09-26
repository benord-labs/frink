import { memo } from 'react';
import type { PromptData } from '../../../../shared/types/permissions';

type DenyReasonBannerProps = {
  prompt: PromptData;
};

export const DenyReasonBanner = memo(function DenyReasonBanner({ prompt }: DenyReasonBannerProps) {
  if (prompt.reason === 'rule:ask') {
    if (!prompt.matchedRule || !prompt.matchedTier) return null;
    return (
      <p className="text-[10px] text-muted-foreground leading-relaxed">
        Asking because of rule{' '}
        <code className="font-mono text-foreground">{prompt.matchedRule}</code> at{' '}
        <span className="font-medium text-foreground">{prompt.matchedTier}</span> scope.
      </p>
    );
  }
  if (prompt.reason === 'over-50-subcommands') {
    return (
      <p className="text-[10px] text-muted-foreground leading-relaxed">
        Compound command has too many parts — review carefully before approving.
      </p>
    );
  }
  return null;
});
