import { memo } from 'react';
import type { PromptData } from '../../../../shared/types/permissions';

type DenyReasonBannerProps = {
  prompt: PromptData;
};

export const DenyReasonBanner = memo(function DenyReasonBanner({ prompt }: DenyReasonBannerProps) {
  if (prompt.reason === 'rule:ask') {
    if (!prompt.matchedRule || !prompt.matchedTier) return null;
    const linkedName = prompt.matchedProjectName;
    return (
      <p className="text-[10px] text-muted-foreground leading-relaxed">
        Asking because of rule{' '}
        <code className="font-mono text-foreground">{prompt.matchedRule}</code>{' '}
        {/* A rule saved on a project linked to the chat is named by that project, not its scope. */}
        {prompt.matchedProjectId ? (
          <>
            saved on {linkedName ? 'linked project ' : 'a linked project'}
            {linkedName && <span className="font-medium text-foreground">{linkedName}</span>}.
          </>
        ) : (
          <>
            at <span className="font-medium text-foreground">{prompt.matchedTier}</span> scope.
          </>
        )}
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
  if (prompt.reason === 'redirect-outside-project') {
    return (
      <p className="text-[10px] text-muted-foreground leading-relaxed">
        Frink can't confirm this command's output stays inside this project, so it checks with you
        first.
      </p>
    );
  }
  return null;
});
