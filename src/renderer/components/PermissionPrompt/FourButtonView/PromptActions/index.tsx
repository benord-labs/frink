import { Button } from '@benord-labs/frink-primitives';
import { memo, type ReactElement } from 'react';
import type { PromptData } from '../../../../../shared/types/permissions';
import { cn } from '../../../../lib/utils';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../../../ui/tooltip';
import { RuleStringDropdown } from '../../RuleStringDropdown';

type Props = {
  prompt: PromptData;
  rawInput: string;
  selectedRule: string;
  onChange: (value: string) => void;
  hasProject: boolean;
  /** False when no rule can express this command, so the persist options are omitted. */
  canPersistRule: boolean;
  primaryCtaClassName?: string;
  onDeny: () => void;
  onApproveOnce: () => void;
  onApproveProject: () => void;
  onApproveMachine: () => void;
};

/**
 * Action region for Bash / MCP / generic prompts. A vertical list of
 * full-sentence choices (the iOS / Android / Claude-CLI permission pattern,
 * least-confusing per UX research):
 *
 *   - "Allow this time" is the primary, least-permissive default — research
 *     (claude-code#36258) warns that making the *persistent* option the fastest
 *     click causes accidental always-grants.
 *   - The two persist options are grouped under a humanized rule selector
 *     ("cd commands", not `Bash(cd:*)`), so it's clear what gets remembered.
 *   - "Deny" sits last.
 */
export const PromptActions = memo(function PromptActions({
  prompt,
  rawInput,
  selectedRule,
  onChange,
  hasProject,
  canPersistRule,
  primaryCtaClassName,
  onDeny,
  onApproveOnce,
  onApproveProject,
  onApproveMachine,
}: Props): ReactElement {
  return (
    <>
      <Button
        variant="primary"
        size="sm"
        className={cn('h-7 w-full text-xs', primaryCtaClassName)}
        onClick={onApproveOnce}
      >
        Allow this time
      </Button>

      {canPersistRule && (
        <div className="flex flex-col gap-1.5 border-t border-border/60 pt-2">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground shrink-0">Always allow</span>
            <div className="min-w-0 flex-1">
              <RuleStringDropdown
                prompt={prompt}
                rawInput={rawInput}
                value={selectedRule}
                onChange={onChange}
              />
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            {hasProject ? (
              <Button
                variant="secondary"
                size="sm"
                className="h-7 flex-1 text-xs"
                onClick={onApproveProject}
              >
                In this project
              </Button>
            ) : (
              <TooltipProvider delayDuration={200}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    {/* `aria-disabled` (not `disabled`) keeps it focusable so keyboard
                      users reach the tooltip; no onClick → no-op. */}
                    <Button
                      variant="secondary"
                      size="sm"
                      aria-disabled
                      className="h-7 flex-1 text-xs aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
                    >
                      In this project
                    </Button>
                  </TooltipTrigger>
                  {/* z-110: lift above the z-100 permission card (portals to <body>). */}
                  <TooltipContent side="top" className="z-110">
                    No project context — use &quot;On this machine&quot;.
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
            <Button
              variant="secondary"
              size="sm"
              className="h-7 flex-1 text-xs"
              onClick={onApproveMachine}
            >
              On this machine
            </Button>
          </div>
        </div>
      )}

      <div className="flex justify-center">
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-3 text-xs text-muted-foreground"
          onClick={onDeny}
        >
          Deny
        </Button>
      </div>
    </>
  );
});
